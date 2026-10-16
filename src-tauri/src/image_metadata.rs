use crate::image_resource_policy::{self, OperationClass};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
    pub date_time: Option<String>,
    pub f_number: Option<f64>,
    pub exposure_time: Option<String>,
    pub iso: Option<u32>,
    pub focal_length: Option<String>,
    pub raw: HashMap<String, String>,
}

const MAX_XMP_SIDECAR_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EMBEDDED_METADATA_READ_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TIFF_IFD_ENTRIES: usize = 4_096;
const MAX_TIFF_IFDS: usize = 8;

fn policy_error(error: image_resource_policy::ResourcePolicyError) -> String {
    image_resource_policy::record_rejection(OperationClass::MetadataOnly);
    error.to_string()
}

fn read_bounded_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    let file =
        fs::File::open(path).map_err(|error| format!("Failed to read XMP sidecar: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read XMP sidecar: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        image_resource_policy::record_rejection(OperationClass::MetadataOnly);
        return Err("XMP sidecar is too large to read safely".to_string());
    }
    String::from_utf8(bytes).map_err(|error| format!("XMP sidecar is not valid UTF-8: {error}"))
}

fn read_bounded_prefix(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| format!("Failed to open image: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max_bytes)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read bounded embedded metadata: {error}"))?;
    Ok(bytes)
}

#[derive(Clone, Copy)]
enum TiffEndian {
    Little,
    Big,
}

impl TiffEndian {
    fn u16(self, bytes: &[u8]) -> u16 {
        let value = [bytes[0], bytes[1]];
        match self {
            Self::Little => u16::from_le_bytes(value),
            Self::Big => u16::from_be_bytes(value),
        }
    }

    fn u32(self, bytes: &[u8]) -> u32 {
        let value = [bytes[0], bytes[1], bytes[2], bytes[3]];
        match self {
            Self::Little => u32::from_le_bytes(value),
            Self::Big => u32::from_be_bytes(value),
        }
    }

    fn put_u32(self, target: &mut [u8], value: u32) {
        let bytes = match self {
            Self::Little => value.to_le_bytes(),
            Self::Big => value.to_be_bytes(),
        };
        target.copy_from_slice(&bytes);
    }
}

#[derive(Debug)]
enum TiffCompactError {
    Io(std::io::Error),
    Invalid(&'static str),
    Budget,
    Offset,
}

impl std::fmt::Display for TiffCompactError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Invalid(message) => formatter.write_str(message),
            Self::Budget => formatter.write_str("embedded metadata exceeds the safe read budget"),
            Self::Offset => formatter.write_str("embedded metadata contains an invalid offset"),
        }
    }
}

struct BoundedTiffSource {
    file: fs::File,
    file_len: u64,
    bytes_read: u64,
}

impl BoundedTiffSource {
    fn open(path: &Path) -> Result<Self, TiffCompactError> {
        let file = fs::File::open(path).map_err(TiffCompactError::Io)?;
        let file_len = file.metadata().map_err(TiffCompactError::Io)?.len();
        image_resource_policy::validate_input_bytes(
            file_len,
            &image_resource_policy::PolicyLimits::for_operation(OperationClass::MetadataOnly),
        )
        .map_err(|_| TiffCompactError::Budget)?;
        Ok(Self { file, file_len, bytes_read: 0 })
    }

    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, TiffCompactError> {
        let length_u64 = u64::try_from(length).map_err(|_| TiffCompactError::Offset)?;
        let end = offset.checked_add(length_u64).ok_or(TiffCompactError::Offset)?;
        if end > self.file_len {
            return Err(TiffCompactError::Offset);
        }
        let next_budget =
            self.bytes_read.checked_add(length_u64).ok_or(TiffCompactError::Budget)?;
        if next_budget > MAX_EMBEDDED_METADATA_READ_BYTES {
            return Err(TiffCompactError::Budget);
        }
        self.file.seek(SeekFrom::Start(offset)).map_err(TiffCompactError::Io)?;
        let mut bytes = vec![0; length];
        self.file.read_exact(&mut bytes).map_err(TiffCompactError::Io)?;
        self.bytes_read = next_budget;
        Ok(bytes)
    }

    fn file_len(&self) -> u64 {
        self.file_len
    }

    fn check_range(&self, offset: u64, length: u64) -> Result<(), TiffCompactError> {
        let end = offset.checked_add(length).ok_or(TiffCompactError::Offset)?;
        if end > self.file_len {
            return Err(TiffCompactError::Offset);
        }
        Ok(())
    }
}

struct TiffCompactor {
    source: BoundedTiffSource,
    endian: TiffEndian,
    output: Vec<u8>,
    ifd_offsets: HashMap<u32, u32>,
    active_ifds: std::collections::HashSet<u32>,
    ifd_count: usize,
}

impl TiffCompactor {
    fn new(path: &Path) -> Result<Self, TiffCompactError> {
        let mut source = BoundedTiffSource::open(path)?;
        let header = source.read_at(0, 8)?;
        let endian = match &header[..2] {
            b"II" => TiffEndian::Little,
            b"MM" => TiffEndian::Big,
            _ => return Err(TiffCompactError::Invalid("invalid TIFF byte order")),
        };
        if endian.u16(&header[2..4]) != 42 {
            return Err(TiffCompactError::Invalid("unsupported TIFF header"));
        }
        let first_ifd = endian.u32(&header[4..8]);
        let mut output = header;
        output[4..8].copy_from_slice(&[0; 4]);
        let mut compactor = Self {
            source,
            endian,
            output,
            ifd_offsets: HashMap::new(),
            active_ifds: std::collections::HashSet::new(),
            ifd_count: 0,
        };
        let compact_ifd = compactor.append_ifd(first_ifd)?;
        let endian = compactor.endian;
        endian.put_u32(&mut compactor.output[4..8], compact_ifd);
        Ok(compactor)
    }

    fn append_ifd(&mut self, original_offset: u32) -> Result<u32, TiffCompactError> {
        if original_offset == 0 {
            return Ok(0);
        }
        if self.active_ifds.contains(&original_offset) {
            return Err(TiffCompactError::Invalid("cyclic TIFF IFD pointer"));
        }
        if let Some(&offset) = self.ifd_offsets.get(&original_offset) {
            return Ok(offset);
        }
        if self.ifd_count >= MAX_TIFF_IFDS {
            return Err(TiffCompactError::Budget);
        }

        let count_bytes = self.source.read_at(u64::from(original_offset), 2)?;
        let count = usize::from(self.endian.u16(&count_bytes));
        if count > MAX_TIFF_IFD_ENTRIES {
            return Err(TiffCompactError::Budget);
        }
        let entries_bytes = count.checked_mul(12).ok_or(TiffCompactError::Budget)?;
        let block_length = 2usize
            .checked_add(entries_bytes)
            .and_then(|length| length.checked_add(4))
            .ok_or(TiffCompactError::Budget)?;
        let original_block = self.source.read_at(u64::from(original_offset), block_length)?;
        let compact_offset =
            u32::try_from(self.output.len()).map_err(|_| TiffCompactError::Budget)?;
        if self.output.len().checked_add(block_length).ok_or(TiffCompactError::Budget)?
            > usize::try_from(MAX_EMBEDDED_METADATA_READ_BYTES).unwrap()
        {
            return Err(TiffCompactError::Budget);
        }
        self.output.extend_from_slice(&original_block);
        self.ifd_offsets.insert(original_offset, compact_offset);
        self.active_ifds.insert(original_offset);
        self.ifd_count += 1;

        for index in 0..count {
            let entry_offset = 2 + index * 12;
            let tag = self.endian.u16(&original_block[entry_offset..entry_offset + 2]);
            let typ = self.endian.u16(&original_block[entry_offset + 2..entry_offset + 4]);
            let count = self.endian.u32(&original_block[entry_offset + 4..entry_offset + 8]);
            let unit_size =
                tiff_type_size(typ).ok_or(TiffCompactError::Invalid("unsupported TIFF type"))?;
            let value_length =
                unit_size.checked_mul(u64::from(count)).ok_or(TiffCompactError::Budget)?;
            let output_entry = usize::try_from(compact_offset)
                .ok()
                .and_then(|offset| offset.checked_add(entry_offset))
                .ok_or(TiffCompactError::Budget)?;
            if value_length <= 4 {
                if is_tiff_ifd_pointer(tag, typ, count) {
                    let child =
                        self.endian.u32(&original_block[entry_offset + 8..entry_offset + 12]);
                    let compact_child = self.append_ifd(child)?;
                    self.endian.put_u32(
                        &mut self.output[output_entry + 8..output_entry + 12],
                        compact_child,
                    );
                }
                continue;
            }

            let original_value_offset =
                self.endian.u32(&original_block[entry_offset + 8..entry_offset + 12]);
            let value = self.source.read_at(
                u64::from(original_value_offset),
                usize::try_from(value_length).map_err(|_| TiffCompactError::Budget)?,
            )?;
            if self.output.len().checked_add(value.len()).ok_or(TiffCompactError::Budget)?
                > usize::try_from(MAX_EMBEDDED_METADATA_READ_BYTES).unwrap()
            {
                return Err(TiffCompactError::Budget);
            }
            let compact_value_offset =
                u32::try_from(self.output.len()).map_err(|_| TiffCompactError::Budget)?;
            self.output.extend_from_slice(&value);
            self.endian.put_u32(
                &mut self.output[output_entry + 8..output_entry + 12],
                compact_value_offset,
            );
        }

        let next_offset_position = usize::try_from(compact_offset)
            .ok()
            .and_then(|offset| offset.checked_add(2 + entries_bytes))
            .ok_or(TiffCompactError::Budget)?;
        let next_original = self.endian.u32(&original_block[2 + entries_bytes..block_length]);
        let next_compact = self.append_ifd(next_original)?;
        self.endian.put_u32(
            &mut self.output[next_offset_position..next_offset_position + 4],
            next_compact,
        );
        self.active_ifds.remove(&original_offset);
        Ok(compact_offset)
    }
}

fn tiff_type_size(typ: u16) -> Option<u64> {
    match typ {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 | 13 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

fn is_tiff_ifd_pointer(tag: u16, typ: u16, count: u32) -> bool {
    typ == 4 && count == 1 && matches!(tag, 0x8769 | 0x8825 | 0xa005)
}

fn compact_tiff(path: &Path) -> Result<Vec<u8>, String> {
    TiffCompactor::new(path).map(|compactor| compactor.output).map_err(|error| {
        if matches!(error, TiffCompactError::Budget) {
            image_resource_policy::record_rejection(OperationClass::MetadataOnly);
        }
        format!("Bounded TIFF metadata read failed: {error}")
    })
}

fn be_u16(bytes: &[u8]) -> u16 {
    u16::from_be_bytes([bytes[0], bytes[1]])
}

fn be_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn le_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn append_bounded(
    source: &mut BoundedTiffSource,
    output: &mut Vec<u8>,
    offset: u64,
    length: u64,
) -> Result<(), TiffCompactError> {
    source.check_range(offset, length)?;
    let length = usize::try_from(length).map_err(|_| TiffCompactError::Budget)?;
    let next_len = output.len().checked_add(length).ok_or(TiffCompactError::Budget)?;
    if next_len > usize::try_from(MAX_EMBEDDED_METADATA_READ_BYTES).unwrap() {
        return Err(TiffCompactError::Budget);
    }
    output.extend_from_slice(&source.read_at(offset, length)?);
    Ok(())
}

fn scan_jpeg_exif(path: &Path) -> Result<Option<Vec<u8>>, TiffCompactError> {
    let mut source = BoundedTiffSource::open(path)?;
    if source.read_at(0, 2)?.as_slice() != b"\xff\xd8" {
        return Ok(None);
    }
    let mut position = 2_u64;
    while position < source.file_len() {
        let marker_start = position;
        let mut prefix = source.read_at(position, 2)?;
        if prefix[0] != 0xff {
            return Err(TiffCompactError::Invalid("malformed JPEG marker"));
        }
        while prefix[1] == 0xff {
            position = position.checked_add(1).ok_or(TiffCompactError::Offset)?;
            prefix = source.read_at(position, 2)?;
        }
        let marker = prefix[1];
        position = position.checked_add(2).ok_or(TiffCompactError::Offset)?;
        if marker == 0xda || marker == 0xd9 {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length_bytes = source.read_at(position, 2)?;
        let segment_length = u64::from(be_u16(&length_bytes));
        if segment_length < 2 {
            return Err(TiffCompactError::Invalid("malformed JPEG segment"));
        }
        let payload_offset = position.checked_add(2).ok_or(TiffCompactError::Offset)?;
        let payload_length = segment_length - 2;
        source.check_range(payload_offset, payload_length)?;
        if marker == 0xe1 && payload_length >= 6 {
            let signature = source.read_at(payload_offset, 6)?;
            if signature.as_slice() == b"Exif\0\0" {
                let mut exif = Vec::new();
                append_bounded(
                    &mut source,
                    &mut exif,
                    payload_offset.checked_add(6).ok_or(TiffCompactError::Offset)?,
                    payload_length - 6,
                )?;
                return Ok(Some(exif));
            }
        }
        position = payload_offset.checked_add(payload_length).ok_or(TiffCompactError::Offset)?;
        if position <= marker_start {
            return Err(TiffCompactError::Invalid("malformed JPEG segment range"));
        }
    }
    Ok(None)
}

fn scan_png_exif(path: &Path) -> Result<Option<Vec<u8>>, TiffCompactError> {
    let mut source = BoundedTiffSource::open(path)?;
    if source.read_at(0, 8)?.as_slice() != b"\x89PNG\r\n\x1a\n" {
        return Ok(None);
    }
    let mut position = 8_u64;
    while position < source.file_len() {
        let chunk_header = source.read_at(position, 8)?;
        let length = u64::from(be_u32(&chunk_header[..4]));
        let chunk_type = &chunk_header[4..8];
        let data_offset = position.checked_add(8).ok_or(TiffCompactError::Offset)?;
        let chunk_end = data_offset
            .checked_add(length)
            .and_then(|value| value.checked_add(4))
            .ok_or(TiffCompactError::Offset)?;
        source.check_range(data_offset, length.checked_add(4).ok_or(TiffCompactError::Offset)?)?;
        if chunk_type == b"eXIf" {
            let mut exif = Vec::new();
            append_bounded(&mut source, &mut exif, data_offset, length)?;
            return Ok(Some(exif));
        }
        position = chunk_end;
        if chunk_type == b"IEND" {
            break;
        }
    }
    Ok(None)
}

fn scan_webp_exif(path: &Path) -> Result<Option<Vec<u8>>, TiffCompactError> {
    let mut source = BoundedTiffSource::open(path)?;
    let header = source.read_at(0, 12)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Ok(None);
    }
    let riff_size = u64::from(le_u32(&header[4..8]));
    let riff_end = 8_u64.checked_add(riff_size).ok_or(TiffCompactError::Offset)?;
    if riff_end > source.file_len() {
        return Err(TiffCompactError::Offset);
    }
    let mut position = 12_u64;
    while position < riff_end {
        let chunk_header = source.read_at(position, 8)?;
        let length = u64::from(le_u32(&chunk_header[4..8]));
        let data_offset = position.checked_add(8).ok_or(TiffCompactError::Offset)?;
        let data_end = data_offset.checked_add(length).ok_or(TiffCompactError::Offset)?;
        let padded_end = data_end.checked_add(length & 1).ok_or(TiffCompactError::Offset)?;
        if padded_end > riff_end {
            return Err(TiffCompactError::Offset);
        }
        if &chunk_header[..4] == b"EXIF" {
            let mut exif = Vec::new();
            append_bounded(&mut source, &mut exif, data_offset, length)?;
            return Ok(Some(exif));
        }
        position = padded_end;
    }
    Ok(None)
}

#[derive(Clone, Copy)]
struct IsoBox {
    body_offset: u64,
    body_length: u64,
    kind: [u8; 4],
}

fn read_iso_box_header(
    source: &mut BoundedTiffSource,
    offset: u64,
    limit: u64,
) -> Result<Option<(IsoBox, u64)>, TiffCompactError> {
    if offset >= limit {
        return Ok(None);
    }
    if limit - offset < 8 {
        return Err(TiffCompactError::Invalid("truncated ISO box header"));
    }
    let header = source.read_at(offset, 8)?;
    let short_size = be_u32(&header[..4]);
    let mut header_size = 8_u64;
    let size = match short_size {
        0 => limit.checked_sub(offset).ok_or(TiffCompactError::Offset)?,
        1 => {
            let large = source.read_at(offset + 8, 8)?;
            header_size = 16;
            u64::from_be_bytes(large.try_into().map_err(|_| TiffCompactError::Offset)?)
        }
        value => u64::from(value),
    };
    if size < header_size {
        return Err(TiffCompactError::Invalid("invalid ISO box size"));
    }
    let end = offset.checked_add(size).ok_or(TiffCompactError::Offset)?;
    if end > limit {
        return Err(TiffCompactError::Offset);
    }
    Ok(Some((
        IsoBox {
            body_offset: offset + header_size,
            body_length: size - header_size,
            kind: header[4..8].try_into().unwrap(),
        },
        end,
    )))
}

fn iso_uint(bytes: &[u8], position: &mut usize, width: usize) -> Result<u64, TiffCompactError> {
    if width == 0 {
        return Ok(0);
    }
    let end = position.checked_add(width).ok_or(TiffCompactError::Budget)?;
    let value = bytes.get(*position..end).ok_or(TiffCompactError::Offset)?;
    *position = end;
    match width {
        1 => Ok(u64::from(value[0])),
        2 => Ok(u64::from(be_u16(value))),
        4 => Ok(u64::from(be_u32(value))),
        8 => Ok(u64::from_be_bytes(value.try_into().map_err(|_| TiffCompactError::Offset)?)),
        _ => Err(TiffCompactError::Invalid("unsupported ISO integer width")),
    }
}

#[derive(Clone)]
struct IsoExtent {
    offset: u64,
    length: u64,
}

#[derive(Clone)]
struct IsoLocation {
    construction_method: u8,
    base_offset: u64,
    extents: Vec<IsoExtent>,
}

fn parse_heif_iinf(bytes: &[u8]) -> Result<Option<u32>, TiffCompactError> {
    if bytes.len() < 6 {
        return Err(TiffCompactError::Invalid("truncated HEIF item info"));
    }
    let version = bytes[0];
    let mut position = 4usize;
    let item_count = if version == 0 {
        let value = usize::from(be_u16(&bytes[position..position + 2]));
        position += 2;
        value
    } else {
        if bytes.len() < 8 {
            return Err(TiffCompactError::Invalid("truncated HEIF item info"));
        }
        let value = usize::try_from(be_u32(&bytes[position..position + 4]))
            .map_err(|_| TiffCompactError::Budget)?;
        position += 4;
        value
    };
    for _ in 0..item_count {
        if position + 8 > bytes.len() {
            return Err(TiffCompactError::Offset);
        }
        let size = usize::try_from(be_u32(&bytes[position..position + 4]))
            .map_err(|_| TiffCompactError::Budget)?;
        if size < 8 || position.checked_add(size).ok_or(TiffCompactError::Budget)? > bytes.len() {
            return Err(TiffCompactError::Offset);
        }
        if &bytes[position + 4..position + 8] == b"infe" {
            let body = &bytes[position + 8..position + size];
            if body.len() >= 12 && body[0] == 2 && &body[8..12] == b"Exif" {
                return Ok(Some(u32::from(be_u16(&body[4..6]))));
            }
            if body.len() >= 14 && body[0] == 3 && &body[10..14] == b"Exif" {
                return Ok(Some(be_u32(&body[4..8])));
            }
        }
        position += size;
    }
    Ok(None)
}

fn parse_heif_iloc(bytes: &[u8], wanted_id: u32) -> Result<Option<IsoLocation>, TiffCompactError> {
    if bytes.len() < 8 {
        return Err(TiffCompactError::Invalid("truncated HEIF item locations"));
    }
    let version = bytes[0];
    let mut position = 4usize;
    if bytes.len() < 6 {
        return Err(TiffCompactError::Invalid("truncated HEIF item locations"));
    }
    let tmp = be_u16(&bytes[position..position + 2]);
    position += 2;
    let offset_size = usize::from(tmp >> 12);
    let length_size = usize::from((tmp >> 8) & 0xf);
    let base_offset_size = usize::from((tmp >> 4) & 0xf);
    let index_size = if version == 1 || version == 2 { usize::from(tmp & 0xf) } else { 0 };
    let item_count = match version {
        0 | 1 => {
            usize::from(be_u16(bytes.get(position..position + 2).ok_or(TiffCompactError::Offset)?))
        }
        2 => usize::try_from(be_u32(
            bytes.get(position..position + 4).ok_or(TiffCompactError::Offset)?,
        ))
        .map_err(|_| TiffCompactError::Budget)?,
        _ => return Err(TiffCompactError::Invalid("unsupported HEIF item location version")),
    };
    position += if version == 2 { 4 } else { 2 };
    if item_count > MAX_TIFF_IFD_ENTRIES {
        return Err(TiffCompactError::Budget);
    }
    let mut total_extents = 0usize;
    for _ in 0..item_count {
        let item_id = if version == 2 {
            iso_uint(bytes, &mut position, 4)?
        } else {
            iso_uint(bytes, &mut position, 2)?
        };
        let construction_method = if version == 0 {
            0
        } else {
            let value = iso_uint(bytes, &mut position, 2)?;
            u8::try_from(value & 0xf).map_err(|_| TiffCompactError::Offset)?
        };
        if iso_uint(bytes, &mut position, 2)? != 0 {
            return Err(TiffCompactError::Invalid("external HEIF metadata reference"));
        }
        let base_offset = iso_uint(bytes, &mut position, base_offset_size)?;
        let extent_count = usize::try_from(iso_uint(bytes, &mut position, 2)?)
            .map_err(|_| TiffCompactError::Budget)?;
        total_extents = total_extents.checked_add(extent_count).ok_or(TiffCompactError::Budget)?;
        if total_extents > MAX_TIFF_IFD_ENTRIES {
            return Err(TiffCompactError::Budget);
        }
        let mut extents = Vec::with_capacity(extent_count.min(32));
        for _ in 0..extent_count {
            let _extent_index = iso_uint(bytes, &mut position, index_size)?;
            let offset = iso_uint(bytes, &mut position, offset_size)?;
            let length = iso_uint(bytes, &mut position, length_size)?;
            extents.push(IsoExtent { offset, length });
        }
        if item_id == u64::from(wanted_id) {
            return Ok(Some(IsoLocation { construction_method, base_offset, extents }));
        }
    }
    Ok(None)
}

fn scan_heif_exif(path: &Path) -> Result<Option<Vec<u8>>, TiffCompactError> {
    let mut source = BoundedTiffSource::open(path)?;
    let file_len = source.file_len();
    let mut position = 0_u64;
    let mut ftyp_ok = false;
    while let Some((box_info, next)) = read_iso_box_header(&mut source, position, file_len)? {
        if &box_info.kind == b"ftyp" {
            let length =
                usize::try_from(box_info.body_length).map_err(|_| TiffCompactError::Budget)?;
            if length > 64 * 1024 {
                return Err(TiffCompactError::Budget);
            }
            let body = source.read_at(box_info.body_offset, length)?;
            if body.len() >= 8
                && (&body[..4] == b"mif1"
                    || &body[..4] == b"msf1"
                    || body[8..]
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .any(|chunk| chunk == b"mif1" || chunk == b"msf1"))
            {
                ftyp_ok = true;
            }
        } else if &box_info.kind == b"meta" {
            if !ftyp_ok || box_info.body_length < 4 {
                return Err(TiffCompactError::Invalid("invalid HEIF metadata box"));
            }
            let children_start =
                box_info.body_offset.checked_add(4).ok_or(TiffCompactError::Offset)?;
            let children_end = box_info
                .body_offset
                .checked_add(box_info.body_length)
                .ok_or(TiffCompactError::Offset)?;
            let mut child = children_start;
            let mut item_id = None;
            let mut location = None;
            let mut idat = None;
            let mut iloc_bytes = None;
            while let Some((child_info, child_next)) =
                read_iso_box_header(&mut source, child, children_end)?
            {
                let length = usize::try_from(child_info.body_length)
                    .map_err(|_| TiffCompactError::Budget)?;
                if &child_info.kind == b"iinf" {
                    if length > usize::try_from(MAX_EMBEDDED_METADATA_READ_BYTES).unwrap() {
                        return Err(TiffCompactError::Budget);
                    }
                    item_id = parse_heif_iinf(&source.read_at(child_info.body_offset, length)?)?;
                } else if &child_info.kind == b"iloc" {
                    if length > usize::try_from(MAX_EMBEDDED_METADATA_READ_BYTES).unwrap() {
                        return Err(TiffCompactError::Budget);
                    }
                    iloc_bytes = Some(source.read_at(child_info.body_offset, length)?);
                } else if &child_info.kind == b"idat" {
                    idat = Some(child_info);
                }
                child = child_next;
            }
            if let (Some(id), Some(iloc)) = (item_id, iloc_bytes.as_deref()) {
                location = parse_heif_iloc(iloc, id)?;
            }
            let Some(location) = location else { return Ok(None) };
            let mut exif = Vec::new();
            for extent in location.extents {
                let (base, max_len) = if location.construction_method == 1 {
                    let idat = idat.ok_or(TiffCompactError::Invalid("missing HEIF item data"))?;
                    (idat.body_offset, idat.body_length)
                } else if location.construction_method == 0 {
                    (0, source.file_len())
                } else {
                    return Err(TiffCompactError::Invalid("unsupported HEIF construction method"));
                };
                let relative = location
                    .base_offset
                    .checked_add(extent.offset)
                    .ok_or(TiffCompactError::Offset)?;
                if relative > max_len || extent.length > max_len - relative {
                    return Err(TiffCompactError::Offset);
                }
                let offset = base.checked_add(relative).ok_or(TiffCompactError::Offset)?;
                append_bounded(&mut source, &mut exif, offset, extent.length)?;
            }
            if exif.len() < 4 {
                return Err(TiffCompactError::Invalid("HEIF ExifDataBlock too small"));
            }
            let offset =
                usize::try_from(be_u32(&exif[..4])).map_err(|_| TiffCompactError::Offset)?;
            if offset > exif.len() - 4 {
                return Err(TiffCompactError::Offset);
            }
            exif.drain(..4 + offset);
            return Ok(Some(exif));
        }
        position = next;
    }
    Ok(None)
}

fn extract_container_exif(path: &Path) -> Result<Vec<u8>, String> {
    let header = read_bounded_prefix(path, 12)?;
    let result = if header.starts_with(b"\xff\xd8") {
        scan_jpeg_exif(path)
    } else if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        scan_png_exif(path)
    } else if header.starts_with(b"RIFF") && header.len() >= 12 && &header[8..12] == b"WEBP" {
        scan_webp_exif(path)
    } else {
        scan_heif_exif(path)
    };
    result
        .map_err(|error| {
            if matches!(error, TiffCompactError::Budget) {
                image_resource_policy::record_rejection(OperationClass::MetadataOnly);
            }
            format!("Bounded embedded metadata read failed: {error}")
        })?
        .ok_or_else(|| "No EXIF data found".to_string())
}

fn empty_exif_data() -> ExifData {
    ExifData {
        make: None,
        model: None,
        software: None,
        date_time: None,
        f_number: None,
        exposure_time: None,
        iso: None,
        focal_length: None,
        raw: HashMap::new(),
    }
}

fn read_embedded_exif_metadata(path: &Path) -> Result<ExifData, String> {
    let _source_lease =
        image_resource_policy::ImageSource::open(path, OperationClass::MetadataOnly)
            .map_err(policy_error)?;
    image_resource_policy::validate_file_size(path, OperationClass::MetadataOnly)
        .map_err(policy_error)?;
    let header = read_bounded_prefix(path, 8)?;
    let bytes = if header.starts_with(b"II*\0") || header.starts_with(b"MM\0*") {
        compact_tiff(path)?
    } else {
        extract_container_exif(path)?
    };
    let exifreader = exif::Reader::new();
    let exif = exifreader.read_raw(bytes).map_err(|_| "No EXIF data found".to_string())?;
    let mut data = empty_exif_data();

    let mut expanded_bytes = 0u64;

    for field in exif.fields() {
        let tag = format!("{}", field.tag);
        let value = field.display_value().with_unit(&exif).to_string();
        expanded_bytes =
            expanded_bytes.saturating_add(value.len() as u64).saturating_add(tag.len() as u64);
        image_resource_policy::validate_metadata_bytes(
            expanded_bytes,
            &image_resource_policy::PolicyLimits::for_operation(OperationClass::MetadataOnly),
        )
        .map_err(policy_error)?;
        data.raw.insert(tag, value.clone());
        match field.tag {
            exif::Tag::Make => data.make = Some(value.trim_matches('"').to_string()),
            exif::Tag::Model => data.model = Some(value.trim_matches('"').to_string()),
            exif::Tag::Software => data.software = Some(value.trim_matches('"').to_string()),
            exif::Tag::DateTimeOriginal | exif::Tag::DateTime if data.date_time.is_none() => {
                data.date_time = Some(value);
            }
            exif::Tag::FNumber => {
                if let exif::Value::Rational(ref values) = field.value {
                    if let Some(value) = values.first() {
                        data.f_number = Some(value.to_f64());
                    }
                }
            }
            exif::Tag::ExposureTime => data.exposure_time = Some(value),
            exif::Tag::PhotographicSensitivity | exif::Tag::ISOSpeed => {
                if let exif::Value::Short(ref values) = field.value {
                    if let Some(value) = values.first() {
                        data.iso = Some(*value as u32);
                    }
                }
            }
            exif::Tag::FocalLength => data.focal_length = Some(value),
            _ => {}
        }
    }

    Ok(data)
}

pub fn get_exif_metadata_blocking(file_path: String) -> Result<ExifData, String> {
    let path = Path::new(&file_path);
    image_resource_policy::validate_file_size(path, OperationClass::MetadataOnly)
        .map_err(policy_error)?;
    let embedded = read_embedded_exif_metadata(path);
    let sidecar = read_xmp_sidecar_metadata(path);

    match (embedded, sidecar) {
        (Ok(mut data), Ok(Some(sidecar_data))) => {
            merge_sidecar_metadata(&mut data, sidecar_data);
            Ok(data)
        }
        (Ok(data), Ok(None)) | (Ok(data), Err(_)) => Ok(data),
        (Err(_), Ok(Some(sidecar_data))) => Ok(sidecar_data),
        (Err(embedded_error), Ok(None)) => Err(embedded_error),
        (Err(_), Err(sidecar_error)) => Err(sidecar_error),
    }
}

fn read_xmp_sidecar_metadata(image_path: &Path) -> Result<Option<ExifData>, String> {
    let Some(sidecar_path) = find_xmp_sidecar_path(image_path) else {
        return Ok(None);
    };
    let sidecar_metadata = fs::metadata(&sidecar_path)
        .map_err(|error| format!("Failed to read XMP sidecar metadata: {error}"))?;
    image_resource_policy::validate_metadata_bytes(
        sidecar_metadata.len(),
        &image_resource_policy::PolicyLimits::for_operation(OperationClass::MetadataOnly),
    )
    .map_err(policy_error)?;
    if sidecar_metadata.len() > MAX_XMP_SIDECAR_BYTES {
        return Err("XMP sidecar is too large to read safely".to_string());
    }

    let xmp = read_bounded_text(&sidecar_path, MAX_XMP_SIDECAR_BYTES)?;
    let mut data = empty_exif_data();
    if let Some(file_name) = sidecar_path.file_name().and_then(|value| value.to_str()) {
        data.raw.insert("XMP Sidecar".to_string(), file_name.to_string());
    }

    apply_xmp_text_field(&xmp, "tiff:Make", "XMP Make", &mut data.raw, &mut data.make);
    apply_xmp_text_field(&xmp, "tiff:Model", "XMP Model", &mut data.raw, &mut data.model);
    apply_xmp_text_field(
        &xmp,
        "xmp:CreatorTool",
        "XMP Creator Tool",
        &mut data.raw,
        &mut data.software,
    );
    apply_xmp_text_field(
        &xmp,
        "xmp:CreateDate",
        "XMP Create Date",
        &mut data.raw,
        &mut data.date_time,
    );
    if data.date_time.is_none() {
        apply_xmp_text_field(
            &xmp,
            "photoshop:DateCreated",
            "XMP Date Created",
            &mut data.raw,
            &mut data.date_time,
        );
    }

    if let Some(value) = extract_xmp_value(&xmp, "exif:FNumber") {
        data.raw.insert("XMP FNumber".to_string(), value.clone());
        data.f_number = parse_xmp_f64(&value);
    }
    if let Some(value) = extract_xmp_value(&xmp, "exif:ExposureTime") {
        data.raw.insert("XMP ExposureTime".to_string(), value.clone());
        data.exposure_time = Some(value);
    }
    if let Some(value) = extract_xmp_value(&xmp, "exif:ISOSpeedRatings")
        .or_else(|| extract_xmp_value(&xmp, "exif:PhotographicSensitivity"))
    {
        data.raw.insert("XMP ISO".to_string(), value.clone());
        data.iso = parse_xmp_u32(&value);
    }
    if let Some(value) = extract_xmp_value(&xmp, "exif:FocalLength") {
        data.raw.insert("XMP FocalLength".to_string(), value.clone());
        data.focal_length = Some(value);
    }

    Ok(Some(data))
}

fn find_xmp_sidecar_path(image_path: &Path) -> Option<PathBuf> {
    let mut candidates = vec![image_path.with_extension("xmp"), image_path.with_extension("XMP")];
    if let Some(file_name) = image_path.file_name().and_then(|value| value.to_str()) {
        candidates.push(image_path.with_file_name(format!("{file_name}.xmp")));
        candidates.push(image_path.with_file_name(format!("{file_name}.XMP")));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn merge_sidecar_metadata(data: &mut ExifData, sidecar_data: ExifData) {
    if data.make.is_none() {
        data.make = sidecar_data.make;
    }
    if data.model.is_none() {
        data.model = sidecar_data.model;
    }
    if data.software.is_none() {
        data.software = sidecar_data.software;
    }
    if data.date_time.is_none() {
        data.date_time = sidecar_data.date_time;
    }
    if data.f_number.is_none() {
        data.f_number = sidecar_data.f_number;
    }
    if data.exposure_time.is_none() {
        data.exposure_time = sidecar_data.exposure_time;
    }
    if data.iso.is_none() {
        data.iso = sidecar_data.iso;
    }
    if data.focal_length.is_none() {
        data.focal_length = sidecar_data.focal_length;
    }
    for (key, value) in sidecar_data.raw {
        data.raw.entry(key).or_insert(value);
    }
}

fn apply_xmp_text_field(
    xmp: &str,
    tag: &str,
    raw_label: &str,
    raw: &mut HashMap<String, String>,
    target: &mut Option<String>,
) {
    if let Some(value) = extract_xmp_value(xmp, tag) {
        raw.insert(raw_label.to_string(), value.clone());
        if target.is_none() {
            *target = Some(value);
        }
    }
}

fn extract_xmp_value(xmp: &str, tag: &str) -> Option<String> {
    extract_xmp_attribute_value(xmp, tag)
        .or_else(|| extract_xmp_element_value(xmp, tag))
        .map(|value| clean_xmp_value(&value))
        .filter(|value| !value.is_empty())
}

fn extract_xmp_attribute_value(xmp: &str, tag: &str) -> Option<String> {
    extract_xmp_attribute_value_with_quote(xmp, tag, '"')
        .or_else(|| extract_xmp_attribute_value_with_quote(xmp, tag, '\''))
}

fn extract_xmp_attribute_value_with_quote(xmp: &str, tag: &str, quote: char) -> Option<String> {
    let start_pattern = format!("{tag}={quote}");
    let value_start = xmp.find(&start_pattern)? + start_pattern.len();
    let value_end = xmp[value_start..].find(quote)? + value_start;
    Some(xmp[value_start..value_end].to_string())
}

fn extract_xmp_element_value(xmp: &str, tag: &str) -> Option<String> {
    let open_start = xmp.find(&format!("<{tag}"))?;
    let content_start = xmp[open_start..].find('>')? + open_start + 1;
    let close_start = xmp[content_start..].find(&format!("</{tag}>"))? + content_start;
    Some(strip_xml_tags(&xmp[content_start..close_start]))
}

fn strip_xml_tags(value: &str) -> String {
    let mut output = String::new();
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(character),
            _ => {}
        }
    }
    output
}

fn clean_xmp_value(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_xmp_f64(value: &str) -> Option<f64> {
    if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.trim().parse::<f64>().ok()?;
        let denominator = denominator.trim().parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }
        return Some(numerator / denominator);
    }
    value.trim().parse::<f64>().ok()
}

fn parse_xmp_u32(value: &str) -> Option<u32> {
    let digits: String =
        value.trim().chars().take_while(|character| character.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_sparse_tiff(path: &Path, tag: u16, typ: u16, count: u32, value_offset: u32) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(b"II*\0\x08\0\0\0").unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&tag.to_le_bytes()).unwrap();
        file.write_all(&typ.to_le_bytes()).unwrap();
        file.write_all(&count.to_le_bytes()).unwrap();
        file.write_all(&value_offset.to_le_bytes()).unwrap();
        file.write_all(&0_u32.to_le_bytes()).unwrap();
    }

    fn minimal_tiff() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"II*\0\x08\0\0\0");
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&0x010f_u16.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&6_u32.to_le_bytes());
        bytes.extend_from_slice(&26_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"Canon\0");
        bytes
    }

    fn push_u16(bytes: &mut Vec<u8>, value: u16, big_endian: bool) {
        let encoded = if big_endian { value.to_be_bytes() } else { value.to_le_bytes() };
        bytes.extend_from_slice(&encoded);
    }

    fn push_u32(bytes: &mut Vec<u8>, value: u32, big_endian: bool) {
        let encoded = if big_endian { value.to_be_bytes() } else { value.to_le_bytes() };
        bytes.extend_from_slice(&encoded);
    }

    fn write_float_tiff(
        path: &Path,
        big_endian: bool,
        count: u32,
        value_offset: u32,
        values: &[f32],
    ) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(if big_endian { b"MM\0*\0\0\0\x08" } else { b"II*\0\x08\0\0\0" });
        push_u16(&mut bytes, 2, big_endian);
        push_u16(&mut bytes, 0x010f, big_endian);
        push_u16(&mut bytes, 2, big_endian);
        push_u32(&mut bytes, 6, big_endian);
        push_u32(&mut bytes, 38, big_endian);
        push_u16(&mut bytes, 0xc001, big_endian);
        push_u16(&mut bytes, 11, big_endian);
        push_u32(&mut bytes, count, big_endian);
        if count == 1 {
            let value = values[0].to_bits();
            push_u32(&mut bytes, value, big_endian);
        } else {
            push_u32(&mut bytes, value_offset, big_endian);
        }
        push_u32(&mut bytes, 0, big_endian);
        bytes.extend_from_slice(b"Canon\0");
        let mut file = fs::File::create(path).unwrap();
        file.write_all(&bytes).unwrap();
        if count > 1 {
            file.set_len(u64::from(value_offset) + u64::try_from(values.len() * 4).unwrap())
                .unwrap();
            file.seek(SeekFrom::Start(u64::from(value_offset))).unwrap();
            for value in values {
                push_u32(&mut bytes, value.to_bits(), big_endian);
            }
            file.write_all(&bytes[38 + 6..]).unwrap();
        }
    }

    fn write_png_with_far_exif(path: &Path, exif: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
        let idat_len = 9 * 1024 * 1024_u32;
        file.write_all(&idat_len.to_be_bytes()).unwrap();
        file.write_all(b"IDAT").unwrap();
        let idat_crc = 16_u64 + u64::from(idat_len);
        file.set_len(idat_crc + 4).unwrap();
        file.seek(SeekFrom::Start(idat_crc)).unwrap();
        file.write_all(&0_u32.to_be_bytes()).unwrap();
        let exif_start = idat_crc + 4;
        file.seek(SeekFrom::Start(exif_start)).unwrap();
        file.write_all(&(u32::try_from(exif.len()).unwrap()).to_be_bytes()).unwrap();
        file.write_all(b"eXIf").unwrap();
        file.write_all(exif).unwrap();
        file.write_all(&0_u32.to_be_bytes()).unwrap();
    }

    fn write_jpeg_with_exif(path: &Path, exif: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(b"\xff\xd8").unwrap();
        file.write_all(b"\xff\xe0").unwrap();
        file.write_all(&4_u16.to_be_bytes()).unwrap();
        file.write_all(&[0, 0]).unwrap();
        file.write_all(b"\xff\xe1").unwrap();
        file.write_all(&(u16::try_from(2 + 6 + exif.len()).unwrap()).to_be_bytes()).unwrap();
        file.write_all(b"Exif\0\0").unwrap();
        file.write_all(exif).unwrap();
        file.write_all(b"\xff\xd9").unwrap();
    }

    fn write_webp_with_far_exif(path: &Path, exif: &[u8]) {
        let mut file = fs::File::create(path).unwrap();
        let vp8_len = 9 * 1024 * 1024_u32;
        let exif_chunk_size = 8_u32 + u32::try_from(exif.len()).unwrap();
        let riff_size = 4_u32 + 8 + vp8_len + 8 + u32::try_from(exif.len()).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&riff_size.to_le_bytes()).unwrap();
        file.write_all(b"WEBP").unwrap();
        file.write_all(b"VP8 ").unwrap();
        file.write_all(&vp8_len.to_le_bytes()).unwrap();
        file.set_len(12 + u64::from(vp8_len) + 8).unwrap();
        let exif_start = 12_u64 + u64::from(vp8_len) + 8;
        file.seek(SeekFrom::Start(exif_start)).unwrap();
        file.write_all(b"EXIF").unwrap();
        file.write_all(&u32::try_from(exif.len()).unwrap().to_le_bytes()).unwrap();
        file.write_all(exif).unwrap();
        if exif_chunk_size & 1 != 0 {
            file.write_all(&[0]).unwrap();
        }
    }

    fn write_heif_with_far_exif(path: &Path, exif: &[u8]) {
        let mut iinf_body = Vec::new();
        iinf_body.extend_from_slice(&[0, 0, 0, 0]);
        iinf_body.extend_from_slice(&1_u16.to_be_bytes());
        iinf_body.extend_from_slice(&20_u32.to_be_bytes());
        iinf_body.extend_from_slice(b"infe");
        iinf_body.extend_from_slice(&[2, 0, 0, 0]);
        iinf_body.extend_from_slice(&1_u16.to_be_bytes());
        iinf_body.extend_from_slice(&0_u16.to_be_bytes());
        iinf_body.extend_from_slice(b"Exif");
        let mut iinf = Vec::new();
        iinf.extend_from_slice(&(u32::try_from(8 + iinf_body.len()).unwrap()).to_be_bytes());
        iinf.extend_from_slice(b"iinf");
        iinf.extend_from_slice(&iinf_body);

        let data_offset = 10 * 1024 * 1024_u64;
        let mut iloc_body = Vec::new();
        iloc_body.extend_from_slice(&[0, 0, 0, 0]);
        iloc_body.extend_from_slice(&0x8400_u16.to_be_bytes());
        iloc_body.extend_from_slice(&1_u16.to_be_bytes());
        iloc_body.extend_from_slice(&1_u16.to_be_bytes());
        iloc_body.extend_from_slice(&0_u16.to_be_bytes());
        iloc_body.extend_from_slice(&1_u16.to_be_bytes());
        iloc_body.extend_from_slice(&data_offset.to_be_bytes());
        iloc_body.extend_from_slice(&u32::try_from(exif.len() + 4).unwrap().to_be_bytes());
        let mut iloc = Vec::new();
        iloc.extend_from_slice(&(u32::try_from(8 + iloc_body.len()).unwrap()).to_be_bytes());
        iloc.extend_from_slice(b"iloc");
        iloc.extend_from_slice(&iloc_body);

        let mut meta_body = Vec::new();
        meta_body.extend_from_slice(&[0, 0, 0, 0]);
        meta_body.extend_from_slice(&iinf);
        meta_body.extend_from_slice(&iloc);
        let mut file = fs::File::create(path).unwrap();
        file.write_all(&20_u32.to_be_bytes()).unwrap();
        file.write_all(b"ftyp").unwrap();
        file.write_all(b"mif1").unwrap();
        file.write_all(&0_u32.to_be_bytes()).unwrap();
        file.write_all(b"mif1").unwrap();
        file.write_all(&(u32::try_from(8 + meta_body.len()).unwrap()).to_be_bytes()).unwrap();
        file.write_all(b"meta").unwrap();
        file.write_all(&meta_body).unwrap();
        file.set_len(data_offset + 4 + u64::try_from(exif.len()).unwrap()).unwrap();
        file.seek(SeekFrom::Start(data_offset)).unwrap();
        file.write_all(&0_u32.to_be_bytes()).unwrap();
        file.write_all(exif).unwrap();
    }

    #[test]
    fn embedded_metadata_reads_are_bounded_to_the_prefix() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large.jpg");
        fs::write(&path, b"0123456789abcdef").unwrap();

        assert_eq!(read_bounded_prefix(&path, 8).unwrap(), b"01234567");
    }

    #[test]
    fn sparse_tiff_reads_ifd_value_beyond_prefix_within_budget() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("far-offset.tif");
        let value_offset = 9 * 1024 * 1024;
        write_sparse_tiff(&path, 0x010f, 2, 6, value_offset);
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(u64::from(value_offset) + 6).unwrap();
        drop(file);
        let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(u64::from(value_offset))).unwrap();
        file.write_all(b"Canon\0").unwrap();
        drop(file);

        let metadata = read_embedded_exif_metadata(&path).unwrap();
        assert_eq!(metadata.make.as_deref(), Some("Canon"));
    }

    #[test]
    fn tiff_float_type_is_four_bytes_for_little_and_big_endian_inline_values() {
        let dir = tempdir().unwrap();
        for big_endian in [false, true] {
            let path = dir.path().join(if big_endian { "float-be.tif" } else { "float-le.tif" });
            write_float_tiff(&path, big_endian, 1, 0, &[1.5]);
            let compact = compact_tiff(&path).unwrap();
            let expected = if big_endian {
                1.5f32.to_bits().to_be_bytes()
            } else {
                1.5f32.to_bits().to_le_bytes()
            };
            assert!(compact.windows(expected.len()).any(|window| window == expected.as_slice()));
            assert_eq!(read_embedded_exif_metadata(&path).unwrap().make.as_deref(), Some("Canon"));
        }
    }

    #[test]
    fn tiff_out_of_line_multi_float_value_uses_four_byte_elements() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("float-array.tif");
        let value_offset = 9 * 1024 * 1024;
        write_float_tiff(&path, false, 2, value_offset, &[1.0, 2.0]);
        let compact = compact_tiff(&path).unwrap();
        let expected = [1.0f32.to_bits().to_le_bytes(), 2.0f32.to_bits().to_le_bytes()].concat();
        assert!(compact.windows(expected.len()).any(|window| window == expected.as_slice()));
        assert_eq!(read_embedded_exif_metadata(&path).unwrap().make.as_deref(), Some("Canon"));
    }

    #[test]
    fn sparse_tiff_rejects_overbudget_value_without_allocating_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("overbudget.tif");
        let value_offset = 9 * 1024 * 1024;
        write_sparse_tiff(
            &path,
            0x010f,
            7,
            (MAX_EMBEDDED_METADATA_READ_BYTES + 1) as u32,
            value_offset,
        );
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(u64::from(value_offset) + MAX_EMBEDDED_METADATA_READ_BYTES + 1).unwrap();
        drop(file);

        let error = read_embedded_exif_metadata(&path).unwrap_err();
        assert!(error.contains("safe read budget"), "{error}");
    }

    #[test]
    fn metadata_ranges_enforce_a_cumulative_read_budget() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ranges.bin");
        fs::write(&path, vec![0u8; 256 * 1024]).unwrap();
        let mut source = BoundedTiffSource::open(&path).unwrap();
        for _ in 0..32 {
            source.read_at(0, 256 * 1024).unwrap();
        }
        assert!(matches!(source.read_at(0, 1), Err(TiffCompactError::Budget)));
    }

    #[test]
    fn sparse_tiff_rejects_malformed_and_cyclic_offsets() {
        let dir = tempdir().unwrap();
        let malformed = dir.path().join("malformed.tif");
        write_sparse_tiff(&malformed, 0x010f, 2, 6, u32::MAX);
        assert!(read_embedded_exif_metadata(&malformed).is_err());

        let cyclic = dir.path().join("cyclic.tif");
        write_sparse_tiff(&cyclic, 0x8769, 4, 1, 8);
        assert!(read_embedded_exif_metadata(&cyclic)
            .unwrap_err()
            .contains("cyclic TIFF IFD pointer"));
    }

    #[test]
    fn sparse_png_and_webp_find_exif_after_encoded_payload() {
        let dir = tempdir().unwrap();
        let exif = minimal_tiff();
        let png = dir.path().join("far.png");
        write_png_with_far_exif(&png, &exif);
        assert_eq!(read_embedded_exif_metadata(&png).unwrap().make.as_deref(), Some("Canon"));

        let webp = dir.path().join("far.webp");
        write_webp_with_far_exif(&webp, &exif);
        assert_eq!(read_embedded_exif_metadata(&webp).unwrap().make.as_deref(), Some("Canon"));
    }

    #[test]
    fn jpeg_app1_exif_is_extracted_without_decoding_pixels() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("metadata.jpg");
        write_jpeg_with_exif(&path, &minimal_tiff());
        assert_eq!(read_embedded_exif_metadata(&path).unwrap().make.as_deref(), Some("Canon"));
    }

    #[test]
    fn sparse_heif_finds_exif_extent_far_from_metadata_boxes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("far.heic");
        write_heif_with_far_exif(&path, &minimal_tiff());
        assert_eq!(read_embedded_exif_metadata(&path).unwrap().make.as_deref(), Some("Canon"));
    }

    #[test]
    fn malformed_or_overbudget_png_chunks_are_rejected_before_read() {
        let dir = tempdir().unwrap();
        let malformed = dir.path().join("malformed.png");
        let mut file = fs::File::create(&malformed).unwrap();
        file.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
        file.write_all(&u32::MAX.to_be_bytes()).unwrap();
        file.write_all(b"eXIf").unwrap();
        assert!(read_embedded_exif_metadata(&malformed).is_err());

        let overbudget = dir.path().join("overbudget.png");
        let mut file = fs::File::create(&overbudget).unwrap();
        file.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
        file.write_all(
            &(u32::try_from(MAX_EMBEDDED_METADATA_READ_BYTES + 1).unwrap()).to_be_bytes(),
        )
        .unwrap();
        file.write_all(b"eXIf").unwrap();
        file.set_len(8 + 8 + MAX_EMBEDDED_METADATA_READ_BYTES + 1 + 4).unwrap();
        assert!(read_embedded_exif_metadata(&overbudget).is_err());
    }
}

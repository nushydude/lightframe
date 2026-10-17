use crate::image_resource_policy::{self, OperationClass};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
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

struct BoundedTiffSource<R = fs::File> {
    file: R,
    file_len: u64,
    bytes_read: u64,
    limit: u64,
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
        Ok(Self { file, file_len, bytes_read: 0, limit: MAX_EMBEDDED_METADATA_READ_BYTES })
    }
}

impl<R: Read + Seek> BoundedTiffSource<R> {
    fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, TiffCompactError> {
        let length_u64 = u64::try_from(length).map_err(|_| TiffCompactError::Offset)?;
        let end = offset.checked_add(length_u64).ok_or(TiffCompactError::Offset)?;
        if end > self.file_len {
            return Err(TiffCompactError::Offset);
        }
        let next_budget =
            self.bytes_read.checked_add(length_u64).ok_or(TiffCompactError::Budget)?;
        if next_budget > self.limit {
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

// The EXIF parser revisits shared child IFDs for every incoming pointer. Bound
// that expanded traversal, not just the number of unique source IFDs. Apply this
// equally to compact TIFFs and TIFF payloads extracted from image containers.
fn with_admitted_tiff<T>(
    bytes: Vec<u8>,
    parse: impl FnOnce(Vec<u8>) -> Result<T, String>,
) -> Result<T, String> {
    fn admit(bytes: &[u8]) -> Result<(), TiffCompactError> {
        struct Walk<'a> {
            bytes: &'a [u8],
            endian: TiffEndian,
            entries: usize,
            expanded_bytes: u64,
        }
        impl Walk<'_> {
            fn range(&self, offset: usize, length: usize) -> Result<&[u8], TiffCompactError> {
                self.bytes
                    .get(offset..offset.checked_add(length).ok_or(TiffCompactError::Offset)?)
                    .ok_or(TiffCompactError::Offset)
            }

            fn ifd(&mut self, offset: usize, context: u8) -> Result<u32, TiffCompactError> {
                let count = usize::from(self.endian.u16(self.range(offset, 2)?));
                self.entries = self.entries.checked_add(count).ok_or(TiffCompactError::Budget)?;
                if self.entries > MAX_TIFF_IFD_ENTRIES {
                    return Err(TiffCompactError::Budget);
                }
                // At most three context levels: TIFF -> Exif -> Interop;
                // GPS is a leaf. Match kamadak-exif's context-sensitive tags.
                for index in 0..count {
                    let entry = self.range(offset + 2 + index * 12, 12)?;
                    let tag = self.endian.u16(entry);
                    let typ = self.endian.u16(&entry[2..]);
                    let units = self.endian.u32(&entry[4..]);
                    let value_offset = self.endian.u32(&entry[8..]);
                    let length = tiff_type_size(typ).unwrap_or(0) * u64::from(units);
                    if length > 4 {
                        self.range(
                            value_offset as usize,
                            usize::try_from(length).map_err(|_| TiffCompactError::Budget)?,
                        )?;
                    }
                    // Include field/index bookkeeping and vector capacity growth.
                    // Only ASCII has a nested Vec per unit (one string per NUL);
                    // byte/MakerNote and numeric values use flat typed vectors.
                    // Charge aliases again: the parser allocates them again.
                    let value_allocation =
                        if typ == 2 { 64 * (u64::from(units) + 1) + length } else { 2 * length };
                    self.expanded_bytes = self
                        .expanded_bytes
                        .checked_add(256 + value_allocation)
                        .ok_or(TiffCompactError::Budget)?;
                    // Reserve half the working budget for retained raw bytes,
                    // display strings and the final metadata map. The separate
                    // input/output metadata ceiling remains 8 MiB.
                    if self.expanded_bytes
                        > image_resource_policy::PolicyLimits::for_operation(
                            OperationClass::MetadataOnly,
                        )
                        .max_working_bytes
                            / 2
                    {
                        return Err(TiffCompactError::Budget);
                    }
                    let child_context = match (context, tag) {
                        (0, 0x8769) => Some(1),
                        (0, 0x8825) => Some(2),
                        (1, 0xa005) => Some(3),
                        _ => None,
                    };
                    if let Some(child_context) = child_context {
                        if typ != 4 || units != 1 {
                            return Err(TiffCompactError::Invalid(
                                "invalid TIFF structural pointer",
                            ));
                        }
                        if self.ifd(value_offset as usize, child_context)? != 0 {
                            return Err(TiffCompactError::Invalid("unexpected child TIFF chain"));
                        }
                    }
                }
                Ok(self.endian.u32(self.range(offset + 2 + count * 12, 4)?))
            }
        }
        if bytes.len() as u64 > MAX_EMBEDDED_METADATA_READ_BYTES {
            return Err(TiffCompactError::Budget);
        }
        if bytes.len() < 8 {
            return Err(TiffCompactError::Offset);
        }
        let endian = match &bytes[..2] {
            b"II" => TiffEndian::Little,
            b"MM" => TiffEndian::Big,
            _ => return Err(TiffCompactError::Invalid("invalid TIFF byte order")),
        };
        if endian.u16(&bytes[2..]) != 42 {
            return Err(TiffCompactError::Invalid("unsupported TIFF header"));
        }
        let mut walk = Walk { bytes, endian, entries: 0, expanded_bytes: 0 };
        let mut offset = endian.u32(&bytes[4..]);
        for _ in 0..MAX_TIFF_IFDS {
            if offset == 0 {
                return Ok(());
            }
            offset = walk.ifd(offset as usize, 0)?;
        }
        if offset == 0 {
            Ok(())
        } else {
            Err(TiffCompactError::Budget)
        }
    }
    admit(&bytes).map_err(|error| {
        if matches!(error, TiffCompactError::Budget) {
            image_resource_policy::record_rejection(OperationClass::MetadataOnly);
        }
        format!("Bounded EXIF expansion failed: {error}")
    })?;
    parse(bytes)
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

fn edit_metadata_error(error: TiffCompactError) -> String {
    if matches!(error, TiffCompactError::Budget) {
        image_resource_policy::record_rejection(OperationClass::MetadataOnly);
    }
    format!("Unable to preserve image metadata safely: {error}")
}

fn split_nul(bytes: &[u8]) -> Result<(&[u8], &[u8]), TiffCompactError> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(TiffCompactError::Invalid("malformed PNG text"))?;
    Ok((&bytes[..end], &bytes[end + 1..]))
}

fn png_text<'a>(
    bytes: &'a [u8],
    kind: &[u8],
    remaining: u64,
) -> Result<(&'a [u8], Vec<u8>), TiffCompactError> {
    let (keyword, mut data) = split_nul(bytes)?;
    if keyword.is_empty() || keyword.len() > 79 {
        return Err(TiffCompactError::Invalid("invalid PNG text keyword"));
    }
    let compressed = if kind == b"zTXt" {
        if data.first() != Some(&0) {
            return Err(TiffCompactError::Invalid("invalid PNG compression"));
        }
        data = &data[1..];
        true
    } else if kind == b"iTXt" {
        if data.len() < 2 || data[0] > 1 || data[1] != 0 {
            return Err(TiffCompactError::Invalid("invalid PNG text compression"));
        }
        let compressed = data[0] == 1;
        data = split_nul(&data[2..])?.1;
        data = split_nul(data)?.1;
        compressed
    } else {
        false
    };
    let mut output = Vec::new();
    if compressed {
        // A fixed scratch chunk and a checked append bound allocation before
        // every growth, unlike decompress_to_vec_zlib's unbounded output.
        let mut decoder = flate2::read::ZlibDecoder::new(data);
        let mut chunk = [0; 4_096];
        loop {
            let read = decoder.read(&mut chunk).map_err(TiffCompactError::Io)?;
            if read == 0 {
                break;
            }
            if (output.len() as u64).saturating_add(read as u64) > remaining {
                return Err(TiffCompactError::Budget);
            }
            output.extend_from_slice(&chunk[..read]);
        }
    } else {
        if data.len() as u64 > remaining {
            return Err(TiffCompactError::Budget);
        }
        output.extend_from_slice(data);
    }
    Ok((keyword, output))
}

fn decode_png_raw_profile(text: &[u8]) -> Result<Vec<u8>, TiffCompactError> {
    let text = std::str::from_utf8(text)
        .map_err(|_| TiffCompactError::Invalid("invalid EXIF profile text"))?;
    let mut lines = text.trim_start().lines();
    if lines.next() != Some("exif") {
        return Err(TiffCompactError::Invalid("invalid EXIF profile name"));
    }
    let declared: usize = lines
        .next()
        .ok_or(TiffCompactError::Invalid("missing EXIF profile length"))?
        .trim()
        .parse()
        .map_err(|_| TiffCompactError::Invalid("invalid EXIF profile length"))?;
    if declared as u64 > MAX_EMBEDDED_METADATA_READ_BYTES {
        return Err(TiffCompactError::Budget);
    }
    let mut output = Vec::new();
    let mut high = None;
    for byte in lines.flat_map(str::bytes).filter(|byte| !byte.is_ascii_whitespace()) {
        let digit = (byte as char)
            .to_digit(16)
            .ok_or(TiffCompactError::Invalid("invalid EXIF profile hex"))?
            as u8;
        if let Some(first) = high.take() {
            if output.len() >= declared {
                return Err(TiffCompactError::Invalid("EXIF profile length mismatch"));
            }
            output.push(first * 16 + digit);
        } else {
            high = Some(digit);
        }
    }
    if high.is_some() || output.len() != declared {
        return Err(TiffCompactError::Invalid("EXIF profile length mismatch"));
    }
    if output.starts_with(b"Exif\0\0") {
        output.drain(..6);
    }
    Ok(output)
}

pub(crate) fn read_edit_exif(
    source: &image_resource_policy::ImageSource,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(test)]
    let limit = EDIT_METADATA_TEST_LIMIT.with(|limit| limit.get());
    #[cfg(not(test))]
    let limit = MAX_EMBEDDED_METADATA_READ_BYTES;
    read_edit_exif_with_limit(source, limit)
}

#[cfg(test)]
thread_local! {
    static EDIT_METADATA_TEST_LIMIT: std::cell::Cell<u64> = const { std::cell::Cell::new(MAX_EMBEDDED_METADATA_READ_BYTES) };
}

#[cfg(test)]
pub(crate) fn with_edit_metadata_test_limit<T>(limit: u64, run: impl FnOnce() -> T) -> T {
    struct Restore(u64);
    impl Drop for Restore {
        fn drop(&mut self) {
            EDIT_METADATA_TEST_LIMIT.with(|limit| limit.set(self.0));
        }
    }
    let _restore = Restore(EDIT_METADATA_TEST_LIMIT.with(|current| current.replace(limit)));
    run()
}

fn read_edit_exif_with_limit(
    source: &image_resource_policy::ImageSource,
    limit: u64,
) -> Result<Option<Vec<u8>>, String> {
    let mut input = BoundedTiffSource {
        file: source.reader().map_err(policy_error)?,
        file_len: source.encoded_len(),
        bytes_read: 0,
        limit,
    };
    let payload = (|| -> Result<Option<Vec<u8>>, TiffCompactError> {
        let header = input.read_at(0, usize::try_from(input.file_len.min(12)).unwrap())?;
        let mut selected = None;
        if header.starts_with(b"\xff\xd8") {
            let mut pos = 2;
            while pos < input.file_len {
                let mut marker = input.read_at(pos, 2)?;
                if marker[0] != 0xff {
                    return Err(TiffCompactError::Invalid("invalid JPEG marker"));
                }
                while marker[1] == 0xff {
                    pos += 1;
                    marker = input.read_at(pos, 2)?;
                }
                pos += 2;
                if matches!(marker[1], 0xda | 0xd9) {
                    break;
                }
                if marker[1] == 1 || (0xd0..=0xd7).contains(&marker[1]) {
                    continue;
                }
                let length = u64::from(be_u16(&input.read_at(pos, 2)?));
                if length < 2 {
                    return Err(TiffCompactError::Offset);
                }
                input.check_range(pos, length)?;
                if marker[1] == 0xe1 && length >= 8 && input.read_at(pos + 2, 6)? == b"Exif\0\0" {
                    let value = input.read_at(pos + 8, (length - 8) as usize)?;
                    if selected.replace(value).is_some() {
                        return Err(TiffCompactError::Invalid("duplicate EXIF metadata"));
                    }
                }
                pos += length;
            }
        } else if header.starts_with(b"\x89PNG\r\n\x1a\n") {
            let mut pos = 8;
            while pos < input.file_len {
                let chunk = input.read_at(pos, 8)?;
                let length = u64::from(be_u32(&chunk));
                let kind = &chunk[4..];
                input.check_range(pos + 8, length + 4)?;
                if matches!(kind, b"eXIf" | b"tEXt" | b"zTXt" | b"iTXt") {
                    let data = input.read_at(pos + 8, length as usize)?;
                    let checksum = be_u32(&input.read_at(pos + 8 + length, 4)?);
                    if png_crc(kind, &data) != checksum {
                        return Err(TiffCompactError::Invalid("invalid PNG metadata checksum"));
                    }
                    let value = if kind == b"eXIf" {
                        Some(data)
                    } else {
                        let (keyword, text) =
                            png_text(&data, kind, limit.saturating_sub(input.bytes_read))?;
                        input.bytes_read += text.len() as u64;
                        if keyword == b"Raw profile type exif" {
                            Some(decode_png_raw_profile(&text)?)
                        } else {
                            None
                        }
                    };
                    if let Some(value) = value {
                        if selected.replace(value).is_some() {
                            return Err(TiffCompactError::Invalid("duplicate EXIF metadata"));
                        }
                    }
                }
                pos += length + 12;
                if kind == b"IEND" {
                    break;
                }
            }
        } else if header.len() == 12 && &header[..4] == b"RIFF" && &header[8..] == b"WEBP" {
            let end = 8 + u64::from(le_u32(&header[4..]));
            input.check_range(0, end)?;
            let mut pos = 12;
            while pos < end {
                let chunk = input.read_at(pos, 8)?;
                let length = u64::from(le_u32(&chunk[4..]));
                if pos + 8 + length + (length & 1) > end {
                    return Err(TiffCompactError::Offset);
                }
                if &chunk[..4] == b"EXIF" {
                    let mut value = input.read_at(pos + 8, length as usize)?;
                    if value.starts_with(b"Exif\0\0") {
                        value.drain(..6);
                    }
                    if selected.replace(value).is_some() {
                        return Err(TiffCompactError::Invalid("duplicate EXIF metadata"));
                    }
                }
                pos += 8 + length + (length & 1);
            }
        }
        Ok(selected)
    })()
    .map_err(edit_metadata_error)?;
    payload
        .map(|bytes| {
            with_admitted_tiff(bytes, |mut bytes| {
                // Only root TIFF Orientation tags control pixel orientation. Child
                // contexts have different tag meanings; preserve their bytes verbatim.
                let endian =
                    if bytes.starts_with(b"II") { TiffEndian::Little } else { TiffEndian::Big };
                let mut offset = endian.u32(&bytes[4..]) as usize;
                while offset != 0 {
                    let count = usize::from(endian.u16(&bytes[offset..]));
                    for index in 0..count {
                        let entry = offset + 2 + 12 * index;
                        if endian.u16(&bytes[entry..]) == 0x112 {
                            if endian.u16(&bytes[entry + 2..]) != 3
                                || endian.u32(&bytes[entry + 4..]) != 1
                            {
                                return Err(
                                    "Unable to preserve malformed Orientation metadata".to_string()
                                );
                            }
                            bytes[entry + 8..entry + 10].copy_from_slice(&match endian {
                                TiffEndian::Little => 1u16.to_le_bytes(),
                                TiffEndian::Big => 1u16.to_be_bytes(),
                            });
                        }
                    }
                    offset = endian.u32(&bytes[offset + 2 + 12 * count..]) as usize;
                }
                Ok(bytes)
            })
        })
        .transpose()
}

fn png_crc(kind: &[u8], bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in kind.iter().chain(bytes) {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

// The destination is an owned, unpublished edit output. PNG/WebP pixels were
// freshly encoded; JPEG may retain markers after a lossless transform. Rewrite
// chunks as opaque bytes, never asking a metadata writer to decompress text.
pub(crate) fn write_edit_exif(output_path: &Path, exif: &[u8]) -> Result<(), String> {
    let owned_output =
        image_resource_policy::ImageSource::open(output_path, OperationClass::Overwrite)
            .map_err(policy_error)?;
    let rewrite =
        match crate::atomic_file::build_unique_sibling_path(output_path, "lightframe-metadata") {
            Ok(path) => path,
            Err(error) => {
                let _ = owned_output.discard_owned();
                return Err(error);
            }
        };
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(0xc001_0000).share_mode(1); // READ | WRITE | DELETE, share READ only
    }
    let mut output = match options.open(&rewrite) {
        Ok(file) => file,
        Err(_) => {
            let _ = owned_output.discard_owned();
            return Err("Unable to create owned metadata output".to_string());
        }
    };
    let result = (|| -> Result<(), String> {
        let length = owned_output.encoded_len();
        let mut input = owned_output.reader().map_err(policy_error)?;
        rewrite_edit_container(&mut input, length, &mut output, exif)
            .map_err(|error| format!("Unable to preserve image metadata: {error}"))?;
        output.sync_all().map_err(|_| "Unable to flush metadata output")?;
        drop(input);
        Ok(())
    })();
    if let Err(error) = result {
        let _ = image_resource_policy::ImageSource::discard_opened(&output, &rewrite);
        let _ = owned_output.discard_owned();
        return Err(error);
    }
    // Retain the output's lease through guarded replacement as well: an owned
    // temporary pathname alone is not authority to overwrite a later collision.
    #[cfg(windows)]
    let published = owned_output.replace_opened(&output, output_path);
    #[cfg(not(windows))]
    let published = owned_output.replace(&rewrite, output_path);
    if let Err(error) = published {
        let _ = image_resource_policy::ImageSource::discard_opened(&output, &rewrite);
        return Err(format!("Unable to finalize owned metadata output: {error}"));
    }
    Ok(())
}

fn rewrite_edit_container(
    input: &mut (impl Read + Seek),
    length: u64,
    output: &mut (impl Write + Seek),
    exif: &[u8],
) -> std::io::Result<()> {
    fn invalid() -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid edit container")
    }
    fn at<const N: usize>(input: &mut (impl Read + Seek), offset: u64) -> std::io::Result<[u8; N]> {
        input.seek(SeekFrom::Start(offset))?;
        let mut bytes = [0; N];
        input.read_exact(&mut bytes)?;
        Ok(bytes)
    }
    fn copy(
        input: &mut (impl Read + Seek),
        output: &mut impl Write,
        offset: u64,
        count: u64,
        length: u64,
    ) -> std::io::Result<()> {
        if offset.checked_add(count).is_none_or(|end| end > length) {
            return Err(invalid());
        }
        input.seek(SeekFrom::Start(offset))?;
        if std::io::copy(&mut input.take(count), output)? != count {
            return Err(invalid());
        }
        Ok(())
    }
    let header = at::<2>(input, 0)?;
    if header == [0xff, 0xd8] {
        let segment_len =
            u16::try_from(exif.len().checked_add(8).ok_or_else(invalid)?).map_err(|_| invalid())?;
        output.write_all(&[0xff, 0xd8, 0xff, 0xe1])?;
        output.write_all(&segment_len.to_be_bytes())?;
        output.write_all(b"Exif\0\0")?;
        output.write_all(exif)?;
        let mut pos = 2;
        while pos < length {
            let start = pos;
            let mut marker = at::<2>(input, pos)?;
            if marker[0] != 0xff {
                return Err(invalid());
            }
            while marker[1] == 0xff {
                pos += 1;
                marker = at::<2>(input, pos)?;
            }
            pos += 2;
            if matches!(marker[1], 0xda | 0xd9) {
                return copy(input, output, start, length - start, length);
            }
            if marker[1] == 1 || (0xd0..=0xd7).contains(&marker[1]) {
                copy(input, output, start, pos - start, length)?;
                continue;
            }
            let size = u64::from(u16::from_be_bytes(at::<2>(input, pos)?));
            if size < 2 || pos + size > length {
                return Err(invalid());
            }
            let old_exif =
                marker[1] == 0xe1 && size >= 8 && at::<6>(input, pos + 2)? == *b"Exif\0\0";
            if !old_exif {
                copy(input, output, start, pos + size - start, length)?;
            }
            pos += size;
        }
        return Err(invalid());
    }
    if at::<8>(input, 0)? == *b"\x89PNG\r\n\x1a\n" {
        output.write_all(b"\x89PNG\r\n\x1a\n")?;
        let mut pos = 8;
        let mut inserted = false;
        while pos < length {
            let chunk = at::<8>(input, pos)?;
            let size = u64::from(be_u32(&chunk));
            if pos + size + 12 > length {
                return Err(invalid());
            }
            if &chunk[4..] != b"eXIf" {
                copy(input, output, pos, size + 12, length)?;
            }
            if &chunk[4..] == b"IHDR" && !inserted {
                output.write_all(&(exif.len() as u32).to_be_bytes())?;
                output.write_all(b"eXIf")?;
                output.write_all(exif)?;
                output.write_all(&png_crc(b"eXIf", exif).to_be_bytes())?;
                inserted = true;
            }
            pos += size + 12;
            if &chunk[4..] == b"IEND" {
                return if inserted { Ok(()) } else { Err(invalid()) };
            }
        }
        return Err(invalid());
    }
    let header = at::<12>(input, 0)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WEBP" {
        return Err(invalid());
    }
    let end = 8 + u64::from(le_u32(&header[4..]));
    if end > length {
        return Err(invalid());
    }
    let first = at::<8>(input, 12)?;
    output.write_all(b"RIFF\0\0\0\0WEBP")?;
    if &first[..4] != b"VP8X" {
        // Fresh image::WebPEncoder output is VP8L. Also support simple lossy
        // VP8, without loading either encoded pixel payload into memory.
        let (width, height, alpha) = if &first[..4] == b"VP8L" {
            let data = at::<5>(input, 20)?;
            if data[0] != 0x2f {
                return Err(invalid());
            }
            let bits = le_u32(&data[1..]);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, (bits >> 28) & 1 != 0)
        } else if &first[..4] == b"VP8 " {
            let data = at::<10>(input, 20)?;
            if data[3..6] != [0x9d, 0x01, 0x2a] {
                return Err(invalid());
            }
            (
                u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                false,
            )
        } else {
            return Err(invalid());
        };
        if width == 0 || height == 0 {
            return Err(invalid());
        }
        output.write_all(b"VP8X\x0a\0\0\0")?;
        output.write_all(&[0x08 | if alpha { 0x10 } else { 0 }, 0, 0, 0])?;
        output.write_all(&(width - 1).to_le_bytes()[..3])?;
        output.write_all(&(height - 1).to_le_bytes()[..3])?;
    }
    let mut pos = 12;
    while pos < end {
        let chunk = at::<8>(input, pos)?;
        let size = u64::from(le_u32(&chunk[4..]));
        let total = 8 + size + (size & 1);
        if pos + total > end {
            return Err(invalid());
        }
        if &chunk[..4] == b"VP8X" {
            if size != 10 {
                return Err(invalid());
            }
            let mut data = at::<10>(input, pos + 8)?;
            data[0] |= 0x08;
            output.write_all(&chunk)?;
            output.write_all(&data)?;
        } else if &chunk[..4] != b"EXIF" {
            copy(input, output, pos, total, end)?;
        }
        pos += total;
    }
    output.write_all(b"EXIF")?;
    output.write_all(&(exif.len() as u32).to_le_bytes())?;
    output.write_all(exif)?;
    if exif.len() & 1 != 0 {
        output.write_all(&[0])?;
    }
    let riff_size = u32::try_from(output.stream_position()?.checked_sub(8).ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    output.seek(SeekFrom::Start(4))?;
    output.write_all(&riff_size.to_le_bytes())?;
    Ok(())
}

fn bounded_metadata_display(value: impl std::fmt::Display, limit: u64) -> Result<String, String> {
    use std::fmt::Write;
    struct Output {
        value: String,
        limit: u64,
    }
    impl Write for Output {
        fn write_str(&mut self, value: &str) -> std::fmt::Result {
            if (self.value.len() as u64).saturating_add(value.len() as u64) > self.limit {
                return Err(std::fmt::Error);
            }
            self.value.push_str(value);
            Ok(())
        }
    }
    let mut output = Output { value: String::new(), limit };
    write!(&mut output, "{value}").map_err(|_| {
        policy_error(image_resource_policy::ResourcePolicyError::MetadataBytesExceedLimit {
            bytes: limit.saturating_add(1),
            max: limit,
        })
    })?;
    Ok(output.value)
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
    let exif = with_admitted_tiff(bytes, |bytes| {
        exifreader.read_raw(bytes).map_err(|_| "No EXIF data found".to_string())
    })?;
    let mut data = empty_exif_data();

    let mut expanded_bytes = 0u64;

    for field in exif.fields() {
        let tag = format!("{}", field.tag);
        let remaining = MAX_EMBEDDED_METADATA_READ_BYTES
            .saturating_sub(expanded_bytes)
            .saturating_sub(tag.len() as u64);
        let value = bounded_metadata_display(field.display_value().with_unit(&exif), remaining)?;
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
pub(crate) mod tests {
    pub(crate) fn edit_exif_fixture() -> Vec<u8> {
        let mut bytes = b"II*\0\x08\0\0\0".to_vec();
        push_u16(&mut bytes, 2, false);
        push_u16(&mut bytes, 0x10f, false);
        push_u16(&mut bytes, 2, false);
        push_u32(&mut bytes, 4, false);
        bytes.extend_from_slice(b"CAM\0");
        push_u16(&mut bytes, 0x112, false);
        push_u16(&mut bytes, 3, false);
        push_u32(&mut bytes, 1, false);
        push_u32(&mut bytes, 6, false);
        push_u32(&mut bytes, 0, false);
        bytes
    }

    pub(crate) fn insert_png_text(path: &Path, kind: &[u8], data: &[u8]) {
        let bytes = fs::read(path).unwrap();
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&png_crc(kind, data).to_be_bytes());
        let mut updated = bytes[..33].to_vec(); // after the encoder's IHDR
        updated.extend_from_slice(&chunk);
        updated.extend_from_slice(&bytes[33..]);
        fs::write(path, updated).unwrap();
    }

    pub(crate) fn compressed_png_text(text: &[u8], keyword: &[u8]) -> Vec<u8> {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text).unwrap();
        let mut chunk = keyword.to_vec();
        chunk.extend_from_slice(&[0, 0]);
        chunk.extend_from_slice(&encoder.finish().unwrap());
        chunk
    }

    #[test]
    fn edit_metadata_preserves_camera_and_normalizes_orientation_in_all_outputs() {
        let dir = tempdir().unwrap();
        for extension in ["jpg", "png", "webp"] {
            let source_path = dir.path().join(format!("source.{extension}"));
            let output_path = dir.path().join(format!("output.{extension}"));
            image::RgbImage::new(16, 12).save(&source_path).unwrap();
            image::RgbImage::new(8, 6).save(&output_path).unwrap();
            write_edit_exif(&source_path, &edit_exif_fixture()).unwrap();
            let source =
                image_resource_policy::ImageSource::open(&source_path, OperationClass::Overwrite)
                    .unwrap();
            let metadata = read_edit_exif(&source).unwrap().unwrap();
            write_edit_exif(&output_path, &metadata).unwrap();
            let mut file = std::io::BufReader::new(fs::File::open(&output_path).unwrap());
            let parsed = exif::Reader::new().read_from_container(&mut file).unwrap();
            assert_eq!(
                parsed
                    .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                    .unwrap()
                    .value
                    .get_uint(0),
                Some(1)
            );
            assert_eq!(
                parsed
                    .get_field(exif::Tag::Make, exif::In::PRIMARY)
                    .unwrap()
                    .display_value()
                    .to_string(),
                "\"CAM\""
            );
            assert_eq!(image::open(&output_path).unwrap().dimensions(), (8, 6));
        }
    }

    #[test]
    fn compressed_png_profile_is_preserved_with_bounded_inflation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("profile.png");
        image::RgbImage::new(2, 2).save(&path).unwrap();
        let mut raw = b"Exif\0\0".to_vec();
        raw.extend(edit_exif_fixture());
        let hex: String = raw.iter().map(|byte| format!("{byte:02x}")).collect();
        let profile = format!("\nexif\n{}\n{hex}\n", raw.len());
        insert_png_text(
            &path,
            b"zTXt",
            &compressed_png_text(profile.as_bytes(), b"Raw profile type exif"),
        );
        let source =
            image_resource_policy::ImageSource::open(&path, OperationClass::Overwrite).unwrap();
        let metadata = read_edit_exif(&source).unwrap().unwrap();
        let parsed = exif::Reader::new().read_raw(metadata).unwrap();
        assert_eq!(
            parsed.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0),
            Some(1)
        );
        assert!(read_edit_exif_with_limit(&source, 128).unwrap_err().contains("safe read budget"));
    }

    #[test]
    fn malformed_png_metadata_is_a_controlled_error() {
        for data in [b"missing nul".as_slice(), b"Raw profile type exif\0\0not zlib".as_slice()] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("malformed.png");
            image::RgbImage::new(2, 2).save(&path).unwrap();
            insert_png_text(&path, b"zTXt", data);
            let source =
                image_resource_policy::ImageSource::open(&path, OperationClass::Overwrite).unwrap();
            assert!(read_edit_exif(&source)
                .unwrap_err()
                .contains("preserve image metadata safely"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn metadata_publication_collision_preserves_concurrent_file_and_recovery() {
        use image_resource_policy::PublicationStage;
        let dir = tempdir().unwrap();
        let path = dir.path().join("owned-output.png");
        image::RgbImage::new(2, 2).save(&path).unwrap();
        let original = fs::read(&path).unwrap();
        let recovery = std::rc::Rc::new(std::cell::RefCell::new(None));
        let recorded = recovery.clone();
        image_resource_policy::set_publication_hook(move |stage, destination, backup| {
            if stage == PublicationStage::OriginalMoved {
                fs::write(destination, b"concurrent file").unwrap();
                *recorded.borrow_mut() = Some(backup.to_path_buf());
            }
            false
        });
        let result = write_edit_exif(&path, &edit_exif_fixture());
        image_resource_policy::clear_publication_hook();
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"concurrent file");
        assert_eq!(fs::read(recovery.borrow().as_ref().unwrap()).unwrap(), original);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn failed_metadata_writer_discards_only_owned_outputs() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("owned-output.png");
        let unrelated = dir.path().join("unrelated.png");
        fs::write(&path, b"not an image").unwrap();
        fs::write(&unrelated, b"keep").unwrap();
        assert!(write_edit_exif(&path, &edit_exif_fixture()).is_err());
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn metadata_display_stops_at_budget_before_consuming_more_output() {
        struct Chunks<'a>(&'a std::cell::Cell<usize>);
        impl std::fmt::Display for Chunks<'_> {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                for _ in 0..100 {
                    self.0.set(self.0.get() + 1);
                    formatter.write_str("abcd")?;
                }
                Ok(())
            }
        }
        let writes = std::cell::Cell::new(0);
        let rejections = image_resource_policy::rejection_count();
        assert!(bounded_metadata_display(Chunks(&writes), 8).unwrap_err().contains("safe limit"));
        assert!(image_resource_policy::rejection_count() > rejections);
        assert_eq!(writes.get(), 3);
        assert_eq!(bounded_metadata_display("camera", 6).unwrap(), "camera");
    }

    fn shared_ifd_fixture(count: u16, big_endian: bool) -> Vec<u8> {
        let mut bytes = if big_endian { b"MM".to_vec() } else { b"II".to_vec() };
        push_u16(&mut bytes, 42, big_endian);
        push_u32(&mut bytes, 8, big_endian);
        let block = 6 + 12 * u32::from(count);
        for level in 0..3 {
            push_u16(&mut bytes, count, big_endian);
            for _ in 0..count {
                push_u16(&mut bytes, [0x8769, 0xa005, 0x100][level], big_endian);
                push_u16(&mut bytes, if level == 2 { 3 } else { 4 }, big_endian);
                push_u32(&mut bytes, 1, big_endian);
                push_u32(
                    &mut bytes,
                    if level == 2 { 0 } else { 8 + block * (level as u32 + 1) },
                    big_endian,
                );
            }
            push_u32(&mut bytes, 0, big_endian);
        }
        bytes
    }

    #[test]
    fn expanded_shared_ifds_are_rejected_before_parser_for_tiff_and_embedded_exif() {
        let dir = tempdir().unwrap();
        for big_endian in [false, true] {
            let bytes = shared_ifd_fixture(32, big_endian);
            assert!(bytes.len() < 2_000);
            let path = dir.path().join("shared.tif");
            fs::write(&path, &bytes).unwrap();
            let compact = compact_tiff(&path).unwrap();
            let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe1];
            jpeg.extend_from_slice(&((bytes.len() + 8) as u16).to_be_bytes());
            jpeg.extend_from_slice(b"Exif\0\0");
            jpeg.extend_from_slice(&bytes);
            jpeg.extend_from_slice(&[0xff, 0xd9]);
            let jpeg_path = dir.path().join("shared.jpg");
            fs::write(&jpeg_path, jpeg).unwrap();
            let embedded = extract_container_exif(&jpeg_path).unwrap();
            let mut payloads = vec![bytes.clone(), compact, embedded];
            for (name, writer) in [
                ("shared.png", write_png_with_far_exif as fn(&Path, &[u8])),
                ("shared.webp", write_webp_with_far_exif),
                ("shared.heif", write_heif_with_far_exif),
            ] {
                let path = dir.path().join(name);
                writer(&path, &bytes);
                payloads.push(extract_container_exif(&path).unwrap());
            }
            for payload in payloads {
                let mut called = false;
                let rejections = image_resource_policy::rejection_count();
                let result = with_admitted_tiff(payload, |_| {
                    called = true;
                    Ok(())
                });
                assert!(result.unwrap_err().contains("safe read budget"));
                assert!(!called);
                assert!(image_resource_policy::rejection_count() > rejections);
            }
        }
    }

    #[test]
    fn small_shared_ifds_remain_supported_in_both_byte_orders() {
        for big_endian in [false, true] {
            let parsed = with_admitted_tiff(shared_ifd_fixture(2, big_endian), |bytes| {
                exif::Reader::new().read_raw(bytes).map_err(|error| error.to_string())
            })
            .unwrap();
            assert_eq!(parsed.fields().count(), 8);
        }
    }

    #[test]
    fn aliased_ascii_values_are_charged_before_parser() {
        let count = 2_048u16;
        let value_offset = 8 + 6 + 12 * u32::from(count);
        let mut bytes = b"II*\0\x08\0\0\0".to_vec();
        push_u16(&mut bytes, count, false);
        for _ in 0..count {
            push_u16(&mut bytes, 0x10f, false);
            push_u16(&mut bytes, 2, false);
            push_u32(&mut bytes, 1_024, false);
            push_u32(&mut bytes, value_offset, false);
        }
        push_u32(&mut bytes, 0, false);
        bytes.extend_from_slice(&[0; 1_024]);
        assert!(bytes.len() < 26_000);
        let result = with_admitted_tiff(bytes, |_| -> Result<(), String> {
            panic!("overbudget value expansion reached parser")
        });
        assert!(result.unwrap_err().contains("safe read budget"));
    }

    #[test]
    fn ordinary_large_undefined_maker_note_uses_flat_value_budget() {
        let length = 256 * 1_024;
        let mut bytes = b"II*\0\x08\0\0\0".to_vec();
        push_u16(&mut bytes, 1, false);
        push_u16(&mut bytes, 0x8769, false);
        push_u16(&mut bytes, 4, false);
        push_u32(&mut bytes, 1, false);
        push_u32(&mut bytes, 26, false);
        push_u32(&mut bytes, 0, false);
        push_u16(&mut bytes, 1, false);
        push_u16(&mut bytes, 0x927c, false);
        push_u16(&mut bytes, 7, false);
        push_u32(&mut bytes, length, false);
        push_u32(&mut bytes, 44, false);
        push_u32(&mut bytes, 0, false);
        bytes.resize(44 + length as usize, 1);
        let parsed = with_admitted_tiff(bytes, |bytes| {
            exif::Reader::new().read_raw(bytes).map_err(|error| error.to_string())
        })
        .unwrap();
        let field = parsed.get_field(exif::Tag::MakerNote, exif::In::PRIMARY).unwrap();
        assert!(
            matches!(&field.value, exif::Value::Undefined(value, _) if value.len() == length as usize)
        );
    }

    use super::*;
    use image::GenericImageView;
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

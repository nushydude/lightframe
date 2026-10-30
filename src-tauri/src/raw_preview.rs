//! Bounded RAF slots and classic TIFF/NEF IFDs; never sensor decode or container fallback.
use crate::image_resource_policy::{self, ImageSource, OperationClass};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const HEADER_BYTES: usize = 92;
pub(crate) const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

fn validate_jpeg_metadata(
    bytes: &[u8],
    operation: OperationClass,
    checkpoint: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    let limits = image_resource_policy::PolicyLimits::for_operation(operation);
    let mut position = 2usize;
    let mut metadata_bytes = 0u64;
    let mut header_bytes = 0u64;
    let mut entropy = false;
    let mut icc_count = None;
    let mut icc_seen = [false; 256];
    // Independent preflight prevents oversized APP/ICC metadata reaching codec allocation.
    // Entropy bytes are only skipped, not decoded; metadata between progressive scans is
    // included. No recursive TIFF/profile interpretation or metadata decompression occurs.
    for index in 0..65_536 {
        if index % 256 == 0 {
            checkpoint()?;
        }
        if header_bytes > limits.max_metadata_bytes {
            return Err("RAF JPEG header exceeds the scan budget".into());
        }
        if entropy {
            while position < bytes.len() {
                if position.is_multiple_of(65_536) {
                    checkpoint()?;
                }
                if bytes[position] != 0xff {
                    position += 1;
                    continue;
                }
                match bytes.get(position + 1) {
                    Some(0 | 0xd0..=0xd7) => position += 2,
                    Some(0xff) => position += 1,
                    _ => break,
                }
            }
            entropy = false;
        }
        if bytes.get(position) != Some(&0xff) {
            return Err("Invalid RAF JPEG marker".into());
        }
        let marker_start = position;
        while bytes.get(position) == Some(&0xff) {
            position += 1;
            if position - marker_start > limits.max_metadata_bytes as usize {
                return Err("RAF JPEG marker padding exceeds the scan budget".into());
            }
        }
        let marker = *bytes.get(position).ok_or("Truncated RAF JPEG marker")?;
        position += 1;
        header_bytes = header_bytes
            .checked_add((position - marker_start) as u64)
            .ok_or("RAF JPEG header overflows")?;
        if header_bytes > limits.max_metadata_bytes {
            return Err("RAF JPEG header exceeds the scan budget".into());
        }
        if marker == 0xd9 {
            if let Some(count) = icc_count {
                if !(1..=count).all(|part| icc_seen[usize::from(part)]) {
                    return Err("RAF JPEG ICC chunks are incomplete".into());
                }
            }
            return Ok(());
        }
        if marker == 0x01 {
            continue;
        }
        if marker == 0 || (0xd0..=0xd8).contains(&marker) {
            return Err("Invalid RAF JPEG header marker".into());
        }
        let pair = bytes.get(position..position + 2).ok_or("Truncated RAF JPEG segment")?;
        let length = usize::from(u16::from_be_bytes([pair[0], pair[1]]));
        if length < 2 {
            return Err("Invalid RAF JPEG segment length".into());
        }
        let end = position.checked_add(length).ok_or("RAF JPEG segment overflows")?;
        if end > bytes.len() {
            return Err("Truncated RAF JPEG segment".into());
        }
        header_bytes =
            header_bytes.checked_add(length as u64).ok_or("RAF JPEG header overflows")?;
        if header_bytes > limits.max_metadata_bytes {
            return Err("RAF JPEG header exceeds the scan budget".into());
        }
        if (0xe0..=0xef).contains(&marker) || marker == 0xfe {
            metadata_bytes =
                metadata_bytes.checked_add(length as u64).ok_or("RAF JPEG metadata overflows")?;
            image_resource_policy::validate_metadata_bytes(metadata_bytes, &limits)
                .map_err(|error| error.to_string())?;
        }
        let payload = &bytes[position + 2..end];
        if marker == 0xe2 && payload.starts_with(b"ICC_PROFILE\0") {
            if payload.len() < 14 {
                return Err("RAF JPEG ICC chunk is truncated".into());
            }
            let part = payload[12];
            let count = payload[13];
            if part == 0
                || count == 0
                || part > count
                || icc_seen[usize::from(part)]
                || icc_count.is_some_and(|expected| expected != count)
            {
                return Err("RAF JPEG ICC chunk sequence is invalid".into());
            }
            icc_seen[usize::from(part)] = true;
            icc_count = Some(count);
        }
        position = end;
        if marker == 0xda {
            entropy = true;
        }
    }
    Err("RAF JPEG header exceeds the marker budget".into())
}

pub(crate) fn is_raf(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("raf"))
}

pub(crate) fn is_bounded_raw(path: &Path) -> bool {
    is_raf(path) || path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("nef"))
}

const MAX_IFDS: usize = 32;
const MAX_IFD_DEPTH: usize = 8;
const MAX_ENTRIES: usize = 4096;
const MAX_TIFF_READS: usize = 128;

struct TiffReader<'a, R, C> {
    reader: &'a mut R,
    checkpoint: C,
    file_len: u64,
    reads: usize,
    bytes: u64,
    max_bytes: u64,
    little: bool,
}

impl<R: Read + Seek, C: FnMut() -> Result<(), String>> TiffReader<'_, R, C> {
    fn read(&mut self, offset: u64, length: usize) -> Result<Vec<u8>, String> {
        (self.checkpoint)()?;
        let end = offset.checked_add(length as u64).ok_or("TIFF range overflow")?;
        let total = self.bytes.checked_add(length as u64).ok_or("TIFF budget overflow")?;
        if end > self.file_len || self.reads >= MAX_TIFF_READS || total > self.max_bytes {
            return Err("TIFF metadata read/range budget exceeded".into());
        }
        self.reads += 1;
        self.bytes = total;
        self.reader.seek(SeekFrom::Start(offset)).map_err(|_| "TIFF seek failed")?;
        let mut bytes = vec![0; length];
        self.reader.read_exact(&mut bytes).map_err(|_| "TIFF read truncated or changed")?;
        (self.checkpoint)()?;
        Ok(bytes)
    }

    fn u16(&self, bytes: &[u8]) -> u16 {
        let pair = bytes[..2].try_into().unwrap();
        if self.little {
            u16::from_le_bytes(pair)
        } else {
            u16::from_be_bytes(pair)
        }
    }

    fn u32(&self, bytes: &[u8]) -> u32 {
        let quad = bytes[..4].try_into().unwrap();
        if self.little {
            u32::from_le_bytes(quad)
        } else {
            u32::from_be_bytes(quad)
        }
    }
}

#[cfg(test)]
fn read_tiff_preview<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    operation: OperationClass,
    checkpoint: impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    read_tiff_preview_details(reader, file_len, operation, checkpoint).map(|(bytes, _)| bytes)
}

fn read_tiff_preview_details<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    operation: OperationClass,
    checkpoint: impl FnMut() -> Result<(), String>,
) -> Result<(Vec<u8>, Option<image::metadata::Orientation>), String> {
    let mut tiff = TiffReader {
        reader,
        checkpoint,
        file_len,
        reads: 0,
        bytes: 0,
        max_bytes: image_resource_policy::PolicyLimits::for_operation(operation).max_metadata_bytes,
        little: false,
    };
    let header = tiff.read(0, 8)?;
    tiff.little = match &header[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return Err("Invalid TIFF byte order".into()),
    };
    if tiff.u16(&header[2..]) != 42 {
        return Err("Only classic TIFF NEF containers are supported".into());
    }
    let mut pending = vec![(u64::from(tiff.u32(&header[4..])), 0usize)];
    let mut visited = std::collections::HashSet::new();
    let mut total_entries = 0usize;
    let mut candidates = Vec::new();
    let mut container_orientation = None;
    while let Some((offset, depth)) = pending.pop() {
        if offset == 0 {
            continue;
        }
        if offset < 8
            || depth > MAX_IFD_DEPTH
            || visited.len() >= MAX_IFDS
            || !visited.insert(offset)
        {
            return Err("TIFF IFD cycle/depth/count budget exceeded".into());
        }
        let count_bytes = tiff.read(offset, 2)?;
        let count = usize::from(tiff.u16(&count_bytes));
        total_entries = total_entries.checked_add(count).ok_or("TIFF entry overflow")?;
        if total_entries > MAX_ENTRIES {
            return Err("TIFF entry budget exceeded".into());
        }
        let length = count
            .checked_mul(12)
            .and_then(|n| n.checked_add(4))
            .ok_or("TIFF directory overflow")?;
        let entries = tiff.read(offset.checked_add(2).ok_or("TIFF offset overflow")?, length)?;
        let mut jpeg_offset = None;
        let mut jpeg_length = None;
        let mut compression = None;
        for entry in entries[..count * 12].chunks_exact(12) {
            let tag = tiff.u16(entry);
            if !matches!(tag, 259 | 274 | 330 | 513 | 514) {
                continue;
            }
            let kind = tiff.u16(&entry[2..]);
            let values = tiff.u32(&entry[4..]);
            if tag == 330 {
                if kind != 4 || values == 0 || values as usize > MAX_IFDS {
                    return Err("Unsupported TIFF SubIFD array".into());
                }
                if pending.len() + values as usize > MAX_IFDS {
                    return Err("TIFF link budget exceeded".into());
                }
                if values == 1 {
                    pending.push((u64::from(tiff.u32(&entry[8..])), depth + 1));
                } else {
                    let links = tiff.read(u64::from(tiff.u32(&entry[8..])), values as usize * 4)?;
                    for link in links.chunks_exact(4) {
                        pending.push((u64::from(tiff.u32(link)), depth + 1));
                    }
                }
                continue;
            }
            if values != 1 || !matches!(kind, 3 | 4) {
                return Err("Unsupported TIFF JPEG tag type/count".into());
            }
            let value =
                if kind == 3 { u32::from(tiff.u16(&entry[8..])) } else { tiff.u32(&entry[8..]) };
            if tag == 274 {
                // IFD0 describes the camera's display transform. It overrides JPEG EXIF once,
                // even when explicitly 1; subIFD sensor orientations never override it.
                if depth == 0 {
                    let orientation = u8::try_from(value)
                        .ok()
                        .and_then(image::metadata::Orientation::from_exif)
                        .ok_or("Invalid TIFF orientation")?;
                    if container_orientation.replace(orientation).is_some() {
                        return Err("Duplicate TIFF orientation".into());
                    }
                }
                continue;
            }
            let target = match tag {
                259 => &mut compression,
                513 => &mut jpeg_offset,
                _ => &mut jpeg_length,
            };
            if target.replace(value).is_some() {
                return Err("Duplicate TIFF JPEG tag".into());
            }
        }
        let next = u64::from(tiff.u32(&entries[count * 12..]));
        if next != 0 {
            if pending.len() >= MAX_IFDS {
                return Err("TIFF link budget exceeded".into());
            }
            pending.push((next, depth + 1));
        }
        if let (Some(start), Some(length)) = (jpeg_offset, jpeg_length) {
            if compression != Some(6) {
                return Err("Unsupported TIFF preview compression".into());
            }
            let start = u64::from(start);
            let length = u64::from(length);
            if start < 8
                || !(4..=MAX_PREVIEW_BYTES).contains(&length)
                || start.checked_add(length).is_none_or(|end| end > file_len)
            {
                return Err("TIFF JPEG range exceeds supported bounds".into());
            }
            candidates.push((start, length));
        } else if jpeg_offset.is_some() || jpeg_length.is_some() {
            return Err("Incomplete TIFF JPEG range".into());
        }
    }
    // Compare actual SOF pixel area, then encoded size, without reading candidate payloads.
    // Directory/sensor dimensions are never presented as embedded dimensions.
    let mut best = None;
    for (offset, length) in candidates {
        let area = tiff_jpeg_area(&mut tiff, offset, length, operation)?;
        if best.is_none_or(|(old_area, _, old_length)| (area, length) > (old_area, old_length)) {
            best = Some((area, offset, length));
        }
    }
    let (_, offset, length) = best.ok_or("No supported embedded JPEG in NEF")?;
    image_resource_policy::validate_decoder_input_reservation(length, operation)
        .map_err(|e| e.to_string())?;
    (tiff.checkpoint)()?;
    tiff.reader.seek(SeekFrom::Start(offset)).map_err(|_| "TIFF JPEG seek failed")?;
    let mut bytes = vec![0; usize::try_from(length).map_err(|_| "TIFF JPEG too large")?];
    tiff.reader.read_exact(&mut bytes).map_err(|_| "TIFF JPEG truncated or changed")?;
    (tiff.checkpoint)()?;
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("TIFF preview is not a complete JPEG".into());
    }
    validate_jpeg_metadata(&bytes, operation, &mut tiff.checkpoint)?;
    Ok((bytes, container_orientation))
}

fn tiff_jpeg_area<R: Read + Seek, C: FnMut() -> Result<(), String>>(
    tiff: &mut TiffReader<'_, R, C>,
    start: u64,
    length: u64,
    operation: OperationClass,
) -> Result<u64, String> {
    let end = start.checked_add(length).ok_or("TIFF JPEG overflow")?;
    if tiff.read(start, 2)? != [0xff, 0xd8] {
        return Err("Invalid TIFF JPEG signature".into());
    }
    let mut position = start + 2;
    for _ in 0..64 {
        if position.checked_add(4).is_none_or(|n| n > end) || position - start > tiff.max_bytes {
            return Err("TIFF JPEG header range exceeded".into());
        }
        let marker = tiff.read(position, 4)?;
        if marker[0] != 0xff {
            return Err("Invalid TIFF JPEG marker".into());
        }
        let segment = u64::from(u16::from_be_bytes([marker[2], marker[3]]));
        if segment < 2 {
            return Err("Invalid TIFF JPEG segment".into());
        }
        let next = position.checked_add(2 + segment).ok_or("TIFF JPEG segment overflow")?;
        if next > end {
            return Err("Truncated TIFF JPEG header".into());
        }
        if matches!(marker[1], 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if segment < 8 {
                return Err("Truncated TIFF JPEG SOF".into());
            }
            let dimensions = tiff.read(position + 4, 5)?;
            let height = u32::from(u16::from_be_bytes([dimensions[1], dimensions[2]]));
            let width = u32::from(u16::from_be_bytes([dimensions[3], dimensions[4]]));
            image_resource_policy::validate_dimensions(
                width,
                height,
                &image_resource_policy::PolicyLimits::for_operation(operation),
            )
            .map_err(|e| e.to_string())?;
            return Ok(u64::from(width) * u64::from(height));
        }
        if marker[1] == 0xda || marker[1] == 0xd9 {
            return Err("Missing TIFF JPEG dimensions".into());
        }
        position = next;
    }
    Err("TIFF JPEG marker budget exceeded".into())
}

fn checked_range(offset: u64, length: u64, file_len: u64) -> Result<usize, String> {
    if offset < HEADER_BYTES as u64 || !(4..=MAX_PREVIEW_BYTES).contains(&length) {
        return Err("RAF embedded JPEG range exceeds supported bounds".into());
    }
    let end = offset.checked_add(length).ok_or("RAF embedded JPEG range overflows")?;
    if end > file_len {
        return Err("RAF embedded JPEG range is truncated".into());
    }
    usize::try_from(length).map_err(|_| "RAF embedded JPEG is too large for this platform".into())
}

fn read_preview<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    operation: OperationClass,
    mut checkpoint: impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    checkpoint()?;
    let mut header = [0; HEADER_BYTES];
    reader.read_exact(&mut header).map_err(|_| "RAF header is truncated")?;
    if &header[..16] != b"FUJIFILMCCD-RAW " {
        return Err("Invalid RAF signature".into());
    }
    let offset = u64::from(u32::from_be_bytes(header[84..88].try_into().unwrap()));
    let length = u64::from(u32::from_be_bytes(header[88..92].try_into().unwrap()));
    let capacity = checked_range(offset, length, file_len)?;
    image_resource_policy::validate_decoder_input_reservation(length, operation)
        .map_err(|error| error.to_string())?;
    checkpoint()?;
    reader.seek(SeekFrom::Start(offset)).map_err(|_| "Unable to seek RAF preview")?;
    // Exactly one capped range is allocated. No prefix growth, candidate scan, or read-ahead.
    let mut bytes = vec![0; capacity];
    reader.read_exact(&mut bytes).map_err(|_| "RAF embedded JPEG is truncated or changed")?;
    checkpoint()?;
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("RAF preview is not a complete JPEG".into());
    }
    validate_jpeg_metadata(&bytes, operation, &mut checkpoint)?;
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn embedded_jpeg(path: &Path, operation: OperationClass) -> Result<Vec<u8>, String> {
    embedded_preview(path, operation).map(|(bytes, _)| bytes)
}

pub(crate) fn embedded_preview(
    path: &Path,
    operation: OperationClass,
) -> Result<(Vec<u8>, Option<image::metadata::Orientation>), String> {
    if !is_bounded_raw(path) {
        return Err(
            "Bounded RAW preview supports RAF and fixture-backed classic TIFF NEF only".into()
        );
    }
    crate::media_executor::checkpoint()?;
    let source = ImageSource::open(path, operation).map_err(|error| error.to_string())?;
    // Bypass BufReader so its read-ahead cannot read bytes outside the admitted ranges.
    let mut reader = source.reader().map_err(|error| error.to_string())?.into_inner();
    let checkpoint = || {
        crate::media_executor::checkpoint()?;
        source.validate_unchanged().map_err(|error| error.to_string())
    };
    let result = (if is_raf(path) {
        read_preview(&mut reader, source.encoded_len(), operation, checkpoint)
            .map(|bytes| (bytes, None))
    } else {
        read_tiff_preview_details(&mut reader, source.encoded_len(), operation, checkpoint)
    })
    .and_then(|preview| {
        crate::media_executor::checkpoint()?;
        source.validate_unchanged().map_err(|error| error.to_string())?;
        Ok(preview)
    });
    if let Err(error) = &result {
        image_resource_policy::record_rejection(operation);
        eprintln!("Bounded RAW preview rejected: {error}");
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

    pub(crate) fn pinned_nef() -> std::path::PathBuf {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-corpus/fixtures/nikon-d70s-v1.nef");
        let bytes = std::fs::read(&path).expect("required tiff-nikon-d70s-v1 must exist");
        assert_eq!(bytes.len(), 5_193_213);
        assert_eq!(
            Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "6c46f9854033e7623ebbb5de8c951df6762ca44f05d45035ccc5cb7e9f4e5692"
        );
        path
    }

    pub(crate) fn tiff_container(jpeg: &[u8], little: bool) -> Vec<u8> {
        let word = |v: u16| if little { v.to_le_bytes() } else { v.to_be_bytes() };
        let long = |v: u32| if little { v.to_le_bytes() } else { v.to_be_bytes() };
        let mut bytes = Vec::from(if little { *b"II" } else { *b"MM" });
        bytes.extend(word(42));
        bytes.extend(long(8));
        bytes.extend(word(3));
        for (tag, value) in [(259, 6), (513, 50), (514, jpeg.len() as u32)] {
            bytes.extend(word(tag));
            bytes.extend(word(4));
            bytes.extend(long(1));
            bytes.extend(long(value));
        }
        bytes.extend(long(0));
        bytes.extend(jpeg);
        bytes
    }

    fn parse_tiff(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
        let length = bytes.len() as u64;
        read_tiff_preview(&mut Cursor::new(bytes), length, OperationClass::Preview, || Ok(()))
    }

    #[test]
    fn tiff_family_bounded_native_exact_range_and_endian() {
        let bytes = std::fs::read(pinned_nef()).unwrap();
        let expected = bytes[131_072..848_660].to_vec();
        let mut traced = TracedReader { inner: Cursor::new(bytes), reads: vec![] };
        assert_eq!(
            read_tiff_preview(&mut traced, 5_193_213, OperationClass::Preview, || Ok(())).unwrap(),
            expected
        );
        assert_eq!(traced.reads.last(), Some(&(131_072, 717_588)));
        assert!(traced.reads.len() <= MAX_TIFF_READS + 1);
        assert!(
            traced.reads[..traced.reads.len() - 1].iter().map(|(_, n)| n).sum::<usize>() < 2048
        );
        for little in [false, true] {
            assert_eq!(parse_tiff(tiff_container(&expected, little)).unwrap(), expected);
        }
    }

    #[test]
    fn tiff_family_bounded_rejects_malformed_and_fixed_seed_extents() {
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(64, 32))
            .write_to(&mut output, image::ImageFormat::Jpeg)
            .unwrap();
        let jpeg = output.into_inner();
        let good = tiff_container(&jpeg, true);
        assert_eq!(parse_tiff(good.clone()).unwrap(), jpeg);
        for end in 0..good.len() {
            assert!(parse_tiff(good[..end].to_vec()).is_err());
        }
        for (start, bytes, expected_error) in [
            (2, 43u16.to_le_bytes().to_vec(), "Only classic TIFF"), // magic only; IFD offset stays valid
            (4, u32::MAX.to_le_bytes().to_vec(), "metadata read/range budget"),
            (8, u16::MAX.to_le_bytes().to_vec(), "entry budget"),
            (46, 8u32.to_le_bytes().to_vec(), "IFD cycle/depth/count"),
            (18, 1u32.to_le_bytes().to_vec(), "Unsupported TIFF preview compression"),
            (30, u32::MAX.to_le_bytes().to_vec(), "JPEG range exceeds"),
            (42, (MAX_PREVIEW_BYTES as u32 + 1).to_le_bytes().to_vec(), "JPEG range exceeds"),
        ] {
            let mut bad = good.clone();
            bad[start..start + bytes.len()].copy_from_slice(&bytes);
            let mut traced = TracedReader { inner: Cursor::new(bad), reads: vec![] };
            let error =
                read_tiff_preview(&mut traced, good.len() as u64, OperationClass::Preview, || {
                    Ok(())
                })
                .unwrap_err();
            assert!(error.contains(expected_error), "offset {start}: {error}");
            assert!(traced.reads.iter().all(|(_, n)| *n <= 40));
        }
        assert!(parse_tiff(tiff_container(b"not JPEG", false))
            .unwrap_err()
            .contains("Invalid TIFF JPEG signature"));
        let mut seed = 0x69f1_2345u32;
        for _ in 0..1024 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let mut bad = good.clone();
            bad[30..34].copy_from_slice(&seed.to_le_bytes());
            bad[42..46].copy_from_slice(&seed.rotate_left(13).to_le_bytes());
            let mut traced = TracedReader { inner: Cursor::new(bad), reads: vec![] };
            let error =
                read_tiff_preview(&mut traced, good.len() as u64, OperationClass::Preview, || {
                    Ok(())
                })
                .unwrap_err();
            assert!(error.contains("JPEG range exceeds"), "seed {seed}: {error}");
            assert!(traced.reads.iter().all(|(_, n)| *n <= 40));
        }
    }

    #[test]
    fn tiff_family_bounded_cancellation_and_unsupported_families() {
        let mut output = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(320, 160))
            .write_to(&mut output, image::ImageFormat::Jpeg)
            .unwrap();
        let jpeg = output.into_inner();
        let bytes = tiff_container(&jpeg, false);
        let mut baseline = TracedReader { inner: Cursor::new(bytes.clone()), reads: vec![] };
        let mut checkpoint_count = 0;
        assert_eq!(
            read_tiff_preview(&mut baseline, bytes.len() as u64, OperationClass::Preview, || {
                checkpoint_count += 1;
                Ok(())
            })
            .unwrap(),
            jpeg
        );
        assert_eq!(baseline.reads.last(), Some(&(50, jpeg.len())));
        assert!(baseline.reads.len() <= MAX_TIFF_READS + 1);
        // A successful baseline proves every injected failure belongs to a reachable checkpoint,
        // including the selected payload read and the subsequent JPEG metadata preflight.
        for sentinel in ["injected cancellation", "injected source change"] {
            for stop in 0..checkpoint_count {
                let mut calls = 0;
                let mut traced = TracedReader { inner: Cursor::new(bytes.clone()), reads: vec![] };
                let result = read_tiff_preview(
                    &mut traced,
                    bytes.len() as u64,
                    OperationClass::Preview,
                    || {
                        calls += 1;
                        if calls > stop {
                            Err(sentinel.into())
                        } else {
                            Ok(())
                        }
                    },
                );
                assert_eq!(result.unwrap_err(), sentinel, "checkpoint {stop}");
                assert_eq!(calls, stop + 1);
                assert!(traced.reads.len() <= baseline.reads.len());
                assert_eq!(traced.reads, baseline.reads[..traced.reads.len()]);
                if stop == checkpoint_count - 1 {
                    assert_eq!(traced.reads.last(), Some(&(50, jpeg.len())));
                }
            }
        }
        for ext in [
            "dng", "cr2", "arw", "nrw", "srf", "sr2", "orf", "rw2", "pef", "srw", "cr3", "tiff",
            "jpg",
        ] {
            let path = std::path::PathBuf::from(format!("fixture.{ext}"));
            assert!(!is_bounded_raw(&path));
            assert!(embedded_jpeg(&path, OperationClass::Preview)
                .unwrap_err()
                .contains("fixture-backed"));
        }
    }

    #[test]
    fn tiff_family_bounded_directory_and_read_budgets_before_allocation() {
        // A next-IFD chain exceeds the depth cap without needing any image payload.
        let mut chain = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        for n in 0..10u32 {
            chain.extend(0u16.to_le_bytes());
            chain.extend(if n == 9 { 0 } else { 8 + (n + 1) * 6 }.to_le_bytes());
        }
        assert!(parse_tiff(chain).unwrap_err().contains("depth"));
        let mut array = tiff_container(&[0xff, 0xd8, 0xff, 0xd9], true);
        array[10..12].copy_from_slice(&330u16.to_le_bytes());
        array[14..18].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_tiff(array).unwrap_err().contains("SubIFD"));
        let mut source = TracedReader { inner: Cursor::new(vec![0; 8]), reads: vec![] };
        let mut tiff = TiffReader {
            reader: &mut source,
            checkpoint: || Ok(()),
            file_len: 8,
            reads: 0,
            bytes: 0,
            max_bytes: 8,
            little: true,
        };
        assert!(tiff.read(u64::MAX, 8).is_err());
        assert!(tiff.read(0, 9).is_err());
        assert!(tiff.read(0, usize::MAX).is_err());
        assert!(tiff.read(0, 8).is_ok());
        assert!(tiff.read(0, 1).is_err());
        tiff.bytes = 0;
        tiff.reads = MAX_TIFF_READS;
        assert!(tiff.read(0, 1).is_err());
        assert_eq!(source.reads, [(0, 8)]);
    }

    #[test]
    fn tiff_family_bounded_missing_duplicate_profile_and_source_admission() {
        let mut missing = tiff_container(&[0xff, 0xd8, 0xff, 0xd9], true);
        missing[22..24].copy_from_slice(&273u16.to_le_bytes()); // strip offset is never a JPEG candidate
        missing[34..36].copy_from_slice(&279u16.to_le_bytes());
        assert!(parse_tiff(missing).unwrap_err().contains("No supported embedded JPEG"));
        let mut duplicate = tiff_container(&[0xff, 0xd8, 0xff, 0xd9], true);
        duplicate[34..36].copy_from_slice(&513u16.to_le_bytes());
        assert!(parse_tiff(duplicate).unwrap_err().contains("Duplicate"));
        // Unsupported outer ICC extents are ignored, not allocated or used for output colour.
        let mut bytes = std::fs::read(pinned_nef()).unwrap();
        bytes[10..12].copy_from_slice(&34675u16.to_be_bytes());
        bytes[12..14].copy_from_slice(&7u16.to_be_bytes());
        bytes[14..18].copy_from_slice(&u32::MAX.to_be_bytes());
        bytes[18..22].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(parse_tiff(bytes).unwrap().len(), 717_588);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.nef");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(
            image_resource_policy::PolicyLimits::for_operation(OperationClass::Preview)
                .max_input_bytes
                + 1,
        )
        .unwrap();
        drop(file);
        assert!(embedded_jpeg(&path, OperationClass::Preview).is_err());
    }

    #[test]
    fn tiff_family_bounded_candidate_selection_uses_pixels_before_encoded_size() {
        fn jpeg(width: u32, height: u32) -> Vec<u8> {
            let mut output = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(image::RgbImage::new(width, height))
                .write_to(&mut output, image::ImageFormat::Jpeg)
                .unwrap();
            output.into_inner()
        }
        let large = jpeg(64, 32);
        let mut small = jpeg(2, 2);
        // A small image has a much larger COM segment; encoded size must not win.
        small.splice(2..2, [vec![0xff, 0xfe, 0x10, 0x02], vec![0; 4096]].concat());
        assert!(small.len() > large.len());
        let mut bytes = tiff_container(&small, true);
        let next = bytes.len() as u32;
        bytes[46..50].copy_from_slice(&next.to_le_bytes());
        let mut second = tiff_container(&large, true);
        second[30..34].copy_from_slice(&(next + 42).to_le_bytes());
        bytes.extend_from_slice(&second[8..]);
        assert_eq!(parse_tiff(bytes).unwrap(), large);
    }

    pub(crate) fn pinned_raf() -> std::path::PathBuf {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test-corpus/fixtures/finepix-s5000-v1.raf");
        let bytes = std::fs::read(&path).expect("required raf-finepix-s5000-v1 must exist");
        assert_eq!(bytes.len(), 6_851_240);
        assert_eq!(
            Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            "dabd5e74521a6980156be9fd4b88d0c37b0fe4d0e0e6f5c12db8cffff1b76297"
        );
        path
    }

    pub(crate) fn container(jpeg: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; HEADER_BYTES];
        bytes[..16].copy_from_slice(b"FUJIFILMCCD-RAW ");
        bytes[84..88].copy_from_slice(&(HEADER_BYTES as u32).to_be_bytes());
        bytes[88..92].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
        bytes.extend_from_slice(jpeg);
        bytes
    }

    struct TracedReader {
        inner: Cursor<Vec<u8>>,
        reads: Vec<(u64, usize)>,
    }
    impl Read for TracedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads.push((self.inner.position(), buffer.len()));
            self.inner.read(buffer)
        }
    }
    impl Seek for TracedReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn raf_bounded_pinned_preview_exact_ranges() {
        let path = pinned_raf();
        let bytes = std::fs::read(path).unwrap();
        let offset = u32::from_be_bytes(bytes[84..88].try_into().unwrap()) as u64;
        let length = u32::from_be_bytes(bytes[88..92].try_into().unwrap()) as usize;
        let mut source = TracedReader { inner: Cursor::new(bytes), reads: vec![] };
        let preview =
            read_preview(&mut source, 6_851_240, OperationClass::Preview, || Ok(())).unwrap();
        assert_eq!(source.reads, [(0, HEADER_BYTES), (offset, length)]);
        assert_eq!(
            image::load_from_memory_with_format(&preview, image::ImageFormat::Jpeg)
                .unwrap()
                .width(),
            1280
        );
    }

    #[test]
    fn raf_bounded_generated_offset_length_pairs_never_allocate_declared_extents() {
        let values = [0, 1, 91, 92, 93, 96, 128, MAX_PREVIEW_BYTES, u32::MAX as u64, u64::MAX];
        for offset in values {
            for length in values {
                let admitted = checked_range(offset, length, 1024).is_ok();
                let expected = offset >= 92
                    && (4..=MAX_PREVIEW_BYTES).contains(&length)
                    && offset.checked_add(length).is_some_and(|end| end <= 1024);
                assert_eq!(admitted, expected, "{offset}/{length}");
            }
        }
        for (offset, length) in [(u32::MAX, u32::MAX), (92, u32::MAX), (0, 4), (92, 0), (92, 5)] {
            let mut bytes = container(&[0xff, 0xd8, 0xff, 0xd9]);
            bytes[84..88].copy_from_slice(&offset.to_be_bytes());
            bytes[88..92].copy_from_slice(&length.to_be_bytes());
            let mut source = TracedReader { inner: Cursor::new(bytes), reads: vec![] };
            assert!(read_preview(&mut source, 96, OperationClass::Preview, || Ok(())).is_err());
            assert_eq!(source.reads, [(0, HEADER_BYTES)]);
        }
    }

    #[test]
    fn raf_bounded_cancel_before_header_or_allocation_and_changed_source() {
        for fail_at in 0..3 {
            let mut source = TracedReader {
                inner: Cursor::new(container(&[0xff, 0xd8, 0xff, 0xd9])),
                reads: vec![],
            };
            let mut stage = 0;
            let result = read_preview(&mut source, 96, OperationClass::Preview, || {
                let current = stage;
                stage += 1;
                if current == fail_at {
                    Err("injected cancel/source changed".into())
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(source.reads.len(), fail_at);
        }
    }

    #[test]
    fn raf_bounded_rejects_bad_missing_truncated_and_ignores_other_candidates() {
        let good = [0xff, 0xd8, 0xff, 0xd9];
        for bytes in [
            vec![],
            vec![0; 92],
            container(&[]),
            container(b"not JPEG"),
            container(&[0xff, 0xd8, 0, 0]),
        ] {
            let len = bytes.len() as u64;
            assert!(read_preview(&mut Cursor::new(bytes), len, OperationClass::Preview, || Ok(()))
                .is_err());
        }
        let mut bytes = container(&good);
        bytes.extend_from_slice(&good); // A decoy is never scanned or selected.
        bytes.extend_from_slice(b"FUJIFILMCCD-RAW \0");
        let mut source = TracedReader { inner: Cursor::new(bytes), reads: vec![] };
        assert_eq!(
            read_preview(&mut source, 116, OperationClass::Preview, || Ok(())).unwrap(),
            good
        );
        assert_eq!(source.reads, [(0, 92), (92, 4)]);
        let mut truncated = container(&good);
        truncated.pop();
        assert!(read_preview(&mut Cursor::new(truncated), 96, OperationClass::Preview, || Ok(()))
            .is_err());
    }

    #[test]
    fn raf_bounded_wrong_extension_and_file_limit_and_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let wrong = dir.path().join("wrong.nef");
        std::fs::write(&wrong, container(&[0xff, 0xd8, 0xff, 0xd9])).unwrap();
        assert!(embedded_jpeg(&wrong, OperationClass::Preview).is_err());
        let path = dir.path().join("huge.raf");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(
            image_resource_policy::PolicyLimits::for_operation(OperationClass::Preview)
                .max_input_bytes
                + 1,
        )
        .unwrap();
        drop(file);
        assert!(embedded_jpeg(&path, OperationClass::Preview).is_err());
        let source = ImageSource::open(&wrong, OperationClass::Preview).unwrap();
        #[cfg(windows)]
        assert!(std::fs::write(&wrong, b"changed").is_err());
        drop(source);
        // The admitted source's path vanishing or being replaced is rejected deterministically.
        std::fs::write(&wrong, b"changed").unwrap();
        let source = ImageSource::open(&wrong, OperationClass::Preview).unwrap();
        #[cfg(not(windows))]
        {
            std::fs::write(&wrong, b"changed source length").unwrap();
            assert!(source.validate_unchanged().is_err());
        }
        #[cfg(windows)]
        assert!(source.validate_unchanged().is_ok());
    }

    #[test]
    fn raf_bounded_metadata_caps_malformed_icc_and_progressive_interscan_segments() {
        fn segment(bytes: &mut Vec<u8>, marker: u8, payload: &[u8]) {
            bytes.extend_from_slice(&[0xff, marker]);
            bytes.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
            bytes.extend_from_slice(payload);
        }
        for payload in [
            b"ICC_PROFILE\0".as_slice(),
            b"ICC_PROFILE\0\x00\x01data",
            b"ICC_PROFILE\0\x01\x02data",
        ] {
            let mut jpeg = vec![0xff, 0xd8];
            segment(&mut jpeg, 0xe2, payload);
            jpeg.extend_from_slice(&[0xff, 0xd9]);
            assert!(validate_jpeg_metadata(&jpeg, OperationClass::Preview, &mut || Ok(())).is_err());
        }
        let mut jpeg = vec![0xff, 0xd8];
        segment(&mut jpeg, 0xda, &[1, 1, 0, 0, 63, 0]);
        jpeg.extend_from_slice(&[0x11, 0xff, 0, 0x22, 0xff, 0xd0]);
        segment(&mut jpeg, 0xe2, b"ICC_PROFILE\0\x01\x02missing chunk");
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        assert!(validate_jpeg_metadata(&jpeg, OperationClass::Preview, &mut || Ok(())).is_err());
        let payload = vec![0; 65_533];
        let mut jpeg = vec![0xff, 0xd8];
        for _ in 0..129 {
            segment(&mut jpeg, 0xe1, &payload);
        }
        jpeg.extend_from_slice(&[0xff, 0xd9]);
        assert!(validate_jpeg_metadata(&jpeg, OperationClass::Preview, &mut || Ok(())).is_err());
        assert!(validate_jpeg_metadata(
            &[0xff, 0xd8, 0xff, 0xe1, 0, 1, 0xff, 0xd9],
            OperationClass::Preview,
            &mut || Ok(())
        )
        .is_err());
    }
}

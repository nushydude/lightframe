//! RAF's documented JPEG slot only: no sensor decode, scanning, or whole-container fallback.
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

pub(crate) fn embedded_jpeg(path: &Path, operation: OperationClass) -> Result<Vec<u8>, String> {
    if !is_raf(path) {
        return Err("Bounded RAW preview supports RAF files only".into());
    }
    crate::media_executor::checkpoint()?;
    let source = ImageSource::open(path, operation).map_err(|error| error.to_string())?;
    // Bypass BufReader so its read-ahead cannot read bytes outside the admitted ranges.
    let mut reader = source.reader().map_err(|error| error.to_string())?.into_inner();
    let result = read_preview(&mut reader, source.encoded_len(), operation, || {
        crate::media_executor::checkpoint()?;
        source.validate_unchanged().map_err(|error| error.to_string())
    });
    if let Err(error) = &result {
        image_resource_policy::record_rejection(operation);
        eprintln!("Bounded RAF preview rejected: {error}");
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Cursor;

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

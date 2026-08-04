use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek};
#[cfg(test)]
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
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

#[cfg(test)]
fn read_embedded_exif_metadata(path: &Path) -> Result<ExifData, String> {
    let file =
        std::fs::File::open(path).map_err(|error| format!("Failed to open file: {error}"))?;
    read_embedded_exif_metadata_from_file(file)
}

fn read_embedded_exif_metadata_from_file(file: fs::File) -> Result<ExifData, String> {
    let mut reader = std::io::BufReader::new(file);
    let exifreader = exif::Reader::new();
    let exif = exifreader
        .read_from_container(&mut reader)
        .map_err(|_| "No EXIF data found".to_string())?;
    let mut data = empty_exif_data();

    for field in exif.fields() {
        let tag = format!("{}", field.tag);
        let value = field.display_value().with_unit(&exif).to_string();
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

pub fn get_exif_metadata_from_authorized_files(
    image_file: fs::File,
    sidecar: Option<(String, fs::File)>,
) -> Result<ExifData, String> {
    let limits = crate::image_resource_policy::PolicyLimits::for_operation(
        crate::image_resource_policy::OperationClass::MetadataOnly,
    );
    let image_size = image_file
        .metadata()
        .map_err(|error| format!("Failed to inspect EXIF source handle: {error}"))?
        .len();
    crate::image_resource_policy::validate_file_size_bytes(image_size, &limits)
        .map_err(|error| format!("EXIF source rejected: {error}"))?;
    let embedded = read_embedded_exif_metadata_from_file(image_file);
    let sidecar = sidecar
        .map(|(file_name, file)| read_xmp_sidecar_from_file(&file_name, file))
        .transpose()
        .map(Option::flatten);
    merge_exif_results(embedded, sidecar)
}

#[cfg(test)]
pub fn get_exif_metadata_blocking(file_path: String) -> Result<ExifData, String> {
    let path = Path::new(&file_path);
    let embedded = read_embedded_exif_metadata(path);
    let sidecar = read_xmp_sidecar_metadata(path);

    merge_exif_results(embedded, sidecar)
}

fn merge_exif_results(
    embedded: Result<ExifData, String>,
    sidecar: Result<Option<ExifData>, String>,
) -> Result<ExifData, String> {
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

#[cfg(test)]
fn read_xmp_sidecar_metadata(image_path: &Path) -> Result<Option<ExifData>, String> {
    let Some(sidecar_path) = find_xmp_sidecar_path(image_path) else {
        return Ok(None);
    };
    let sidecar_metadata = fs::metadata(&sidecar_path)
        .map_err(|error| format!("Failed to read XMP sidecar metadata: {error}"))?;
    if sidecar_metadata.len() > MAX_XMP_SIDECAR_BYTES {
        return Err("XMP sidecar is too large to read safely".to_string());
    }

    let file = fs::File::open(&sidecar_path)
        .map_err(|error| format!("Failed to open XMP sidecar: {error}"))?;
    read_xmp_sidecar_from_file(
        sidecar_path.file_name().and_then(|value| value.to_str()).unwrap_or("sidecar.xmp"),
        file,
    )
}

fn read_xmp_sidecar_from_file(
    file_name: &str,
    mut file: fs::File,
) -> Result<Option<ExifData>, String> {
    let metadata =
        file.metadata().map_err(|error| format!("Failed to read XMP sidecar metadata: {error}"))?;
    if metadata.len() > MAX_XMP_SIDECAR_BYTES {
        return Err("XMP sidecar is too large to read safely".to_string());
    }
    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|error| format!("Failed to seek XMP sidecar: {error}"))?;
    let mut xmp = String::new();
    file.take(MAX_XMP_SIDECAR_BYTES + 1)
        .read_to_string(&mut xmp)
        .map_err(|error| format!("Failed to read XMP sidecar: {error}"))?;
    let mut data = empty_exif_data();
    data.raw.insert("XMP Sidecar".to_string(), file_name.to_string());

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

#[cfg(test)]
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
mod resource_policy_tests {
    use super::*;

    #[test]
    fn oversized_exif_source_is_rejected_before_parser_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.jpg");
        let limits = crate::image_resource_policy::PolicyLimits::for_operation(
            crate::image_resource_policy::OperationClass::MetadataOnly,
        );
        let file = fs::File::create(&path).unwrap();
        file.set_len(limits.max_file_size_bytes + 1).unwrap();
        drop(file);

        let error =
            match get_exif_metadata_from_authorized_files(fs::File::open(path).unwrap(), None) {
                Ok(_) => panic!("oversized EXIF source unexpectedly reached the parser"),
                Err(error) => error,
            };
        assert!(error.contains("EXIF source rejected"));
        assert!(error.contains("exceeds maximum limit"));
    }
}

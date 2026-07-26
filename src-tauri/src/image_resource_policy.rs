use std::fs;
use std::path::Path;

/// Operation classes for native decode and image operations
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationClass {
    MetadataOnly,
    Thumbnail,
    Preview,
    Tile,
    Clipboard,
    Rotate,
    Crop,
    Overwrite,
    ScaledExport,
}

/// Limits configured for resource protection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyLimits {
    pub max_file_size_bytes: u64,
    pub max_single_dimension: u32,
    pub max_source_pixels: u64,
    pub max_output_dimension: u32,
    pub max_working_memory_bytes: u64,
}

impl PolicyLimits {
    pub fn for_operation(op: OperationClass) -> Self {
        match op {
            OperationClass::MetadataOnly => PolicyLimits {
                max_file_size_bytes: 1_073_741_824, // 1 GB
                max_single_dimension: 65_535,
                max_source_pixels: 500_000_000,
                max_output_dimension: 65_535,
                max_working_memory_bytes: 100_000_000,
            },
            OperationClass::Thumbnail => PolicyLimits {
                max_file_size_bytes: 524_288_000, // 500 MB
                max_single_dimension: 32_768,
                max_source_pixels: 250_000_000, // 250 MP
                max_output_dimension: 2_048,
                max_working_memory_bytes: 524_288_000,
            },
            OperationClass::Preview => PolicyLimits {
                max_file_size_bytes: 524_288_000,
                max_single_dimension: 32_768,
                max_source_pixels: 250_000_000,
                max_output_dimension: 8_192,
                max_working_memory_bytes: 1_073_741_824, // 1 GB
            },
            OperationClass::Tile => PolicyLimits {
                max_file_size_bytes: 524_288_000,
                max_single_dimension: 65_535,
                max_source_pixels: 500_000_000,
                max_output_dimension: 4_096,
                max_working_memory_bytes: 524_288_000,
            },
            OperationClass::Clipboard
            | OperationClass::Rotate
            | OperationClass::Crop
            | OperationClass::Overwrite => PolicyLimits {
                max_file_size_bytes: 524_288_000,
                max_single_dimension: 32_768,
                max_source_pixels: 160_000_000, // 160 MP max for in-memory edit operations
                max_output_dimension: 32_768,
                max_working_memory_bytes: 1_500_000_000, // 1.5 GB
            },
            OperationClass::ScaledExport => PolicyLimits {
                max_file_size_bytes: 524_288_000,
                max_single_dimension: 32_768,
                max_source_pixels: 160_000_000,
                max_output_dimension: 16_384,
                max_working_memory_bytes: 1_500_000_000,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourcePolicyError {
    ZeroDimensions,
    DimensionOverflow,
    SingleDimensionExceedsLimit { dimension: u32, max: u32 },
    TotalPixelsExceedLimit { total_pixels: u64, max: u64 },
    FileSizeExceedsLimit { file_size_bytes: u64, max: u64 },
    EstimatedMemoryExceedsLimit { estimated_bytes: u64, max: u64 },
    InvalidOutputDimension { dimension: u32, max: u32 },
    OperationExceedsLimit { operation: &'static str, reason: String },
}

impl std::fmt::Display for ResourcePolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResourcePolicyError::ZeroDimensions => {
                write!(f, "Image dimensions must be greater than zero.")
            }
            ResourcePolicyError::DimensionOverflow => {
                write!(f, "Image dimensions overflow maximum calculable size.")
            }
            ResourcePolicyError::SingleDimensionExceedsLimit { dimension, max } => {
                write!(f, "Dimension {} exceeds safe limit of {}.", dimension, max)
            }
            ResourcePolicyError::TotalPixelsExceedLimit { total_pixels, max } => {
                write!(f, "Image total pixels ({}) exceeds safe ceiling of {}.", total_pixels, max)
            }
            ResourcePolicyError::FileSizeExceedsLimit { file_size_bytes, max } => {
                write!(
                    f,
                    "File size ({} bytes) exceeds maximum limit of {} bytes.",
                    file_size_bytes, max
                )
            }
            ResourcePolicyError::EstimatedMemoryExceedsLimit { estimated_bytes, max } => {
                write!(
                    f,
                    "Estimated memory footprint ({} bytes) exceeds safety budget of {} bytes.",
                    estimated_bytes, max
                )
            }
            ResourcePolicyError::InvalidOutputDimension { dimension, max } => {
                write!(f, "Requested output dimension {} exceeds limit of {}.", dimension, max)
            }
            ResourcePolicyError::OperationExceedsLimit { operation, reason } => {
                write!(f, "Operation '{}' rejected: {}", operation, reason)
            }
        }
    }
}

impl std::error::Error for ResourcePolicyError {}

/// Check if dimensions are non-zero, within single dimension limits, and within total pixel limits.
pub fn validate_dimensions(
    width: u32,
    height: u32,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    if width == 0 || height == 0 {
        return Err(ResourcePolicyError::ZeroDimensions);
    }
    if width > limits.max_single_dimension {
        return Err(ResourcePolicyError::SingleDimensionExceedsLimit {
            dimension: width,
            max: limits.max_single_dimension,
        });
    }
    if height > limits.max_single_dimension {
        return Err(ResourcePolicyError::SingleDimensionExceedsLimit {
            dimension: height,
            max: limits.max_single_dimension,
        });
    }

    let pixels =
        (width as u64).checked_mul(height as u64).ok_or(ResourcePolicyError::DimensionOverflow)?;

    if pixels > limits.max_source_pixels {
        return Err(ResourcePolicyError::TotalPixelsExceedLimit {
            total_pixels: pixels,
            max: limits.max_source_pixels,
        });
    }

    Ok(pixels)
}

/// Validate file size against limits
pub fn validate_file_size(
    file_path: &Path,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    let metadata =
        fs::metadata(file_path).map_err(|_| ResourcePolicyError::OperationExceedsLimit {
            operation: "file_access",
            reason: "Unable to inspect file metadata".to_string(),
        })?;
    let size = metadata.len();
    if size > limits.max_file_size_bytes {
        return Err(ResourcePolicyError::FileSizeExceedsLimit {
            file_size_bytes: size,
            max: limits.max_file_size_bytes,
        });
    }
    Ok(size)
}

/// Calculate estimated memory using checked arithmetic
pub fn calculate_checked_buffer_bytes(
    width: u32,
    height: u32,
    bytes_per_pixel: u64,
    buffer_count: u64,
) -> Result<u64, ResourcePolicyError> {
    let pixels =
        (width as u64).checked_mul(height as u64).ok_or(ResourcePolicyError::DimensionOverflow)?;

    pixels
        .checked_mul(bytes_per_pixel)
        .and_then(|bytes| bytes.checked_mul(buffer_count))
        .ok_or(ResourcePolicyError::DimensionOverflow)
}

/// Validate memory footprint for an operation
pub fn validate_memory_footprint(
    width: u32,
    height: u32,
    bytes_per_pixel: u64,
    buffer_count: u64,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    let estimated = calculate_checked_buffer_bytes(width, height, bytes_per_pixel, buffer_count)?;
    if estimated > limits.max_working_memory_bytes {
        return Err(ResourcePolicyError::EstimatedMemoryExceedsLimit {
            estimated_bytes: estimated,
            max: limits.max_working_memory_bytes,
        });
    }
    Ok(estimated)
}

/// Pre-flight validate decode for an image operation
pub fn validate_decode(
    file_path: &Path,
    width: u32,
    height: u32,
    op: OperationClass,
) -> Result<(), ResourcePolicyError> {
    let limits = PolicyLimits::for_operation(op);
    if file_path.exists() {
        validate_file_size(file_path, &limits)?;
    }
    validate_dimensions(width, height, &limits)?;
    validate_memory_footprint(width, height, 4, 3, &limits)?;
    Ok(())
}

/// Validate requested output dimension (e.g., preview max_dimension or scale output)
pub fn validate_requested_output_dimension(
    dim: u32,
    limits: &PolicyLimits,
) -> Result<(), ResourcePolicyError> {
    if dim == 0 {
        return Err(ResourcePolicyError::ZeroDimensions);
    }
    if dim > limits.max_output_dimension {
        return Err(ResourcePolicyError::InvalidOutputDimension {
            dimension: dim,
            max: limits.max_output_dimension,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_dimensions_rejected() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert_eq!(validate_dimensions(0, 100, &limits), Err(ResourcePolicyError::ZeroDimensions));
        assert_eq!(validate_dimensions(100, 0, &limits), Err(ResourcePolicyError::ZeroDimensions));
    }

    #[test]
    fn test_single_dimension_exceeds_limit() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert!(matches!(
            validate_dimensions(32_769, 100, &limits),
            Err(ResourcePolicyError::SingleDimensionExceedsLimit { .. })
        ));
    }

    #[test]
    fn test_total_pixels_exceeds_limit() {
        let limits = PolicyLimits::for_operation(OperationClass::Crop);
        // 13_000 * 13_000 = 169,000,000 > 160,000,000
        assert!(matches!(
            validate_dimensions(13_000, 13_000, &limits),
            Err(ResourcePolicyError::TotalPixelsExceedLimit { .. })
        ));
    }

    #[test]
    fn test_checked_buffer_overflow() {
        assert_eq!(
            calculate_checked_buffer_bytes(u32::MAX, u32::MAX, 4, 3),
            Err(ResourcePolicyError::DimensionOverflow)
        );
    }

    #[test]
    fn test_valid_dimensions_pass() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert_eq!(validate_dimensions(1920, 1080, &limits), Ok(2_073_600));
    }
}

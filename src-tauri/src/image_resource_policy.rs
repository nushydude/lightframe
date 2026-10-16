//! Backend resource limits for image and metadata work.
//!
//! The policy is intentionally independent of the frontend and of any executor.  Callers first
//! inspect encoded bytes and dimensions, then validate the allocation they are about to perform.

use std::fs;
use std::io::{BufReader, Read, Seek};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const ABSOLUTE_MAX_INPUT_BYTES: u64 = 1024 * 1024 * 1024;
pub const ABSOLUTE_MAX_DIMENSION: u32 = 65_535;
pub const ABSOLUTE_MAX_SOURCE_PIXELS: u64 = 500_000_000;
pub const ABSOLUTE_MAX_OUTPUT_PIXELS: u64 = 160_000_000;
pub const ABSOLUTE_MAX_WORKING_BYTES: u64 = 1_500 * 1024 * 1024;

static POLICY_REJECTION_COUNT: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
type BeforeSourceOpenHook = Box<dyn FnOnce(&Path)>;
#[cfg(test)]
thread_local! {
    static BEFORE_SOURCE_OPEN: std::cell::RefCell<Option<BeforeSourceOpenHook>> = const { std::cell::RefCell::new(None) };
    pub static DECODER_STARTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub static SOURCE_RESERVATIONS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(all(test, windows))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PublicationStage {
    OriginalMoved,
    BeforeRollback,
    BeforeCleanup,
}
#[cfg(all(test, windows))]
type PublicationHook = Box<dyn FnMut(PublicationStage, &Path, &Path) -> bool>;
#[cfg(all(test, windows))]
thread_local! {
    static PUBLICATION_HOOK: std::cell::RefCell<Option<PublicationHook>> = const { std::cell::RefCell::new(None) };
    pub static PUBLICATION_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    pub static ROLLBACK_ATTEMPTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(all(test, windows))]
pub fn set_publication_hook(hook: impl FnMut(PublicationStage, &Path, &Path) -> bool + 'static) {
    PUBLICATION_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}
#[cfg(all(test, windows))]
fn publication_hook(stage: PublicationStage, destination: &Path, backup: &Path) -> bool {
    PUBLICATION_HOOK.with(|slot| {
        slot.borrow_mut().as_mut().is_some_and(|hook| hook(stage, destination, backup))
    })
}
#[cfg(all(test, windows))]
pub fn clear_publication_hook() {
    PUBLICATION_HOOK.with(|slot| *slot.borrow_mut() = None);
}
#[cfg(test)]
pub fn before_next_source_open(hook: impl FnOnce(&Path) + 'static) {
    BEFORE_SOURCE_OPEN.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

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

impl OperationClass {
    pub const fn label(self) -> &'static str {
        match self {
            Self::MetadataOnly => "metadata",
            Self::Thumbnail => "thumbnail",
            Self::Preview => "preview",
            Self::Tile => "tile",
            Self::Clipboard => "clipboard",
            Self::Rotate => "rotate",
            Self::Crop => "crop",
            Self::Overwrite => "overwrite",
            Self::ScaledExport => "scaled export",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyLimits {
    pub max_input_bytes: u64,
    pub max_dimension: u32,
    pub max_source_pixels: u64,
    pub max_output_dimension: u32,
    pub max_output_pixels: u64,
    pub max_working_bytes: u64,
    pub max_metadata_bytes: u64,
}

impl PolicyLimits {
    pub const fn for_operation(operation: OperationClass) -> Self {
        match operation {
            OperationClass::MetadataOnly => Self {
                max_input_bytes: ABSOLUTE_MAX_INPUT_BYTES,
                max_dimension: ABSOLUTE_MAX_DIMENSION,
                max_source_pixels: ABSOLUTE_MAX_SOURCE_PIXELS,
                max_output_dimension: ABSOLUTE_MAX_DIMENSION,
                max_output_pixels: ABSOLUTE_MAX_SOURCE_PIXELS,
                max_working_bytes: 128 * 1024 * 1024,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
            OperationClass::Thumbnail => Self {
                max_input_bytes: 512 * 1024 * 1024,
                max_dimension: ABSOLUTE_MAX_DIMENSION,
                max_source_pixels: 125_000_000,
                max_output_dimension: 2_048,
                max_output_pixels: 4_194_304,
                max_working_bytes: 512 * 1024 * 1024,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
            OperationClass::Preview => Self {
                max_input_bytes: 512 * 1024 * 1024,
                max_dimension: ABSOLUTE_MAX_DIMENSION,
                max_source_pixels: 250_000_000,
                max_output_dimension: 8_192,
                max_output_pixels: 67_108_864,
                max_working_bytes: 1_024 * 1024 * 1024,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
            OperationClass::Tile => Self {
                max_input_bytes: 512 * 1024 * 1024,
                max_dimension: ABSOLUTE_MAX_DIMENSION,
                max_source_pixels: ABSOLUTE_MAX_SOURCE_PIXELS,
                max_output_dimension: 4_096,
                max_output_pixels: 16_777_216,
                max_working_bytes: 512 * 1024 * 1024,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
            OperationClass::Clipboard
            | OperationClass::Rotate
            | OperationClass::Crop
            | OperationClass::Overwrite => Self {
                max_input_bytes: 512 * 1024 * 1024,
                max_dimension: 32_768,
                max_source_pixels: 160_000_000,
                max_output_dimension: 32_768,
                max_output_pixels: 160_000_000,
                max_working_bytes: ABSOLUTE_MAX_WORKING_BYTES,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
            OperationClass::ScaledExport => Self {
                max_input_bytes: 512 * 1024 * 1024,
                max_dimension: 65_535,
                max_source_pixels: 160_000_000,
                max_output_dimension: 65_535,
                max_output_pixels: 50_000_000,
                max_working_bytes: 800 * 1024 * 1024,
                max_metadata_bytes: 8 * 1024 * 1024,
            },
        }
    }

    /// Performance mode may lower a working budget, but never raises a security ceiling.
    pub fn for_operation_with_performance(
        operation: OperationClass,
        performance_mode: &str,
    ) -> Self {
        let mut limits = Self::for_operation(operation);
        if matches!(performance_mode, "lowMemory" | "low_memory") {
            limits.max_working_bytes /= 2;
        }
        limits
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourcePolicyError {
    FileMetadataUnavailable,
    SourceUnavailableOrChanged,
    ZeroDimensions,
    DimensionExceedsLimit { dimension: u32, max: u32 },
    PixelCountOverflow,
    SourcePixelsExceedLimit { pixels: u64, max: u64 },
    InputBytesExceedLimit { bytes: u64, max: u64 },
    MetadataBytesExceedLimit { bytes: u64, max: u64 },
    OutputDimensionExceedsLimit { dimension: u32, max: u32 },
    OutputPixelsExceedLimit { pixels: u64, max: u64 },
    AllocationOverflow,
    WorkingBytesExceedLimit { bytes: u64, max: u64 },
    AllocationTooLargeForPlatform,
}

impl std::fmt::Display for ResourcePolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceUnavailableOrChanged => {
                write!(f, "Image source is unavailable or changed; retry the operation.")
            }
            Self::FileMetadataUnavailable => write!(f, "Unable to inspect image metadata safely."),
            Self::ZeroDimensions => write!(f, "Image dimensions must be greater than zero."),
            Self::DimensionExceedsLimit { dimension, max } => {
                write!(f, "Image dimension {dimension} exceeds the safe limit of {max} pixels.")
            }
            Self::PixelCountOverflow | Self::AllocationOverflow => {
                write!(f, "Image resource size is too large to calculate safely.")
            }
            Self::SourcePixelsExceedLimit { pixels, max } => {
                write!(f, "Image pixel count ({pixels}) exceeds the safe limit of {max}.")
            }
            Self::InputBytesExceedLimit { bytes, max } => {
                write!(
                    f,
                    "Encoded image size ({bytes} bytes) exceeds the safe limit of {max} bytes."
                )
            }
            Self::MetadataBytesExceedLimit { bytes, max } => {
                write!(f, "Metadata payload ({bytes} bytes) exceeds the safe limit of {max} bytes.")
            }
            Self::OutputDimensionExceedsLimit { dimension, max } => {
                write!(f, "Requested output dimension {dimension} exceeds the safe limit of {max} pixels.")
            }
            Self::OutputPixelsExceedLimit { pixels, max } => {
                write!(
                    f,
                    "Requested output pixel count ({pixels}) exceeds the safe limit of {max}."
                )
            }
            Self::WorkingBytesExceedLimit { bytes, max } => {
                write!(f, "Estimated image working memory ({bytes} bytes) exceeds the safe limit of {max} bytes.")
            }
            Self::AllocationTooLargeForPlatform => {
                write!(f, "Image allocation is too large for this platform.")
            }
        }
    }
}

impl std::error::Error for ResourcePolicyError {}

/// A read lease denies writes and replacement on Windows, including through other handles.
/// WIC may open the filename for reading while this lease is alive. Rust decoders use this
/// very handle. No encoded-file copy is retained alongside decoded buffers.
pub struct ImageSource {
    file: fs::File,
    operation: OperationClass,
    metadata: fs::Metadata,
}

impl ImageSource {
    pub fn encoded_len(&self) -> u64 {
        self.metadata.len()
    }
    pub fn open(path: &Path, operation: OperationClass) -> Result<Self, ResourcePolicyError> {
        #[cfg(test)]
        BEFORE_SOURCE_OPEN.with(|slot| {
            if let Some(hook) = slot.borrow_mut().take() {
                hook(path);
            }
        });
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1); // FILE_SHARE_READ: no writer or replacement can coexist.
            if matches!(operation, OperationClass::Rotate | OperationClass::Overwrite) {
                options.access_mode(0x8000_0000 | 0x0001_0000); // GENERIC_READ | DELETE
            }
        }
        let file =
            options.open(path).map_err(|_| ResourcePolicyError::SourceUnavailableOrChanged)?;
        let metadata = file.metadata().map_err(|_| ResourcePolicyError::FileMetadataUnavailable)?;
        Self::from_opened_snapshot(file, metadata, operation)
    }

    fn from_opened_snapshot(
        file: fs::File,
        metadata: fs::Metadata,
        operation: OperationClass,
    ) -> Result<Self, ResourcePolicyError> {
        // Validate the very snapshot we retain; never fetch a second unvalidated length.
        validate_input_bytes(metadata.len(), &PolicyLimits::for_operation(operation))?;
        Ok(Self { file, operation, metadata })
    }

    pub fn reader(&self) -> Result<BufReader<BoundedSourceReader>, ResourcePolicyError> {
        validate_input_bytes(
            self.file.metadata().map_err(|_| ResourcePolicyError::FileMetadataUnavailable)?.len(),
            &PolicyLimits::for_operation(self.operation),
        )?;
        let mut file =
            self.file.try_clone().map_err(|_| ResourcePolicyError::SourceUnavailableOrChanged)?;
        file.rewind().map_err(|_| ResourcePolicyError::SourceUnavailableOrChanged)?;
        Ok(BufReader::new(BoundedSourceReader {
            file,
            operation: self.operation,
            metadata: self.metadata.clone(),
        }))
    }

    pub fn read_bytes(&self) -> Result<Vec<u8>, ResourcePolicyError> {
        validate_input_bytes(self.encoded_len(), &PolicyLimits::for_operation(self.operation))?;
        let mut reader = self.reader()?;
        let capacity = usize::try_from(self.encoded_len())
            .map_err(|_| ResourcePolicyError::AllocationTooLargeForPlatform)?;
        #[cfg(test)]
        SOURCE_RESERVATIONS.with(|count| count.set(count.get() + 1));
        // Exact snapshot length prevents read_to_end's growth/EOF probe from enlarging the
        // source allocation. Every actual read also checks the owned descriptor for changes.
        let mut bytes = vec![0; capacity];
        reader
            .read_exact(&mut bytes)
            .map_err(|_| ResourcePolicyError::SourceUnavailableOrChanged)?;
        Ok(bytes)
    }

    /// Rename the admitted original by its still-locked handle, then publish without replacing
    /// anything that another process might create at the now vacant name. The recovery file is
    /// retained if a concurrent creation prevents rollback; that new file is never overwritten.
    #[cfg(windows)]
    pub fn replace(self, temp: &Path, destination: &Path) -> Result<(), String> {
        use std::os::windows::fs::OpenOptionsExt;
        let edited = fs::OpenOptions::new()
            .read(true)
            .access_mode(0x8000_0000 | 0x0001_0000)
            .share_mode(1)
            .open(temp)
            .map_err(|_| "Unable to open edited image for publication".to_string())?;
        let backup =
            crate::atomic_file::build_unique_sibling_path(destination, "lightframe-source-backup")?;
        self.rename_handle(&backup)?;
        #[cfg(all(test, windows))]
        let force_failure = publication_hook(PublicationStage::OriginalMoved, destination, &backup);
        #[cfg(not(test))]
        let force_failure = false;
        #[cfg(all(test, windows))]
        PUBLICATION_ATTEMPTS.with(|count| count.set(count.get() + 1));
        let published = if force_failure {
            Err("Injected publication failure".to_string())
        } else {
            Self::rename_file_handle(&edited, destination)
        };
        if let Err(error) = published {
            #[cfg(all(test, windows))]
            {
                publication_hook(PublicationStage::BeforeRollback, destination, &backup);
                ROLLBACK_ATTEMPTS.with(|count| count.set(count.get() + 1));
            }
            let restored = self.rename_handle(destination);
            return Err(format!(
                "Failed to publish edited image: {error}; original recovery: {}",
                if restored.is_ok() {
                    "restored".to_string()
                } else {
                    backup.display().to_string()
                }
            ));
        }
        // Publication is the commit point. Cleanup must neither change the saved result into
        // an error nor delete by a name that another process could replace after lease release.
        #[cfg(all(test, windows))]
        let skip_cleanup = publication_hook(PublicationStage::BeforeCleanup, destination, &backup);
        #[cfg(not(test))]
        let skip_cleanup = false;
        if skip_cleanup || self.delete_original_on_close().is_err() {
            eprintln!("Edited image saved; recovery cleanup failed and the original recovery file was retained.");
        }
        Ok(())
    }

    #[cfg(windows)]
    fn rename_handle(&self, path: &Path) -> Result<(), String> {
        Self::rename_file_handle(&self.file, path)
    }

    #[cfg(windows)]
    fn delete_original_on_close(&self) -> Result<(), windows::core::Error> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            },
        };
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // This addresses the admitted original by handle while the no-delete-sharing lease
        // still holds. Closing that handle removes only that object, never a concurrent name.
        unsafe {
            SetFileInformationByHandle(
                HANDLE(self.file.as_raw_handle()),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        }
    }

    #[cfg(windows)]
    fn rename_file_handle(file: &fs::File, path: &Path) -> Result<(), String> {
        use std::os::windows::{ffi::OsStrExt, io::AsRawHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO},
        };
        let name: Vec<u16> = std::path::absolute(path)
            .map_err(|_| "Unable to resolve edited image destination")?
            .as_os_str()
            .encode_wide()
            .collect();
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let size = offset + name.len() * 2;
        // Allocate aligned storage for the variable-length FILE_RENAME_INFO structure.
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            // Explicit for both publication and rollback: a destination collision must fail.
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                name.len(),
            );
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileRenameInfo,
                info.cast(),
                size as u32,
            )
        }
        .map_err(|_| "Unable to move the admitted original safely".to_string())
    }

    #[cfg(not(windows))]
    pub fn replace(self, temp: &Path, destination: &Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        let current = fs::metadata(destination)
            .map_err(|_| ResourcePolicyError::SourceUnavailableOrChanged.to_string())?;
        if current.dev() != self.metadata.dev()
            || current.ino() != self.metadata.ino()
            || current.len() != self.metadata.len()
            || current.modified().ok() != self.metadata.modified().ok()
        {
            record_rejection(self.operation);
            return Err(ResourcePolicyError::SourceUnavailableOrChanged.to_string());
        }
        // POSIX rename has no portable compare-and-replace primitive. Retain the existing
        // atomic publication after identity verification; concurrent hostile directory mutation
        // in the final syscall interval remains a path-authority concern (Task 51).
        crate::atomic_file::replace_file_safely(temp, destination)
    }
}

pub struct BoundedSourceReader {
    file: fs::File,
    operation: OperationClass,
    metadata: fs::Metadata,
}
impl Read for BoundedSourceReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let current = self.file.metadata()?;
        let check =
            validate_input_bytes(current.len(), &PolicyLimits::for_operation(self.operation))
                .and_then(|_| {
                    if current.len() != self.metadata.len()
                        || current.modified().ok() != self.metadata.modified().ok()
                    {
                        Err(ResourcePolicyError::SourceUnavailableOrChanged)
                    } else {
                        Ok(())
                    }
                });
        check.map_err(|error| {
            record_rejection(self.operation);
            std::io::Error::other(error)
        })?;
        self.file.read(buffer)
    }
}
impl Seek for BoundedSourceReader {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.file.seek(position)
    }
}

pub fn decoder_for_source(
    source: &ImageSource,
    operation: OperationClass,
) -> Result<impl image::ImageDecoder, image::ImageError> {
    #[cfg(test)]
    DECODER_STARTS.with(|count| count.set(count.get() + 1));
    let mut reader = image::ImageReader::new(
        source
            .reader()
            .map_err(|error| image::ImageError::IoError(std::io::Error::other(error)))?,
    )
    .with_guessed_format()?;
    let policy = PolicyLimits::for_operation(operation);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(policy.max_dimension);
    limits.max_image_height = Some(policy.max_dimension);
    limits.max_alloc = Some(policy.max_working_bytes);
    reader.limits(limits);
    reader.into_decoder()
}

pub fn checked_pixel_count(width: u64, height: u64) -> Result<u64, ResourcePolicyError> {
    width.checked_mul(height).ok_or(ResourcePolicyError::PixelCountOverflow)
}

pub fn checked_allocation_bytes(
    width: u64,
    height: u64,
    bytes_per_pixel: u64,
    buffer_count: u64,
) -> Result<u64, ResourcePolicyError> {
    checked_pixel_count(width, height)?
        .checked_mul(bytes_per_pixel)
        .and_then(|bytes| bytes.checked_mul(buffer_count))
        .ok_or(ResourcePolicyError::AllocationOverflow)
}

pub fn validate_dimensions(
    width: u32,
    height: u32,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    if width == 0 || height == 0 {
        return Err(ResourcePolicyError::ZeroDimensions);
    }
    if width > limits.max_dimension {
        return Err(ResourcePolicyError::DimensionExceedsLimit {
            dimension: width,
            max: limits.max_dimension,
        });
    }
    if height > limits.max_dimension {
        return Err(ResourcePolicyError::DimensionExceedsLimit {
            dimension: height,
            max: limits.max_dimension,
        });
    }

    let pixels = checked_pixel_count(u64::from(width), u64::from(height))?;
    if pixels > limits.max_source_pixels {
        return Err(ResourcePolicyError::SourcePixelsExceedLimit {
            pixels,
            max: limits.max_source_pixels,
        });
    }
    Ok(pixels)
}

pub fn validate_output_dimensions(
    width: u32,
    height: u32,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    if width == 0 || height == 0 {
        return Err(ResourcePolicyError::ZeroDimensions);
    }
    if width > limits.max_output_dimension {
        return Err(ResourcePolicyError::OutputDimensionExceedsLimit {
            dimension: width,
            max: limits.max_output_dimension,
        });
    }
    if height > limits.max_output_dimension {
        return Err(ResourcePolicyError::OutputDimensionExceedsLimit {
            dimension: height,
            max: limits.max_output_dimension,
        });
    }
    let pixels = checked_pixel_count(u64::from(width), u64::from(height))?;
    if pixels > limits.max_output_pixels {
        return Err(ResourcePolicyError::OutputPixelsExceedLimit {
            pixels,
            max: limits.max_output_pixels,
        });
    }
    Ok(pixels)
}

pub fn validate_input_bytes(bytes: u64, limits: &PolicyLimits) -> Result<u64, ResourcePolicyError> {
    if bytes > limits.max_input_bytes {
        return Err(ResourcePolicyError::InputBytesExceedLimit {
            bytes,
            max: limits.max_input_bytes,
        });
    }
    Ok(bytes)
}

pub fn validate_metadata_bytes(
    bytes: u64,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    if bytes > limits.max_metadata_bytes {
        return Err(ResourcePolicyError::MetadataBytesExceedLimit {
            bytes,
            max: limits.max_metadata_bytes,
        });
    }
    Ok(bytes)
}

pub fn validate_file_size(
    file_path: &Path,
    operation: OperationClass,
) -> Result<u64, ResourcePolicyError> {
    let metadata =
        fs::metadata(file_path).map_err(|_| ResourcePolicyError::FileMetadataUnavailable)?;
    validate_input_bytes(metadata.len(), &PolicyLimits::for_operation(operation))
}

pub fn validate_working_memory(
    width: u32,
    height: u32,
    bytes_per_pixel: u64,
    buffer_count: u64,
    limits: &PolicyLimits,
) -> Result<u64, ResourcePolicyError> {
    let bytes = checked_allocation_bytes(
        u64::from(width),
        u64::from(height),
        bytes_per_pixel,
        buffer_count,
    )?;
    if bytes > limits.max_working_bytes {
        return Err(ResourcePolicyError::WorkingBytesExceedLimit {
            bytes,
            max: limits.max_working_bytes,
        });
    }
    Ok(bytes)
}

/// Validate the decoder's actual output buffer together with the duplicate/converted buffers
/// used by generic `DynamicImage` paths. Decoder `max_alloc` limits the decoder-owned buffer, but
/// cannot account for orientation, RGBA conversion, or the retained source image.
pub fn validate_decoder_memory(
    width: u32,
    height: u32,
    decoder_bytes: u64,
    operation: OperationClass,
) -> Result<u64, ResourcePolicyError> {
    let limits = PolicyLimits::for_operation(operation);
    validate_dimensions(width, height, &limits)?;
    // Include retained samples, same-format rotation, decoder scratch, RGBA8 crop/conversion
    // and encoder scratch. DynamicImage's GenericImageView pixel is Rgba<u8>.
    let edit = matches!(
        operation,
        OperationClass::Clipboard
            | OperationClass::Rotate
            | OperationClass::Crop
            | OperationClass::Overwrite
    );
    let converted_bytes = checked_allocation_bytes(u64::from(width), u64::from(height), 8, 1)?;
    let aggregate_bytes = decoder_bytes
        .checked_mul(if edit { 3 } else { 2 })
        .and_then(|bytes| bytes.checked_add(converted_bytes))
        .ok_or(ResourcePolicyError::AllocationOverflow)?;
    if aggregate_bytes > limits.max_working_bytes {
        return Err(ResourcePolicyError::WorkingBytesExceedLimit {
            bytes: aggregate_bytes,
            max: limits.max_working_bytes,
        });
    }
    Ok(aggregate_bytes)
}

pub fn validate_export_memory(
    source_width: u32,
    source_height: u32,
    decoder_bytes: u64,
    sample_bytes: u64,
    width: u32,
    height: u32,
    adjustments: (bool, bool),
) -> Result<u64, ResourcePolicyError> {
    let limits = PolicyLimits::for_operation(OperationClass::ScaledExport);
    validate_dimensions(source_width, source_height, &limits)?;
    validate_output_dimensions(width, height, &limits)?;
    // Same-format retained source/output, decoder and encoder scratch; resize's vertical pass
    // allocates source_width * output_height RGBA32F. Blur/unsharpen additionally reserve two
    // floating-point filter buffers at the dimensions where each adjustment runs.
    let output = checked_allocation_bytes(width.into(), height.into(), sample_bytes.max(4), 3)?;
    let intermediate = checked_allocation_bytes(source_width.into(), height.into(), 16, 1)?;
    let blur = if adjustments.0 {
        checked_allocation_bytes(source_width.into(), source_height.into(), 32, 1)?
    } else {
        0
    };
    let sharpen = if adjustments.1 {
        checked_allocation_bytes(width.into(), height.into(), 32, 1)?
    } else {
        0
    };
    let bytes = decoder_bytes
        .checked_mul(3)
        .and_then(|n| n.checked_add(output))
        .and_then(|n| n.checked_add(intermediate))
        .and_then(|n| n.checked_add(blur))
        .and_then(|n| n.checked_add(sharpen))
        .ok_or(ResourcePolicyError::AllocationOverflow)?;
    if bytes > limits.max_working_bytes {
        return Err(ResourcePolicyError::WorkingBytesExceedLimit {
            bytes,
            max: limits.max_working_bytes,
        });
    }
    Ok(bytes)
}

pub fn validate_lossless_rotation_memory(
    width: u32,
    height: u32,
    encoded_bytes: u64,
) -> Result<(), ResourcePolicyError> {
    let scratch = checked_allocation_bytes(width.into(), height.into(), 24, 1)?;
    let bytes = encoded_bytes
        .checked_mul(3)
        .and_then(|n| n.checked_add(scratch))
        .ok_or(ResourcePolicyError::AllocationOverflow)?;
    let max = PolicyLimits::for_operation(OperationClass::Rotate).max_working_bytes;
    if bytes > max {
        return Err(ResourcePolicyError::WorkingBytesExceedLimit { bytes, max });
    }
    Ok(())
}

pub fn validate_allocation_for_operation(
    width: u32,
    height: u32,
    bytes_per_pixel: u64,
    buffer_count: u64,
    operation: OperationClass,
) -> Result<usize, ResourcePolicyError> {
    let limits = PolicyLimits::for_operation(operation);
    let bytes = validate_working_memory(width, height, bytes_per_pixel, buffer_count, &limits)?;
    usize::try_from(bytes).map_err(|_| ResourcePolicyError::AllocationTooLargeForPlatform)
}

pub fn validate_requested_dimension(
    dimension: u32,
    operation: OperationClass,
) -> Result<(), ResourcePolicyError> {
    let limits = PolicyLimits::for_operation(operation);
    if dimension == 0 {
        return Err(ResourcePolicyError::ZeroDimensions);
    }
    if dimension > limits.max_output_dimension {
        return Err(ResourcePolicyError::OutputDimensionExceedsLimit {
            dimension,
            max: limits.max_output_dimension,
        });
    }
    Ok(())
}

pub fn record_rejection(_operation: OperationClass) {
    POLICY_REJECTION_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn rejection_count() -> usize {
    POLICY_REJECTION_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_open_snapshot_over_limit_is_rejected_before_reservation_or_decoder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("growing.bin");
        let file = fs::File::create(&path).unwrap();
        let operation = OperationClass::Preview;
        let max = PolicyLimits::for_operation(operation).max_input_bytes;
        // Exercise the shared post-open constructor directly on every OS, including POSIX:
        // a writer has grown this opened file before the admitted snapshot is obtained.
        file.set_len(max + 1).unwrap();
        let snapshot = file.metadata().unwrap();
        let reservations = SOURCE_RESERVATIONS.with(|count| count.get());
        let decoders = DECODER_STARTS.with(|count| count.get());
        assert!(matches!(
            ImageSource::from_opened_snapshot(file, snapshot, operation),
            Err(ResourcePolicyError::InputBytesExceedLimit { .. })
        ));
        assert_eq!(SOURCE_RESERVATIONS.with(|count| count.get()), reservations);
        assert_eq!(DECODER_STARTS.with(|count| count.get()), decoders);
    }

    #[test]
    fn encoded_read_reserves_only_the_admitted_snapshot_length() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.bin");
        fs::write(&path, vec![42u8; 4096]).unwrap();
        let source = ImageSource::open(&path, OperationClass::Preview).unwrap();
        let bytes = source.read_bytes().unwrap();
        assert_eq!(bytes, vec![42u8; 4096]);
        assert_eq!(bytes.capacity(), 4096);
    }

    #[test]
    fn float_sample_buffers_cross_aggregate_boundary_before_single_buffer_limit() {
        for sample_bytes in [12, 16] {
            let pixels = 40_000_000;
            let decoded = pixels * sample_bytes;
            assert!(decoded < PolicyLimits::for_operation(OperationClass::Crop).max_working_bytes);
            assert!(matches!(
                validate_decoder_memory(8000, 5000, decoded, OperationClass::Crop),
                Err(ResourcePolicyError::WorkingBytesExceedLimit { .. })
            ));
            assert!(matches!(
                validate_export_memory(8000, 5000, decoded, sample_bytes, 640, 480, (false, false)),
                Err(ResourcePolicyError::WorkingBytesExceedLimit { .. })
            ));
            assert!(validate_decoder_memory(32, 24, 32 * 24 * sample_bytes, OperationClass::Crop)
                .is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn source_lease_denies_growth_and_replacement_until_decode_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.png");
        image::RgbImage::new(2, 2).save(&path).unwrap();
        let source = ImageSource::open(&path, OperationClass::Preview).unwrap();
        let decoder = decoder_for_source(&source, OperationClass::Preview).unwrap();
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::rename(&path, dir.path().join("other.png")).is_err());
        assert_eq!(image::DynamicImage::from_decoder(decoder).unwrap().width(), 2);
        drop(source);
        assert!(fs::OpenOptions::new().write(true).open(&path).is_ok());
    }

    #[test]
    fn rejects_zero_and_oversized_dimensions() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert_eq!(validate_dimensions(0, 1, &limits), Err(ResourcePolicyError::ZeroDimensions));
        assert!(matches!(
            validate_dimensions(limits.max_dimension + 1, 1, &limits),
            Err(ResourcePolicyError::DimensionExceedsLimit { .. })
        ));
    }

    #[test]
    fn rejects_pixel_budget_with_legal_dimensions() {
        let limits = PolicyLimits::for_operation(OperationClass::Crop);
        assert!(matches!(
            validate_dimensions(13_000, 13_000, &limits),
            Err(ResourcePolicyError::SourcePixelsExceedLimit { .. })
        ));
    }

    #[test]
    fn checked_arithmetic_rejects_overflow_before_cast() {
        assert_eq!(checked_pixel_count(u64::MAX, 2), Err(ResourcePolicyError::PixelCountOverflow));
        assert_eq!(
            checked_allocation_bytes(1, 1, u64::MAX, 2),
            Err(ResourcePolicyError::AllocationOverflow)
        );
    }

    #[test]
    fn output_and_input_limits_are_checked() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert!(matches!(
            validate_output_dimensions(8_193, 1, &limits),
            Err(ResourcePolicyError::OutputDimensionExceedsLimit { .. })
        ));
        assert!(matches!(
            validate_input_bytes(limits.max_input_bytes + 1, &limits),
            Err(ResourcePolicyError::InputBytesExceedLimit { .. })
        ));
    }

    #[test]
    fn performance_mode_only_reduces_working_budget() {
        let normal = PolicyLimits::for_operation(OperationClass::Preview);
        let low_memory =
            PolicyLimits::for_operation_with_performance(OperationClass::Preview, "lowMemory");
        assert_eq!(normal.max_input_bytes, low_memory.max_input_bytes);
        assert_eq!(normal.max_dimension, low_memory.max_dimension);
        assert!(low_memory.max_working_bytes < normal.max_working_bytes);
    }

    #[test]
    fn accepts_values_at_operation_boundaries() {
        let limits = PolicyLimits::for_operation(OperationClass::Preview);
        assert!(validate_dimensions(limits.max_dimension, 1, &limits).is_ok());
        assert!(validate_output_dimensions(limits.max_output_dimension, 1, &limits).is_ok());
        assert!(validate_input_bytes(limits.max_input_bytes, &limits).is_ok());
        assert!(validate_working_memory(1, 1, limits.max_working_bytes, 1, &limits).is_ok());
    }

    #[test]
    fn actual_decoder_bytes_are_aggregated_for_float_and_ordinary_images() {
        let ordinary =
            validate_decoder_memory(6_000, 4_000, 6_000 * 4_000 * 3, OperationClass::Thumbnail);
        assert!(ordinary.is_ok());

        let float_rgba =
            validate_decoder_memory(6_000, 4_000, 6_000 * 4_000 * 16, OperationClass::Thumbnail);
        assert!(matches!(float_rgba, Err(ResourcePolicyError::WorkingBytesExceedLimit { .. })));
    }
}

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodecBackend {
    RustImage,
    WindowsNative,
    BrowserRenderable,
    Unsupported,
}

impl CodecBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RustImage => "rust_image",
            Self::WindowsNative => "windows_native",
            Self::BrowserRenderable => "browser_renderable",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodecCapability {
    pub metadata: CodecBackend,
    pub metadata_fallback: Option<CodecBackend>,
    pub thumbnail: CodecBackend,
    pub detail: CodecBackend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeImageMetadata {
    pub width: u32,
    pub height: u32,
    pub format: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeImageRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub fn codec_capability_for_extension(extension: &str) -> CodecCapability {
    match extension.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => CodecCapability {
            metadata: CodecBackend::RustImage,
            metadata_fallback: None,
            thumbnail: CodecBackend::RustImage,
            detail: CodecBackend::RustImage,
        },
        "png" | "webp" | "gif" | "bmp" | "tiff" | "tif" | "avif" => CodecCapability {
            metadata: CodecBackend::RustImage,
            metadata_fallback: None,
            thumbnail: CodecBackend::RustImage,
            detail: CodecBackend::Unsupported,
        },
        "heic" | "heif" => CodecCapability {
            metadata: native_backend_or_browser(),
            metadata_fallback: native_metadata_fallback(),
            thumbnail: native_backend_or_browser(),
            detail: native_detail_backend(),
        },
        "svg" => CodecCapability {
            metadata: CodecBackend::BrowserRenderable,
            metadata_fallback: None,
            thumbnail: CodecBackend::BrowserRenderable,
            detail: CodecBackend::Unsupported,
        },
        "dng" | "cr2" | "cr3" | "nef" | "nrw" | "arw" | "srf" | "sr2" | "raf" | "orf" | "rw2"
        | "pef" | "srw" => CodecCapability {
            metadata: raw_native_backend(),
            metadata_fallback: None,
            thumbnail: raw_native_backend(),
            detail: CodecBackend::Unsupported,
        },
        _ => CodecCapability {
            metadata: CodecBackend::Unsupported,
            metadata_fallback: None,
            thumbnail: CodecBackend::Unsupported,
            detail: CodecBackend::Unsupported,
        },
    }
}

pub fn codec_capability_for_path(path: &Path) -> CodecCapability {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(codec_capability_for_extension)
        .unwrap_or(CodecCapability {
            metadata: CodecBackend::Unsupported,
            metadata_fallback: None,
            thumbnail: CodecBackend::Unsupported,
            detail: CodecBackend::Unsupported,
        })
}

pub fn should_prefer_native_thumbnail(path: &Path) -> bool {
    codec_capability_for_path(path).thumbnail == CodecBackend::WindowsNative
}

pub fn should_prefer_native_preview(path: &Path) -> bool {
    codec_capability_for_path(path).thumbnail == CodecBackend::WindowsNative
}

pub fn should_prefer_native_detail(path: &Path) -> bool {
    codec_capability_for_path(path).detail == CodecBackend::WindowsNative
}

pub fn metadata_from_path(path: &Path) -> Result<NativeImageMetadata, String> {
    platform::metadata_from_path(path)
}

pub fn generate_thumbnail_jpeg(path: &Path, max_dimension: u32) -> Result<Vec<u8>, String> {
    platform::generate_scaled_jpeg(path, max_dimension)
}

pub fn generate_preview_jpeg(path: &Path, max_dimension: u32) -> Result<Vec<u8>, String> {
    platform::generate_scaled_jpeg(path, max_dimension)
}

pub fn generate_region_jpeg(path: &Path, region: NativeImageRegion) -> Result<Vec<u8>, String> {
    platform::generate_region_jpeg(path, region)
}

#[cfg(windows)]
fn native_backend_or_browser() -> CodecBackend {
    CodecBackend::WindowsNative
}

#[cfg(windows)]
fn native_detail_backend() -> CodecBackend {
    CodecBackend::WindowsNative
}

#[cfg(windows)]
fn native_metadata_fallback() -> Option<CodecBackend> {
    Some(CodecBackend::BrowserRenderable)
}

#[cfg(windows)]
fn raw_native_backend() -> CodecBackend {
    CodecBackend::WindowsNative
}

#[cfg(not(windows))]
fn native_backend_or_browser() -> CodecBackend {
    CodecBackend::BrowserRenderable
}

#[cfg(not(windows))]
fn native_detail_backend() -> CodecBackend {
    CodecBackend::Unsupported
}

#[cfg(not(windows))]
fn native_metadata_fallback() -> Option<CodecBackend> {
    None
}

#[cfg(not(windows))]
fn raw_native_backend() -> CodecBackend {
    CodecBackend::Unsupported
}

#[cfg(windows)]
mod platform {
    use super::{NativeImageMetadata, NativeImageRegion};
    use image::{DynamicImage, RgbImage};
    use std::io::Cursor;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Foundation::{GENERIC_READ, RPC_E_CHANGED_MODE, S_FALSE, S_OK};
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatBmp, GUID_ContainerFormatGif,
        GUID_ContainerFormatHeif, GUID_ContainerFormatJpeg, GUID_ContainerFormatPng,
        GUID_ContainerFormatTiff, GUID_ContainerFormatWebp, GUID_WICPixelFormat32bppBGRA,
        IWICBitmapSource, IWICImagingFactory, WICBitmapDitherTypeNone,
        WICBitmapInterpolationModeFant, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
        WICRect,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };

    struct ComApartment {
        should_uninitialize: bool,
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.should_uninitialize {
                unsafe {
                    CoUninitialize();
                }
            }
        }
    }

    pub fn metadata_from_path(path: &Path) -> Result<NativeImageMetadata, String> {
        let _com = initialize_com()?;
        let factory = create_factory()?;
        let decoder = create_decoder(&factory, path)?;
        let frame = unsafe { decoder.GetFrame(0) }.map_err(windows_error)?;

        let (width, height) = bitmap_source_size(&frame)?;
        let container_format = unsafe { decoder.GetContainerFormat() }.ok();

        Ok(NativeImageMetadata {
            width,
            height,
            format: container_format.and_then(container_format_label),
        })
    }

    pub fn generate_scaled_jpeg(path: &Path, max_dimension: u32) -> Result<Vec<u8>, String> {
        if max_dimension == 0 {
            return Err("max_dimension must be greater than zero".to_string());
        }

        let _com = initialize_com()?;
        let factory = create_factory()?;
        let decoder = create_decoder(&factory, path)?;
        let frame = unsafe { decoder.GetFrame(0) }.map_err(windows_error)?;
        let source = scaled_source(&factory, &frame, max_dimension)?;
        let bgra = source_to_bgra(&factory, &source)?;
        encode_bgra_as_jpeg(bgra)
    }

    pub fn generate_region_jpeg(path: &Path, region: NativeImageRegion) -> Result<Vec<u8>, String> {
        let _com = initialize_com()?;
        let factory = create_factory()?;
        let decoder = create_decoder(&factory, path)?;
        let frame = unsafe { decoder.GetFrame(0) }.map_err(windows_error)?;
        let region = clipped_region(&frame, region)?;
        let bgra = source_region_to_bgra(&factory, &frame, region)?;
        encode_bgra_as_jpeg(bgra)
    }

    fn initialize_com() -> Result<ComApartment, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == S_OK || result == S_FALSE {
            return Ok(ComApartment { should_uninitialize: true });
        }

        if result == RPC_E_CHANGED_MODE {
            return Ok(ComApartment { should_uninitialize: false });
        }

        Err(windows_hresult_error(result))
    }

    fn create_factory() -> Result<IWICImagingFactory, String> {
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
            .map_err(windows_error)
    }

    fn create_decoder(
        factory: &IWICImagingFactory,
        path: &Path,
    ) -> Result<windows::Win32::Graphics::Imaging::IWICBitmapDecoder, String> {
        let path_wide = path_to_wide(path);
        unsafe {
            factory.CreateDecoderFromFilename(
                PCWSTR::from_raw(path_wide.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
        }
        .map_err(windows_error)
    }

    fn path_to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn bitmap_source_size(source: &IWICBitmapSource) -> Result<(u32, u32), String> {
        let mut width = 0;
        let mut height = 0;
        unsafe { source.GetSize(&mut width, &mut height) }.map_err(windows_error)?;
        Ok((width, height))
    }

    fn scaled_source(
        factory: &IWICImagingFactory,
        source: &IWICBitmapSource,
        max_dimension: u32,
    ) -> Result<IWICBitmapSource, String> {
        let (width, height) = bitmap_source_size(source)?;
        let scale = (max_dimension as f64 / width.max(height) as f64).min(1.0);
        let target_width = ((width as f64 * scale).round() as u32).max(1);
        let target_height = ((height as f64 * scale).round() as u32).max(1);

        let scaler = unsafe { factory.CreateBitmapScaler() }.map_err(windows_error)?;
        unsafe {
            scaler.Initialize(source, target_width, target_height, WICBitmapInterpolationModeFant)
        }
        .map_err(windows_error)?;
        scaler.cast::<IWICBitmapSource>().map_err(windows_error)
    }

    struct BgraPixels {
        width: u32,
        height: u32,
        pixels: Vec<u8>,
    }

    fn source_to_bgra(
        factory: &IWICImagingFactory,
        source: &IWICBitmapSource,
    ) -> Result<BgraPixels, String> {
        let converter = unsafe { factory.CreateFormatConverter() }.map_err(windows_error)?;
        unsafe {
            converter.Initialize(
                source,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&windows::Win32::Graphics::Imaging::IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
        }
        .map_err(windows_error)?;

        let (width, height) = bitmap_source_size(&converter)?;
        let stride = width
            .checked_mul(4)
            .ok_or_else(|| "Windows native image stride overflowed".to_string())?;
        let buffer_size = stride
            .checked_mul(height)
            .ok_or_else(|| "Windows native image buffer size overflowed".to_string())?;
        let mut pixels = vec![0_u8; buffer_size as usize];

        unsafe { converter.CopyPixels(std::ptr::null(), stride, &mut pixels) }
            .map_err(windows_error)?;

        Ok(BgraPixels { width, height, pixels })
    }

    fn source_region_to_bgra(
        factory: &IWICImagingFactory,
        source: &IWICBitmapSource,
        region: NativeImageRegion,
    ) -> Result<BgraPixels, String> {
        let converter = unsafe { factory.CreateFormatConverter() }.map_err(windows_error)?;
        unsafe {
            converter.Initialize(
                source,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None::<&windows::Win32::Graphics::Imaging::IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
        }
        .map_err(windows_error)?;

        let rect = WICRect {
            X: i32::try_from(region.x)
                .map_err(|_| "Windows native tile x coordinate is too large".to_string())?,
            Y: i32::try_from(region.y)
                .map_err(|_| "Windows native tile y coordinate is too large".to_string())?,
            Width: i32::try_from(region.width)
                .map_err(|_| "Windows native tile width is too large".to_string())?,
            Height: i32::try_from(region.height)
                .map_err(|_| "Windows native tile height is too large".to_string())?,
        };
        let stride = region
            .width
            .checked_mul(4)
            .ok_or_else(|| "Windows native tile stride overflowed".to_string())?;
        let buffer_size = stride
            .checked_mul(region.height)
            .ok_or_else(|| "Windows native tile buffer size overflowed".to_string())?;
        let mut pixels = vec![0_u8; buffer_size as usize];

        unsafe { converter.CopyPixels(&rect, stride, &mut pixels) }.map_err(windows_error)?;

        Ok(BgraPixels { width: region.width, height: region.height, pixels })
    }

    fn clipped_region(
        source: &IWICBitmapSource,
        region: NativeImageRegion,
    ) -> Result<NativeImageRegion, String> {
        if region.width == 0 || region.height == 0 {
            return Err("Windows native tile region must be greater than zero".to_string());
        }

        let (source_width, source_height) = bitmap_source_size(source)?;
        if region.x >= source_width || region.y >= source_height {
            return Err("Windows native tile region is outside the source image".to_string());
        }

        Ok(NativeImageRegion {
            x: region.x,
            y: region.y,
            width: region.width.min(source_width - region.x),
            height: region.height.min(source_height - region.y),
        })
    }

    fn encode_bgra_as_jpeg(bgra: BgraPixels) -> Result<Vec<u8>, String> {
        let rgb = bgra_to_rgb(&bgra.pixels);
        let image = RgbImage::from_raw(bgra.width, bgra.height, rgb)
            .ok_or_else(|| "Windows native image buffer had invalid dimensions".to_string())?;

        let mut buffer = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut buffer, image::ImageFormat::Jpeg)
            .map_err(|err| format!("Failed to encode Windows native image: {}", err))?;
        Ok(buffer.into_inner())
    }

    fn bgra_to_rgb(bgra: &[u8]) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
        for pixel in bgra.chunks_exact(4) {
            rgb.push(pixel[2]);
            rgb.push(pixel[1]);
            rgb.push(pixel[0]);
        }
        rgb
    }

    fn container_format_label(format: windows::core::GUID) -> Option<&'static str> {
        if format == GUID_ContainerFormatJpeg {
            Some("JPEG")
        } else if format == GUID_ContainerFormatPng {
            Some("PNG")
        } else if format == GUID_ContainerFormatGif {
            Some("GIF")
        } else if format == GUID_ContainerFormatBmp {
            Some("BMP")
        } else if format == GUID_ContainerFormatTiff {
            Some("TIFF")
        } else if format == GUID_ContainerFormatWebp {
            Some("WebP")
        } else if format == GUID_ContainerFormatHeif {
            Some("HEIC")
        } else {
            None
        }
    }

    fn windows_error(error: windows::core::Error) -> String {
        error.message().to_string()
    }

    fn windows_hresult_error(error: windows::core::HRESULT) -> String {
        windows::core::Error::from(error).message().to_string()
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{NativeImageMetadata, NativeImageRegion};
    use std::path::Path;

    pub fn metadata_from_path(_path: &Path) -> Result<NativeImageMetadata, String> {
        Err("Windows native codec path is unavailable on this platform".to_string())
    }

    pub fn generate_scaled_jpeg(_path: &Path, _max_dimension: u32) -> Result<Vec<u8>, String> {
        Err("Windows native codec path is unavailable on this platform".to_string())
    }

    pub fn generate_region_jpeg(
        _path: &Path,
        _region: NativeImageRegion,
    ) -> Result<Vec<u8>, String> {
        Err("Windows native codec path is unavailable on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_capability_uses_rust_for_standard_decode_formats() {
        let capability = codec_capability_for_extension("jpg");

        assert_eq!(capability.metadata, CodecBackend::RustImage);
        assert_eq!(capability.metadata_fallback, None);
        assert_eq!(capability.thumbnail, CodecBackend::RustImage);
        assert_eq!(capability.detail, CodecBackend::RustImage);
    }

    #[test]
    fn codec_capability_keeps_standard_non_jpeg_detail_unsupported() {
        let capability = codec_capability_for_extension("png");

        assert_eq!(capability.metadata, CodecBackend::RustImage);
        assert_eq!(capability.thumbnail, CodecBackend::RustImage);
        assert_eq!(capability.detail, CodecBackend::Unsupported);
    }

    #[cfg(windows)]
    #[test]
    fn codec_capability_prefers_windows_native_for_heif_formats_on_windows() {
        for extension in ["heic", "heif"] {
            let capability = codec_capability_for_extension(extension);

            assert_eq!(capability.metadata, CodecBackend::WindowsNative);
            assert_eq!(capability.metadata_fallback, Some(CodecBackend::BrowserRenderable));
            assert_eq!(capability.thumbnail, CodecBackend::WindowsNative);
            assert_eq!(capability.detail, CodecBackend::WindowsNative);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn codec_capability_keeps_heif_browser_renderable_without_windows_native() {
        let capability = codec_capability_for_extension("heic");

        assert_eq!(capability.metadata, CodecBackend::BrowserRenderable);
        assert_eq!(capability.metadata_fallback, None);
        assert_eq!(capability.thumbnail, CodecBackend::BrowserRenderable);
        assert_eq!(capability.detail, CodecBackend::Unsupported);
    }

    #[test]
    fn codec_capability_marks_svg_as_browser_renderable() {
        let capability = codec_capability_for_extension("svg");

        assert_eq!(capability.metadata, CodecBackend::BrowserRenderable);
        assert_eq!(capability.metadata_fallback, None);
        assert_eq!(capability.thumbnail, CodecBackend::BrowserRenderable);
        assert_eq!(capability.detail, CodecBackend::Unsupported);
    }

    #[cfg(windows)]
    #[test]
    fn codec_capability_uses_windows_native_for_raw_previews_on_windows() {
        for extension in ["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw"] {
            let capability = codec_capability_for_extension(extension);

            assert_eq!(capability.metadata, CodecBackend::WindowsNative);
            assert_eq!(capability.metadata_fallback, None);
            assert_eq!(capability.thumbnail, CodecBackend::WindowsNative);
            assert_eq!(capability.detail, CodecBackend::Unsupported);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn codec_capability_keeps_raw_formats_on_placeholder_paths_without_windows_native() {
        for extension in ["dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2", "pef", "srw"] {
            let capability = codec_capability_for_extension(extension);

            assert_eq!(capability.metadata, CodecBackend::Unsupported);
            assert_eq!(capability.metadata_fallback, None);
            assert_eq!(capability.thumbnail, CodecBackend::Unsupported);
            assert_eq!(capability.detail, CodecBackend::Unsupported);
        }
    }

    #[cfg(windows)]
    #[test]
    fn native_preview_is_preferred_for_heif_formats_on_windows() {
        assert!(should_prefer_native_preview(Path::new("sample.heic")));
        assert!(should_prefer_native_preview(Path::new("sample.HEIF")));
        assert!(should_prefer_native_preview(Path::new("sample.cr2")));
        assert!(should_prefer_native_preview(Path::new("sample.DNG")));
        assert!(!should_prefer_native_preview(Path::new("sample.jpg")));
    }

    #[cfg(not(windows))]
    #[test]
    fn native_preview_is_not_preferred_without_windows_native_codecs() {
        assert!(!should_prefer_native_preview(Path::new("sample.heic")));
        assert!(!should_prefer_native_preview(Path::new("sample.cr2")));
    }

    #[test]
    fn codec_capability_rejects_unknown_extensions() {
        let capability = codec_capability_for_extension("txt");

        assert_eq!(capability.metadata, CodecBackend::Unsupported);
        assert_eq!(capability.metadata_fallback, None);
        assert_eq!(capability.thumbnail, CodecBackend::Unsupported);
        assert_eq!(capability.detail, CodecBackend::Unsupported);
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_metadata_reads_dimensions_for_decodable_images() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("native.png");
        image::RgbaImage::from_pixel(17, 11, image::Rgba([20, 40, 60, 255]))
            .save(&image_path)
            .unwrap();

        let metadata = metadata_from_path(&image_path).unwrap();

        assert_eq!(metadata.width, 17);
        assert_eq!(metadata.height, 11);
        assert_eq!(metadata.format, Some("PNG"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_thumbnail_generates_bounded_jpeg_for_decodable_images() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("native-thumbnail.png");
        image::RgbaImage::from_pixel(400, 200, image::Rgba([20, 40, 60, 255]))
            .save(&image_path)
            .unwrap();

        let bytes = generate_thumbnail_jpeg(&image_path, 160).unwrap();
        let thumbnail = image::load_from_memory(&bytes).unwrap();

        assert!(thumbnail.width() <= 160);
        assert!(thumbnail.height() <= 160);
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_preview_generates_bounded_jpeg_for_decodable_images() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("native-preview.png");
        image::RgbaImage::from_pixel(1200, 600, image::Rgba([20, 40, 60, 255]))
            .save(&image_path)
            .unwrap();

        let bytes = generate_preview_jpeg(&image_path, 512).unwrap();
        let preview = image::load_from_memory(&bytes).unwrap();

        assert!(preview.width() <= 512);
        assert!(preview.height() <= 512);
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_region_generates_original_scale_jpeg_tile() {
        let dir = tempfile::tempdir().unwrap();
        let image_path = dir.path().join("native-region.png");
        image::RgbaImage::from_pixel(120, 90, image::Rgba([20, 40, 60, 255]))
            .save(&image_path)
            .unwrap();

        let bytes = generate_region_jpeg(
            &image_path,
            NativeImageRegion { x: 10, y: 12, width: 35, height: 24 },
        )
        .unwrap();
        let tile = image::load_from_memory(&bytes).unwrap();

        assert_eq!(tile.width(), 35);
        assert_eq!(tile.height(), 24);
    }
}

# 33 - RAW Photo Sidecars

## Roadmap Item

RAW/photo sidecars: explore read-only metadata and preview support for common camera RAW workflows.

## Goal

LightFrame should include common RAW files in review folders without pretending it can safely decode
their full image data. The first useful slice is read-only RAW entries with placeholder previews and
XMP sidecar metadata in the existing Info panel.

## Current Code Context

- `SUPPORTED_EXTENSIONS` currently controls which files appear in folder scans and watcher updates.
- `get_image_metadata_blocking` reports decode capability and support notes to the viewer.
- `get_or_create_thumbnail` and `get_or_create_preview` already have SVG fallback support for some
  decode-limited formats.
- `get_exif_metadata_blocking` reads embedded EXIF but does not currently inspect `.xmp` sidecars.
- The viewer safety gate can keep large or unsupported files from falling into browser full-image
  loads.

## Implementation Steps

1. Add common RAW extensions to the supported scan list.
2. Report RAW formats as read-only, non-browser-renderable, non-Rust-decodable files.
3. Generate cached SVG placeholder thumbnails and previews for RAW files when decode fails.
4. Parse nearby XMP sidecars:
   - `image.xmp`
   - `image.ext.xmp`
   - uppercase `.XMP` variants.
5. Fill common Info panel fields from XMP when embedded EXIF is missing:
   - make/model.
   - creator tool.
   - create date.
   - aperture, shutter, ISO, focal length.
6. Keep editing/export commands on existing decode-supported formats only.

## Acceptance Criteria

- Common RAW extensions appear in folder scans.
- RAW files show stable placeholder thumbnails/previews instead of broken browser image loads.
- RAW metadata reports a clear support note and does not advertise full-resolution browser support.
- XMP sidecar metadata appears in the existing Info panel fields and raw tag list.
- Missing or unreadable sidecars do not break normal embedded EXIF reads.

## Tests

- Rust tests for RAW scan inclusion.
- Rust tests for RAW metadata support reporting.
- Rust tests for RAW thumbnail/preview placeholders.
- Rust tests for XMP sidecar parsing.
- Frontend test for non-browser-renderable safety gating.
- Run `pnpm run ci:local`.

## Reviewer Focus

- Confirm RAW files never route to unsupported crop/export/full-browser decode paths.
- Confirm placeholder cache keys remain source-metadata based.
- Confirm XMP parsing is bounded and does not add a heavy XML dependency.
- Confirm sidecar metadata augments embedded EXIF without overwriting stronger embedded values.

# 53 - Native Decode and Edit Guardrails

## Priority and Type

- Priority: P0
- Type: malicious-file resilience, memory safety, availability
- Dependencies: none; coordinate command signatures with task 51 if both are active
- Expected branch: `codex/native-decode-guardrails`
- Required final gate: `pnpm run ci:local`

## Goal

Enforce consistent Rust-side resource limits for every image decode and edit operation. Frontend
checks remain useful UX, but the backend must independently reject work that exceeds safe pixel,
dimension, file-size, allocation, or request-parameter budgets.

## Current Risk

- Scaled export has explicit pixel and working-memory validation.
- Preview, crop, rotate, clipboard, metadata, thumbnail, and some native-codec paths have different
  or no equivalent limits.
- `get_preview_image` accepts `max_dimension` from IPC.
- Some commands decode a full image before validating the operation.
- A compromised WebView or crafted image can bypass frontend preview strategy checks.

## Required Design

Create one focused Rust resource-policy module. It must define:

- maximum encoded input bytes per operation class.
- maximum width and height.
- maximum total source pixels.
- maximum requested output dimension and output pixels.
- estimated decoded and working bytes using checked arithmetic.
- operation classes such as metadata-only, thumbnail, preview, tile, clipboard, rotate, crop,
  overwrite, and scaled export.
- performance-mode influence only where safe; security ceilings must not increase beyond a fixed
  absolute maximum.

Expose pure validation functions with typed error categories. User-facing command errors should
explain the limit without leaking unnecessary filesystem information.

## Implementation Steps

1. Inventory every `image::open`, `image::load_from_memory`, WIC decode, libjpeg decode, allocation,
   and output encoder.
2. Move the existing scaled-export constants and helpers into the shared policy where appropriate.
3. Read metadata/dimensions before full decode when the format permits.
4. Validate checked `width * height * bytes_per_pixel * buffer_count` estimates before allocating.
5. Clamp or reject IPC dimensions before invoking native codecs.
6. Make tile sizes and coordinates use checked arithmetic and retain current stale-dimension
   validation.
7. Apply limits before:
   - clipboard RGBA conversion.
   - rotation fallback re-encode.
   - crop copy and overwrite.
   - preview and thumbnail Rust fallbacks.
   - native WIC pixel-buffer allocation.
8. Preserve the safe tiled JPEG/HEIF path for images that exceed full-decode limits.
9. Return an explicit "preview only" or "operation exceeds safety limit" result where the UI can
   recover, rather than panicking or treating the image as corrupt.
10. Record limit rejections in performance diagnostics without storing full paths.

## Required Test Matrix

Use generated headers/fixtures rather than allocating huge images:

- zero dimensions.
- multiplication overflow boundaries.
- one dimension above limit.
- total pixels above limit with legal individual dimensions.
- encoded file above input-byte limit.
- preview `max_dimension` of zero and above maximum.
- crop/rotate/clipboard rejection before full decode.
- acceptable large JPEG still uses the tiled path.
- acceptable normal images produce identical output dimensions and orientation.
- native-codec region buffer calculations reject overflow.
- malformed dimensions return a controlled error.

Add at least one integration-level command test showing frontend-provided parameters cannot bypass
the policy.

## UX Requirements

- Viewer should continue showing the bounded preview when full detail is rejected.
- Edit and clipboard actions must explain why they are unavailable for the current image.
- The error must not remove the image from the folder or advance navigation automatically.
- No partial output or overwrite is allowed after a policy rejection.

## Expected Files

- New `src-tauri/src/image_resource_policy.rs` or equivalent
- `src-tauri/src/commands/*.rs`
- `src-tauri/src/thumbnails.rs`
- `src-tauri/src/native_codecs.rs`
- frontend error mapping/toasts where required
- Rust unit and command tests

## Validation Commands

```powershell
cargo test --manifest-path src-tauri/Cargo.toml image_resource_policy
cargo test --manifest-path src-tauri/Cargo.toml commands::tests
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm run ci:local
```

## Acceptance Criteria

- Every full decode and allocation path is covered by a backend policy.
- Arithmetic uses checked operations before casting to `usize`.
- Oversized requests fail before expensive decode/allocation.
- Tiled/preview fallback remains available where designed.
- No normal-format regression is introduced.
- Tests prove both rejection and allowed-boundary behavior.

## Reviewer Checklist

- Search independently for every decoder/allocation call.
- Reject policies enforced only in React.
- Inspect WIC/libjpeg dimensions and integer conversions.
- Confirm partial output cleanup and original-file preservation.
- Confirm error messages are actionable and do not expose full paths in diagnostics.


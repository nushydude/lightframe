# 69 - TIFF/RAW embedded previews

## Status, priority, and type

- Status: implementation candidate; independent review and final gate required
- Priority: P1
- Type: RAW preview container support
- Dependencies: tasks 53, 54, 84
- Supporting seams: tasks 67 and 68
- Expected branch: `codex/tiff-raw-embedded-previews`
- Required final gate: `pnpm run ci:local`

## Goal and evidence

Add bounded embedded JPEG discovery for TIFF-based RAW families only where pinned native
fixtures establish coverage. The selected slice is classic TIFF NEF, proven by required
`tiff-nikon-d70s-v1` from the task 84 corpus. DNG, CR2, ARW, NRW, SRF, SR2, ORF, RW2, PEF,
and SRW lack pinned native evidence and are explicitly unsupported by this route. CR3 is a
separate container family. Existing Windows codec attempts for these other RAWs remain separate.

The reference review identified unbounded extent/prefix growth in Artcraft `files.rs:743` and
whole-file fallback in `fs_preview_loader:695` at revision
`76b5377868d912db69a777bda253a5b1b96b22bd`. That is source context, not proof of LightFrame
coverage. This candidate builds on LightFrame `843837e` and its RAF/resource/executor seams.

## Scope and constraints

`raw_preview.rs` traverses classic TIFF II/MM headers, next IFDs and SubIFD arrays only. Validate
arithmetic, file ranges, tag types/counts and budgets before seek/read/allocation. Caps are
32 IFDs, depth 8, 4096 total entries, 128 metadata reads/seeks, 8 MiB metadata, and one 32 MiB
JPEG range. A further single payload read/seek is admitted separately. Cycles and duplicate
preview/orientation tags fail recoverably. Unknown tags and sensor strips are not followed.
BigTIFF and TIFF-compressed image data are unsupported.

Select compression-6 JPEGInterchangeFormat/Length pairs using bounded JPEG SOF pixel area,
then encoded size. Validate selected JPEG framing, metadata and ICC chunks before codecs.
Container IFD0 orientation overrides JPEG EXIF exactly once; absent IFD0 orientation uses JPEG
EXIF. SubIFD sensor orientation is not a display authority. Preserve ICC bytes in generated JPEGs
without claiming colour conversion; profiled CMYK/YCCK remains unsupported. Profile preservation
applies to embedded JPEG APP2 ICC only; outer TIFF ICC tag 34675 and camera colour metadata
are ignored and never claimed as transferred.

All dimensions describe the selected embedded JPEG. Sensor dimensions are not exposed because
this route has no reliable source-dimension contract. RAW sensor decoding, demosaic, editing,
export and full-resolution tiles remain unsupported. No full RAW read, prefix growth, arbitrary
payload scan, native NEF-container fallback, dependencies, or fixture byte changes are allowed.

## Integration

Reuse the same-source ImageSource lease/snapshot, operation admissions and decoder memory limits.
Checkpoint directory/header/payload reads, decode and publication. Existing executor cancellation,
source changes, cache generations and atomic publication remain authoritative. Version NEF
thumbnail/preview identity with `nef-tiff-embedded-v1`, retaining RAF identity and non-RAW behavior.
Missing/corrupt/unsupported metadata and policy/I/O failures return recoverable errors. JPEG codec
failures may use the existing labeled placeholder policy; no error enables container decoding.

## Deterministic tests and acceptance

- Require the exact native NEF hash, length and decoded 3008 × 2000 dimensions; fail if absent.
- Prove metadata, preview, thumbnail and no-native-codec operation paths, cache identity and tiles.
- Cover II/MM endian, truncation, huge offsets/counts, cycles/depth, entries, reads, byte and JPEG
  range caps before allocation, missing/malformed JPEG and unsupported/wrong extensions.
- Compare multiple candidates by JPEG pixels despite a smaller image carrying more metadata.
- Preserve container/JPEG orientation precedence and ICC bytes in both generated asset types.
- Use fixed-seed metadata cases without allocating declared extents, deterministic cancellation,
  changed sources, stale cache generations and barriers. Preserve RAF regression coverage.
- Document each claimed family with real fixture evidence and explicit unsupported rows.
- Independent reviewer must return exact `APPROVED`; passing tests alone do not approve delivery.

## Files and validation

Affected seams: `src-tauri/src/raw_preview.rs`, `thumbnails.rs`, `native_codecs.rs`, metadata command
tests, `test-corpus/manifest.json`, corpus evidence documentation and user-facing README matrix.
No CONTRIBUTING, release fields, unrelated roadmap work, or frozen fixture hashes are changed.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml raw_preview::tests::tiff_family_bounded
cargo test --manifest-path src-tauri/Cargo.toml tiff_family_bounded
cargo test --manifest-path src-tauri/Cargo.toml raf_bounded
node scripts/validate-test-corpus.mjs --task 69
pnpm run ci:local
```

Focused filters must execute nonzero tests. Record exact failures or unavailable checks.
Manual evidence, if needed, records fixture IDs/revisions, configuration, platform and result.
Do not claim camera-wide support, Windows colour parity, format completeness, Artcraft parity
or performance improvements. Implementation workers must not approve, commit, push or open PRs.
No delivery mutation is authorized by local implementation alone.

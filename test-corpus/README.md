# Pinned media corpus

The manifest is the shared source of fixture IDs for media tasks. All 12 required files are
committed (about 20.8 MiB); normal checks use no network, secrets, global photo folders or optional
downloads. Missing files, altered bytes, altered licence/source evidence, unsafe paths and invalid
selectors fail. Run `pnpm run quality:corpus`, or `node scripts/validate-test-corpus.mjs --task 68`
to validate everything and print the selected IDs, evidence classes, SHA-256, source pins and licences.
Consumers must validate before using a selected file and fail if it is absent; never catch an
integrity error to skip a required test. Selectors return records sorted by ID without mutating
the manifest. Task 84 selects every fixture; task 67 selects authored JPEG geometry, and task 68
selects the native RAF plus JPEG geometry. Task 69 selects the required native NEF, sRGB ICC,
and RAF regression fixture. New feature tasks add their own bounded ID lists here.

## Evidence and scope

| Family      | Fixture IDs                              | Evidence                                                            |
| ----------- | ---------------------------------------- | ------------------------------------------------------------------- |
| RAF         | `raf-finepix-s5000-v1`                   | Native camera file; preview of a house and trees                    |
| TIFF family | `tiff-nikon-d70s-v1`, `tiff-geometry-v1` | Native NEF harbor scene and authored uncompressed RGB TIFF          |
| CR3         | `cr3-canon-r6-crop-v1`                   | Native cropped CRAW file; rooftop ornament scene                    |
| JPEG        | `jpeg-geometry-v1`                       | Authored 2 × 2 RGB geometry, baseline JPEG                          |
| JXL         | `jxl-square-v1`, `jxl-truncated-v1`      | Valid upstream generated 8 × 8 square; authored truncated signature |
| PSD         | `psd-geometry-v1`                        | Authored flattened 2 × 2 RGB image; no layers/resources             |
| HEIF        | `heif-wind-v1`, `heif-truncated-v1`      | Real SDR HEVC wind turbine photograph; authored truncated signature |
| XMP         | `xmp-rating-v1`                          | Authored rating 3 RDF/XML without personal metadata                 |
| Colour      | `colour-srgb-v4-v1`                      | Real upstream compact ICC v4 sRGB matrix profile                    |

`native` means an actual upstream camera/photograph/profile asset, `synthetic-valid` means a
valid authored or upstream generated simple fixture, and `synthetic-negative` means intentionally
incomplete input that must never be cited as successful native decoding evidence. TIFF, JPEG and
PSD geometry were independently opened with Pillow 12.3.0. JXL and HEIF dimensions and decoding
were checked with local ffprobe/ffmpeg and their rendered images viewed. Camera JPEG previews
were visually reviewed; the RAF preview uses the container's offset/length fields at bytes 84/88.
No identifiable people or imported branding assets were selected. The NEF harbor scene includes
incidental vessel/café lettering. These tools are acquisition evidence, not CI dependencies.

Task 69's NEF evidence is specifically Nikon D70s classic big-endian TIFF: SubIFD at 91680,
JPEG offset 131072, length 717588, decoded preview 3008 × 2000. The exact required file is
5,193,213 bytes with SHA-256 `6c46f9854033e7623ebbb5de8c951df6762ca44f05d45035ccc5cb7e9f4e5692`.
Tests also wrap that JPEG in authored little-endian TIFF metadata. This establishes the bounded
NEF layout, not camera-wide support, sensor decoding, or successful DNG/CR2/ARW handling.
No native DNG, CR2, ARW, NRW, SRF, SR2, ORF, RW2, PEF, or SRW fixture is pinned; all are explicitly
unsupported by the bounded TIFF route. Existing Windows codec behavior for those families is
separate. TIFF geometry proves an ordinary RGB TIFF fixture, not a RAW preview route.
Colour tests preserve the selected JPEG's APP2 ICC bytes; outer TIFF ICC/camera colour metadata
is not transferred or converted.

Dimensions carry a `scope`: camera dimensions are the **embedded JPEG preview**, not raw sensor
dimensions; other valid images use `image`. XMP, ICC and negative inputs use null dimensions.
This small corpus does not establish codec completeness, layered PSD, HDR, LUT profile, display
calibration, Windows colour parity or production decoder support. Feature tasks still need
their own adversarial cases, output assertions, platform evidence and any additional reviewed IDs.

## Source and licence review

The three raw.pixls.us records are saved individually in `provenance/`, including the original
per-file CC0 link, provider SHA-256, retrieval date and full-index SHA-256. That provider has no
Git revisions: each fixture's source revision is its content SHA-256, which must equal the
fixture hash. A live URL is a retrieval location, never an integrity pin. Camera names describe
formats/devices and are not imported brand artwork.

The HEIF photograph's pinned upstream README explicitly dedicates **all image files** to CC0;
the file SHA-256 matches the upstream Git LFS object ID. The ICC repository's pinned README
explicitly dedicates **all profiles** to CC0. Both licence statements are saved verbatim as text.
CC0's legal text is in `licenses/CC0-1.0.txt`.

`jxl-square-v1` is by Moritz Firsching and the libjxl testdata contributors, created in commit
`8a1dafb89c27ce0d31ab98b122bafa65869e129a`, from the
[JPEG XL test data corpus](https://github.com/libjxl/testdata/tree/73695d303670c90e4d506ea89d9901b081385089).
It is redistributed **unmodified** under **CC BY 4.0**; see `licenses/libjxl-testdata.txt`.
The manifest retains its exact source path, immutable revision and attribution. The licence
review concerns this test data corpus itself, not the libjxl software licence. Retain this
attribution, source and licence when copying the square outside this repository; document any changes.

LightFrame contributors dedicate the authored fixture bytes and `generators/geometry.py` to
CC0. The generator contains only neutral RGB geometry, metadata and incomplete signatures.
`provenance/authored-v1.txt` records authorship and the JPEG authoring tool version. Its source
revision is the generator's SHA-256, checked alongside every output hash. Manual regeneration
requires Python and Pillow 12.3.0 (libjpeg API 8.0, libjpeg-turbo 3.1.4.1). It verifies existing
outputs and refuses to replace different bytes; new candidates need new versioned names.
Tests never invoke the generator or need Pillow.

## Bounded schema and updates

Manifest version 1 requires unique portable IDs and case-insensitively unique paths, family,
format, evidence class, purpose, dimensions, exact byte count and SHA-256. Every record includes
an explicitly reviewed SPDX licence, attribution, redistribution/modification/test permissions,
hashed local licence text, source URL/revision and hashed local provenance evidence. Authored
sources must be local hashed generators; upstream HTTPS sources must pin a Git revision in the
URL or pin the file's full SHA-256. Validation checks metadata and file integrity; it does not
replace human licence review or decode every format.

Limits are fixed in the validator: 256 KiB manifest/evidence/licence/generator reads, 64 fixtures,
8 MiB per fixture and 24 MiB total fixture bytes. Each task selects 1–64 existing unique IDs;
there are at most 100 task selectors. Read allocations are bounded before file data is read.
Paths reject traversal, rooted paths, Windows drive/UNC/ADS syntax, reserved devices, trailing
dots and symlinks/junctions. Keep the checkout stable while validating; this is a repository
integrity gate, not a service for concurrently hostile filesystem writers. The corpus-local
`.gitattributes` disables Git text normalization for all hashed assets, including licence,
provenance and generator files. A test checks representative byte pins through an actual
temporary Git index/checkout with `core.autocrlf=true` on the current platform.

Never replace bytes under an existing ID/path. Add a new versioned ID/path and reviewed source,
save the applicable asset licence evidence, compute all hashes and dimensions, review rendered
content, and update explicit task selectors. Retain older pins while any task references them;
removing a retired version needs a scoped review of its consumers. Keep asset acquisition out
of CI. Download/recreate manually from the recorded source, verify the pin before adding bytes,
and record the retrieval/tool evidence. Expanding limits or licence allowlists requires focused
review; do not add personal images, fonts, model weights, unreviewed profiles or branded artwork.

For manual feature evidence, record fixture IDs, source revisions, configuration, platform,
and observed result. A passing corpus integrity check does not imply feature approval.

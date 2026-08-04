# Vendored `little_exif` (v0.6.23)

## Rationale
Vendored locally to remediate security advisories RUSTSEC-2026-0194 and RUSTSEC-2026-0195 caused by the vulnerable dependency `quick-xml 0.37.5`.

## Provenance
- Upstream: https://github.com/TechnikTobi/little_exif



## Local Deltas
- Updated `quick-xml` dependency requirement in `Cargo.toml` and `Cargo.lock` from `0.37.5` to `0.41.0`.
- Ensured XMP parsing handles nested tags, namespaces, and attribute limits safely without XML parser panic.

## Ownership and Removal Criteria
- Maintained by: LightFrame Core Team
- Removal Criteria: This vendored crate will be removed and replaced with crates.io `little_exif` once an upstream release updates `quick-xml` to `>= 0.41.0`.

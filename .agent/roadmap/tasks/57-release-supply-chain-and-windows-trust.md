# 57 - Release Supply Chain and Windows Trust

## Priority and Type

- Priority: P1
- Type: release security, provenance, user trust
- Dependencies: task 56
- Expected branch: `codex/release-supply-chain-trust`
- Required final gate: `pnpm run ci:local`

## Goal

Harden the release pipeline against dependency/workflow substitution and give users verifiable
evidence that Windows installers came from the LightFrame repository and expected release commit.

## Required Outcomes

- Third-party GitHub Actions are pinned to immutable full commit SHAs.
- Release artifacts have build provenance attestations.
- A machine-readable SBOM is generated and attached or attested.
- Checksums are published for installers and updater artifacts.
- Windows signing strategy is explicit and automated when credentials are available.
- Release secrets are protected by a GitHub Environment with least privilege.

## Implementation Steps

1. Inventory every `uses:` entry across all workflows.
2. Replace tag-only pins with full commit SHAs and retain a comment containing the human-readable
   version.
3. Keep Dependabot configured to update GitHub Actions.
4. Generate an SBOM covering both Cargo and pnpm resolved dependencies. Prefer a standard such as
   SPDX JSON or CycloneDX.
5. Generate GitHub artifact attestations for:
   - Windows installer/package.
   - updater archive/signature/manifest as appropriate.
   - SBOM.
6. Generate SHA-256 checksums after artifacts are finalized and sign/attest the checksum file.
7. Add documented verification instructions using GitHub CLI and a platform-standard checksum tool.
8. Configure a protected `release` environment in workflow references. Repository UI configuration
   that cannot be committed must be listed as a maintainer setup step with verification.
9. Evaluate Authenticode signing:
   - if a certificate and secure signing provider exist, integrate them without exposing secrets.
   - if unavailable, keep Tauri updater signing, document the gap, and make the workflow ready for a
     future certificate through environment-scoped secrets.
10. Ensure signing failures stop release creation; never publish unsigned fallback artifacts under
    the same trusted release path.
11. Apply minimal job permissions. Jobs that do not attest or publish retain read-only permissions.
12. Add release retention and immutable-release guidance where supported by repository settings.

## Constraints

- Never commit certificates, private keys, passwords, or generated tokens.
- Do not print signing material in logs.
- Do not weaken the existing Tauri updater signature.
- Do not claim Authenticode protection unless the produced PE/MSI is verified as signed.
- Workflow changes must preserve draft release behavior and preview-channel publication.

## Verification

Add a release-verification script that accepts downloaded artifact paths and checks:

- checksums.
- expected version.
- expected filenames.
- updater signature metadata presence.
- SBOM presence and parseability.

Document external verification:

```text
gh attestation verify <artifact> --repo nushydude/lightframe
Get-FileHash <artifact> -Algorithm SHA256
Get-AuthenticodeSignature <artifact>
```

The script must not falsely pass an unsigned artifact when Authenticode is required by configuration.

## Expected Files

- `.github/workflows/*.yml`
- `.github/dependabot.yml` if grouping/configuration changes
- release verification scripts
- README release/security documentation
- optional SBOM tool configuration

## Acceptance Criteria

- Every third-party action is immutable-SHA pinned.
- Release artifacts and SBOM receive provenance attestations.
- SHA-256 checksums are published and verifiable.
- Release secrets are limited to the publishing/signing job.
- Authenticode state is accurately reported and tested.
- Draft stable and preview release flows still work.
- Maintainer documentation explains how users verify downloads.

## Reviewer Checklist

- Independently compare action SHAs to the commented release versions.
- Check permissions job by job.
- Confirm attestations cover final artifacts, not an intermediate pre-signing build.
- Confirm checksum generation happens after signing.
- Confirm no secret or credential path is logged or committed.


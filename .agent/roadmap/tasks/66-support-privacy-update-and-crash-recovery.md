# 66 - Support Privacy, Update Transparency, and Crash Recovery

## Priority and Type

- Priority: P2
- Type: user trust, supportability, recovery
- Dependencies: task 63; task 57 for attestation/signing status
- Expected branch: `codex/support-privacy-crash-recovery`
- Required final gate: `pnpm run ci:local`

## Goal

Create a coherent Support and Recovery experience that lets users understand diagnostics before
sharing them, verify updates, and recover from frontend crashes or interrupted edit work without
exposing personal paths unnecessarily.

## Diagnostics Privacy Requirements

Diagnostics currently include raw `currentImagePath` and `folderPath`.

Add a diagnostics preview with:

- a human-readable summary.
- exact JSON preview.
- a default-on `Redact personal paths` option.
- a disclosure of what remains, including filenames/metadata if present.
- Copy and Save actions only after preview.

Redaction rules:

- replace home/user-directory prefixes with stable placeholders.
- hash or tokenize full image/folder paths when correlation is useful.
- remove recent-folder, destination, and external-editor paths.
- preserve non-sensitive counts, extensions, dimensions, timing, codec, and app version.
- do not claim anonymity if filenames or EXIF fields remain.
- never upload automatically.

Provide pure redaction helpers with adversarial Windows/UNC/path tests.

## Update Transparency Requirements

The update notification must display:

- current and target version.
- stable/preview channel.
- release notes/body in a safe text-rendered surface.
- download size when updater metadata provides it.
- signing/provenance status that the application can truthfully verify.
- Download and Install/Re-launch states.
- a persistent Later/remind behavior that does not re-prompt every few minutes.

Do not render update body as HTML. Do not claim GitHub attestation verification inside the app unless
the application actually verifies it. Tauri updater signature verification remains mandatory.

## Crash Recovery Surface

Replace the generic inline error boundary with a recovery screen that offers:

1. Reload application.
2. Return to a clean home state without deleting user files.
3. Copy/Save redacted diagnostics.
4. Open the generated-cache controls when the crash may involve cached assets.
5. Explain whether pending edits were saved, queued, or lost.

Do not show raw stack traces by default. Make technical details expandable and copyable.

## Persistent Edit Queue

Persist only recoverable edit job intent and status:

- stable job ID.
- authorized source image/session identity or safely re-resolvable canonical identity.
- operation parameters.
- output destination grant/validated path.
- created/updated timestamp.
- status.

Rules:

- Never resume an overwrite automatically after a crash.
- Copy/export jobs may be offered for explicit Resume after revalidation.
- Validate source metadata, destination, and conflicts again.
- Completed jobs are not repeated.
- Interrupted temporary files are reconciled safely.
- Cancel removes queue intent but does not delete a completed output.
- Queue schema is versioned and corrupt state is quarantined/recoverable.

If task 51 session grants are not durable across restarts, persist enough non-authoritative context to
ask the user to reauthorize rather than bypassing the authority model.

## Required Tests

### Privacy

- Windows drive, UNC, mixed-slash, case variant, and user-profile paths redact correctly.
- Nested metadata structures are handled.
- Redaction is deterministic inside one snapshot.
- No configured recent/destination/editor path survives.
- Non-sensitive performance data remains useful.

### Updates

- release notes render as text.
- channel/version/progress/error/later states.
- invalid/malicious body content cannot create HTML or links.
- signature failure never offers installation.

### Recovery/Edit Queue

- frontend render crash reaches recovery surface.
- reload and clean-home actions.
- persisted copy job can be explicitly resumed after revalidation.
- overwrite job requires explicit restart/confirmation.
- completed job is not duplicated.
- corrupt queue file is quarantined.
- source change and destination conflict block resume safely.
- temp-file reconciliation preserves original/output data.

## Manual QA

- Trigger a controlled render error.
- Save/copy redacted and unredacted diagnostic previews.
- Simulate update available, download failure, signature failure, and success.
- Terminate during queued crop copy and scaled export; restart and inspect recovery.
- Terminate during overwrite staging; verify original survives and no automatic overwrite resumes.

## Expected Files

- diagnostics snapshot/redaction services
- Support section components from task 63
- update notification/service
- ErrorBoundary/recovery components
- edit queue persistence and Rust validation
- settings schema for reminder/redaction defaults where needed
- Rust and Vitest tests

## Validation Commands

```powershell
pnpm run test:run -- src/services/diagnosticsSnapshot.test.ts src/components/UpdateNotification.test.tsx src/state/editQueueStore.test.ts
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run ci:local
pnpm tauri dev
```

## Acceptance Criteria

- Diagnostics are previewed and path-redacted by default.
- No diagnostics are transmitted automatically.
- Updates show truthful version/channel/release information and never bypass signature failure.
- Crash recovery offers safe actions without exposing raw traces by default.
- Recoverable edit jobs survive restart without repeating completed or overwrite work.
- Corrupt queue/support state fails safely.

## Reviewer Checklist

- Attempt to find leaked paths in every diagnostics field.
- Confirm update notes are text-only.
- Verify claims about signatures/provenance match actual checks.
- Kill the app at edit queue transition boundaries.
- Reject any automatic overwrite resume or authority bypass.


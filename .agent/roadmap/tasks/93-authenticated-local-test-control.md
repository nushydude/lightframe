# 93 - Authenticated local test/control

## Status, priority, and type

- Status: planned
- Delivery classification: optional test/control infrastructure
- Priority: P2
- Type: optional local automation
- Dependencies: tasks 51, 52, 55, 58, 59
- Expected branch: `codex/authenticated-local-test-control`
- Required final gate: `pnpm run ci:local`

Optional relationships are supporting evidence or coordination only; they are not additional dependency edges. This plan owns one delivery responsibility and must not create a competing owner.

## Goal

Provide an opt-in, authenticated, bounded local harness for test/control workflows using scoped roots and audited commands without exposing an unauthenticated port or broad MCP surface.

## Current Code Context and source evidence

Astra requires authentication before dispatch, disabled-by-default operation, bounded connections/requests/batches, scoped grants, minimal commands, and clean shutdown. LightCraft's unauthenticated-port pattern is explicitly not to be copied.

Verify all paths against the fresh `origin/main` when the task is selected. Existing code is partial evidence and may have moved; do not treat a task plan or the Astra review as proof that implementation is complete.

## Scope and constraints

Use task 51/52 grants and task 58 IPC boundaries. Bind locally only if needed, authenticate before command dispatch, rate/size limit, log safely, and shut down cleanly. No broad remote control or production automation API.

## Implementation steps

- Threat-model local harness and define opt-in configuration/secret lifecycle.
- Define minimal command allowlist, request schema, batch/connection/byte limits, timeout, and cancellation.
- Implement authentication handshake before parsing/dispatching privileged actions.
- Enforce scoped roots/grants and capability differences for main/projector windows.
- Add lifecycle/shutdown/replay/error telemetry with redacted logs.
- Document test-only usage, disable-by-default packaging, and removal/rotation.

## Deterministic tests and manual evidence

To-add Rust/integration tests cover disabled default, authentication failure/replay/timeout, oversized request/batch, connection limit, unauthorized root, command allowlist, cancellation/shutdown, log redaction, and privilege separation. Windows shell tests use task 55.

Manual evidence, when required, must record fixture IDs, source revision, configuration, platform, and result. Do not claim a future test file or filter exists: every new test named above is **to-add** work for this task. Use barriers, injected failures, fixed seeds, and bounded fixtures instead of wall-clock races.

## Acceptance Criteria

- Harness is disabled by default and cannot dispatch before authentication.
- All requests are typed, bounded, grant-scoped, audited, cancellable, and cleanly shut down.
- No unauthenticated listener or broad MCP/remote control is introduced.
- Logs omit secrets and personal paths by default.
- Tests prove both rejection and permitted local workflows.

## Expected Files

Opt-in harness module/commands, auth/config, capability wiring, tests/docs.

Proposed concrete test path (to add): src-tauri/src/local_control.rs (to-add auth/limits/shutdown tests).
Proposed implementation seams: Opt-in harness module/commands, auth/config, capability wiring.

Keep the diff scoped to these areas and preserve unrelated user changes. Reuse existing modules and task owners; a new dependency requires a narrow licence/MSRV/distribution justification.

## Validation Commands

Run focused checks first, then the required gate:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml local_control::tests::authenticated
pnpm run ci:local
```

These paths and filters are proposed tests to add in this task; the focused command must match at least one nonzero test after implementation. Report unavailable environment checks exactly and still report the required final gate.

## Documentation

Document threat model, enablement, authentication, limits, command allowlist, shutdown, and test-only scope.

Apply lightframe-doc-sync when behavior, user-facing controls, CI, or contributor workflow changes: update the relevant user docs, CONTRIBUTING.md, or focused .agent/** workflow as part of the selected task. Keep documentation changes scoped and do not edit unrelated product or orchestration policy.

## Reviewer Checklist

- Attempt bypass before auth, path/root escape, replay, oversized batch, shutdown leak, and secret/path logging.

- Confirm the implementation agent did not commit, push, open a PR, or approve its own work.
- Confirm the independent reviewer receives this complete plan, changed files, focused results, and final-gate result.
- Confirm no unsupported Artcraft parity, performance, Windows colour, format-completeness, or implementation-approval claim is made.

# 58 - Typed IPC Contracts and Rust Domain Modules

## Priority and Type

- Priority: P1
- Type: maintainability and contract correctness
- Dependencies: tasks 51 and 53, because their command contracts should stabilize first
- Expected branch: `codex/typed-ipc-rust-domains`
- Required final gate: `pnpm run ci:local`

## Goal

Break the 3,000-plus-line Rust command module and the large TypeScript command facade into explicit
domains, while generating or mechanically verifying IPC request/response types across Rust and
TypeScript.

This is a behavior-preserving architecture task. Do not redesign product workflows or add new
commands except those required to preserve stabilized contracts from prerequisite tasks.

## Target Domains

Use cohesive modules resembling:

- `catalog`: folder sessions, scans, indexes, watcher.
- `media`: metadata, captions, previews, thumbnails, tiles.
- `curation`: favorite/rating/pick data and persistence.
- `edits`: crop, scale, rotation, overwrite, edit queue.
- `transfers`: copy, move, trash, clipboard.
- `integrations`: external editor, reveal, jump list, default-app links.
- `diagnostics`: codec health, cache controls, support snapshot.
- `settings`: settings schema and persistence.
- `updates`: stable/preview update commands.

Do not force a module if the behavior clearly belongs elsewhere; document deviations.

## IPC Contract Requirements

1. Every command has one serializable request type and one documented response/error type.
2. Rust naming and TypeScript naming conversions are generated or verified in CI.
3. `unknown` record parsing is confined to one compatibility boundary.
4. Optional/null fields are consistent between languages.
5. Integer widths that can exceed JavaScript safe integers are serialized intentionally as strings
   or bounded values.
6. Command names are declared once and imported by the frontend.
7. Errors have stable machine-readable codes plus human-readable messages.
8. Privileged command request types use IDs/grants from task 51 rather than raw paths.

Evaluate a narrow generator such as Specta/tauri-specta only if it supports the current Tauri and
Rust versions without introducing broad runtime dependencies. A repository-owned schema generator
is acceptable. The PR must justify the choice.

## Implementation Sequence

1. Capture the current registered-command list in a test.
2. Extract pure structs/enums first without changing command behavior.
3. Move commands domain by domain, retaining thin Tauri command wrappers.
4. Introduce generated/verified frontend bindings.
5. Migrate `src/services/tauriCommands.ts` consumers to domain clients.
6. Keep a temporary compatibility export barrel so component changes remain scoped.
7. Remove obsolete duplicate TypeScript interfaces after all consumers migrate.
8. Add a CI check that fails when generated bindings are stale.
9. Confirm no command is accidentally omitted or newly exposed.

## Expected Files

- `src-tauri/src/commands/<domain>.rs`
- focused domain/service modules
- `src-tauri/src/commands/mod.rs` reduced to exports/registration
- generated or verified IPC bindings under a clearly marked frontend directory
- domain clients under `src/services/ipc/`
- generation/check scripts and tests

## Required Tests

- Registered command list matches the intended snapshot.
- Representative request/response serialization round-trips for every domain.
- Error codes serialize predictably.
- Large timestamps/file sizes preserve precision.
- Generated bindings are deterministic and formatting-stable.
- Stale generated output fails the check.
- Existing frontend service tests run against the new domain clients.
- No UI component imports Tauri `invoke` directly after migration, except the single generated
  transport boundary.

## Quality Targets

- `src-tauri/src/commands/mod.rs` should become a small registration/export module.
- No new domain module should become a replacement monolith; prefer files below roughly 600 lines
  unless a generated table or test fixture justifies more.
- `src/services/tauriCommands.ts` should become a compatibility barrel or be removed.
- Public types must have clear ownership and avoid circular dependencies.

## Validation Commands

```powershell
pnpm run ipc:check
pnpm run test:run
cargo test --manifest-path src-tauri/Cargo.toml
pnpm run ci:local
```

## Acceptance Criteria

- IPC contracts have a single generated or mechanically verified source.
- Rust commands are grouped into coherent domains.
- No registered command is lost or unintentionally added.
- Components do not call raw `invoke`.
- Error handling remains user-visible and testable.
- All behavior and local gates remain green.

## Reviewer Checklist

- Compare registered commands before and after.
- Review serialization edge cases and JavaScript number precision.
- Reject manual dual-maintenance disguised as generation.
- Check module boundaries for cycles and hidden cross-domain mutation.
- Confirm the task remains behavior-preserving.


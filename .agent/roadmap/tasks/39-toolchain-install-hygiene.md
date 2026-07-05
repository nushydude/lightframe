# 39 - Toolchain Install Hygiene

## Roadmap Item

Audit follow-up: make local and CI package-manager behavior reproducible with current pnpm.

## Goal

Developers and agents should be able to run `pnpm run ...` commands without package-manager
self-repair aborts, stale workspace paths, or ignored build-approval settings.

## Current Code Context

- `package.json` declares `packageManager: pnpm@10.33.2`.
- Current local `node_modules/.modules.yaml` may reference a different workspace and pnpm major.
- pnpm warns that the `pnpm.onlyBuiltDependencies` field in `package.json` is no longer read.
- Normal `pnpm run lint`, `pnpm run test:run`, and `pnpm run build` can abort before running scripts
  when pnpm tries to purge modules without a TTY.

## Implementation Steps

1. Decide whether the project should stay on pnpm 10.33.2 or move to the current pnpm major.
2. Put build-approval settings in the pnpm-supported configuration location for the selected pnpm
   version.
3. Add a short troubleshooting note for stale `node_modules` generated from another checkout.
4. Ensure CI uses the same pnpm version and install flags as local documentation.
5. Verify `pnpm install --frozen-lockfile` and normal script execution in a clean checkout.
6. Avoid committing generated `node_modules` metadata.

## Acceptance Criteria

- `pnpm install --frozen-lockfile` does not warn about ignored pnpm settings.
- `pnpm run lint`, `pnpm run test:run`, and `pnpm run build` execute normally after install.
- CI and README/CONTRIBUTING agree on Node and pnpm versions.
- The repo documents how to recover from stale local dependency metadata.

## Tests

- Run `pnpm install --frozen-lockfile`.
- Run `pnpm run lint`.
- Run `pnpm run test:run`.
- Run `pnpm run build`.
- Confirm CI frontend dependency installation still passes.

## Reviewer Focus

- Confirm toolchain settings match the selected pnpm version.
- Confirm the fix does not weaken build-script approval policy.
- Confirm documentation is concise and useful for agents and humans.
- Confirm lockfile changes, if any, are expected and minimal.

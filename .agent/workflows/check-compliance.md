---
description: Run the required local quality gate for the changed scope
---

# check-compliance

This workflow runs the mandated quality gates for LightFrame.

## Agent Guidance

- Prefer the highest-level script that matches the changed scope.
- Do not read full passing logs; trust exit code 0.
- Inspect logs only when a command fails.

// turbo-all

1. Run the full local CI check before push readiness:

```bash
pnpm run ci:local
```

2. For frontend-only changes, run:

```bash
pnpm run ci:frontend
```

3. For Rust/Tauri-only changes, run:

```bash
pnpm run ci:rust
```

4. If the selected command exits with code 0, no further inspection is needed.

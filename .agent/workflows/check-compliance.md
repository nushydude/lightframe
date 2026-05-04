---
description: Run full local CI compliance check
---

# check-compliance

This workflow runs all mandated quality gates for the lightframe project.

## 🛠 Token Optimization (Agent Directive)

To reduce token usage and avoid rate limits:

- Use the `--silent` flag to suppress verbose passing logs.
- Do NOT read the full output of the command if it succeeds.
- Only inspect the logs if a failure is reported.

// turbo-all

1. Run local CI check

```bash
npm run ci:local -- --silent
```

2. Verify success If the command exits with code 0, you are done. No further inspection is needed.

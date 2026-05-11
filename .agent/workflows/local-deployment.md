---
description: Automated local deployment lifecycle for AI agents (Fallback/Credit Exhaustion)
---

# Local Deployment Workflow (Agent Guide)

This workflow describes the step-by-step process for an AI agent to handle the entire deployment
lifecycle locally when GitHub Action credits are exhausted or when local verification is required.

## 🚩 Pre-requisites

- Docker Desktop is running.
- `.act.secrets` is populated in the root directory.
- `act` is installed and the architecture fix is applied to `./scripts/run-act-workflow.sh`.

## 🛠 Token Optimization (Agent Directive)

- Use `--silent` flags where available to reduce terminal output.
- When verifying URLs, open the browser tool once and only check for key success indicators (don't
  refresh repeatedly).
- Trust the exit codes of scripts; if they return 0, assume success unless visual verification is
  explicitly required.

## 🔄 Deployment Lifecycle

### 1. Preview Deployment (Iterative)

Before merging, deploy the feature branch to a Vercel preview URL for verification. An agent should
repeat this step after any fixes until the deployment is successful and the URL is verified.

// turbo

```bash
./scripts/run-act-workflow.sh deploy-preview workflow_dispatch -q
```

1.  **Run the command.**
2.  **Extract the Preview URL** from the logs (look for `Deployed to: https://...`).
3.  **Verify the URL**: Use the browser tool to check the deployment status. If it fails, fix the
    code and repeat this step.

### 2. Merge to Main

Once verified, merge the feature branch into `main` locally.

```bash
git checkout main
git merge <feature-branch>
git push origin main
```

### 3. Automated Version Bump

Run the versioning logic locally. This will create a local commit and a new branch/PR on GitHub.

// turbo

```bash
./scripts/run-act-workflow.sh bump-version-on-merge workflow_dispatch -q -- --silent
```

### 4. Unaliased Production Verification

Deploy the latest `main` (now including the version bump) to an unaliased production environment for
final verification Using the staging database.

// turbo

```bash
./scripts/run-act-workflow.sh deploy-unaliased-production workflow_dispatch -q -- --silent
```

### 5. Staging (UAT) Sync

Sync the `main` branch to the `test` branch to update the UAT environment (`staging.lightframe.app`).

// turbo

```bash
./scripts/run-act-workflow.sh sync-test-and-deploy-staging workflow_dispatch -q -- --silent
```

### 6. Promote to Production (Final Promotion)

When all verification is complete, promote the unaliased build to the live production domain
(`lightframe.app`).

// turbo

```bash
./scripts/run-act-workflow.sh promote-to-production workflow_dispatch -q -- --silent
```

## 🏁 Completion

The agent should verify the final production URL and summarize the release version.

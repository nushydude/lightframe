## Task State: #1585 Refactor User Tiers to Constants (2026-02-20)

### Goal

Refactor raw string literals for user tiers, subscription statuses, billing cycles, and frequencies
to centralized constants in the `shared` package and implement strict ESLint enforcement.

### Summary of Changes Made

- **Centralized Constants**: Consolidated financial constants in `@lightframe/shared` and synchronized
  with `apps/web/src/types/api.ts`.
- **ESLint Enforcement**: Implemented `no-restricted-syntax` rules in root, `apps/web`, and
  `apps/api` to block raw strings for `tier`, `status`, `billingCycle`, and `frequency`.
- **Refactoring**: Refactored over 20+ files (routes, models, components, forms) across the monorepo
  to ensure compliance.
- **Bug Fixes**: Corrected `nowFn` and template literal errors introduced during refactoring in
  `notificationsHelpers.ts`.
- **Documentation**: Created `docs/tasks/1585.md` and updated existing walkthrough/plan artifacts.

### Commands Run and Results

- `npm run lint:web` -> passed (0 constant-specific errors)
- `npm run lint --workspace=@lightframe/api` -> passed (0 constant-specific errors)
- `npm run test:web` -> passed (3237 tests)
- `npm run type-check:fast:web` -> passed

### Remaining Work / Next Steps

- Push branch `issue/1585-refactor-user-tiers-to-constants` and create PR.

## Task State: #1560 Fix SavingsGoalCard Test CI Failure (2026-02-14)

### Goal

Fix the `SavingsGoalCard` test failure in CI caused by environment-dependent default date
formatting.

### Summary of Changes Made

- Updated `apps/web/src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx`:
  - Replaced exact string match for "1 Jan 2020" with a regex `/1 Jan 2020|Jan 1, 2020/`.
  - This handles both Australian style (`D MMM YYYY`) and US/UTC style (`MMM D, YYYY`) default
    formats.
- Created GitHub issue `#1560`.
- Committed to branch `issue/1560-fix-savings-goal-card-test-ci`.

### Commands Run and Results

- `npm run test:web -- src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx` -> passed
  (Local/AU TZ)
- `TZ=UTC npm run test:web -- src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx` ->
  passed (UTC repro)
- `npm run ci:local:silent` -> passed

### Remaining Work / Next Steps

- Push branch and create PR.

## Task State: #1542 Contact Route Runtime Type-Safety (2026-02-13)

### Goal

Remove route-level unsafe `any` / `as any` usage in `apps/api/routes/contact.ts` while preserving
contact-message route behavior and response compatibility.

### Summary of Changes Made

- Removed all explicit `any` / `as any` usages in `apps/api/routes/contact.ts`.
- Added route-local query/document helper types:
  - `ContactMessagePopulatedUser`, `ContactMessageUserRef`, `ContactMessageThreadLean`,
    `ContactMessageLean`
- Added safe helpers to avoid unsafe casts:
  - `isPopulatedUserRef(...)`
  - `getUserRefId(...)`
  - `mapSubmittedAt(...)`
- Replaced untyped ContactMessage query/mutation casts with typed Mongoose calls and lean generics.
- Preserved legacy `submittedAt` compatibility by mapping from `createdAt` safely.
- Added task doc: `docs/tasks/1542.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed
- `npm run test:api -- __tests__/contact-messages-routes.test.ts` -> passed (1 suite, 19 tests)

### Remaining Work / Next Steps

- Commit on `issue/1542-contact-route-runtime-typesafety`.
- Merge into `release/5.6`.

## Task State: #1541 Admin Route Runtime Type-Safety (2026-02-13)

### Goal

Remove route-level unsafe `any`/`as any` usage in `apps/api/routes/admin.ts` while preserving admin
route behavior and API response compatibility.

### Summary of Changes Made

- Removed all explicit `any` / `as any` usage in `apps/api/routes/admin.ts`.
- Added route-local types for contact message and admin-query paths:
  - `ContactMessageStatus`, `ContactMessageCategory`, `ContactMessageThreadSender`
  - `ContactMessageListQuery`, `ContactMessageLean`
- Replaced untyped ContactMessage query/mutation flows with typed Mongoose usage and lean generics.
- Added `mapSubmittedAt(...)` helper for safe submitted timestamp mapping.
- Replaced placeholder dynamic reads with typed indexed access (no unsafe casts).
- Replaced untyped admin filter query objects with `FilterQuery<IEmailLog>` and
  `FilterQuery<IChatLog>`.
- Added task doc: `docs/tasks/1541.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- __tests__/contact-messages-routes.test.ts __tests__/admin-debug-push-routes.test.ts`
  -> passed (2 suites, 22 tests)

### Remaining Work / Next Steps

- Commit on `issue/1541-admin-route-typesafety`.
- Merge into `release/5.6`.

## Task State: #1540 Stabilize MongoMemoryServer Host Binding in Local CI (2026-02-13)

### Goal

Prevent local CI false negatives caused by in-memory Mongo startup host-bind restrictions during
full API test runs.

### Summary of Changes Made

- Updated `apps/api/jest.globalSetup.ts` to avoid wildcard host probing in restricted environments.
- Added a loopback-only ephemeral port allocator (`getLoopbackFreePort`) using `127.0.0.1`.
- Configured `MongoMemoryServer.create` to use explicit loopback host and allocated port.
- Added task doc: `docs/tasks/1540.md`.

### Commands Run and Results

- `npm test` -> reproduced API test infra startup failure path in this environment.
- `npm run ci:local:silent` -> passed.

### Remaining Work / Next Steps

- Commit on `issue/1540-mongodb-memory-server-loopback-binding`.
- Merge into `release/5.6` and push.

## Task State: #1539 Portfolio Transactions Route Runtime Type-Safety (2026-02-13)

### Goal

Reduce `any`/`as any` runtime debt in `apps/api/routes/portfolio/transactions.ts` while preserving
existing portfolio transaction route behavior and response contracts.

### Summary of Changes Made

- Added concrete route-local schema-inferred types:
  - `PortfolioTransactionCreateData`
  - `PortfolioTransactionUpdateData`
- Replaced unsafe variables with explicit model interfaces:
  - `sourceBankAccount: IPaymentMethod | null`
  - `sourceAssetBalance: IAssetBalance | null`
  - `holding: IPortfolioHolding | null`
- Replaced untyped balance and list queries with typed `FilterQuery` usage.
- Added safe populated reference extraction helpers and removed all `(x as any)` usages when reading
  `portfolio` / `holding` names and ids.
- Added explicit not-found guard after update readback instead of non-null assertions.
- Added task doc `docs/tasks/1539.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- __tests__/portfolio-transactions-routes.test.ts routes/__tests__/portfolio-transaction-update.test.ts`
  -> passed (2 suites, 17 tests)

### Remaining Work / Next Steps

- Commit on `issue/1539-portfolio-transactions-typesafety`.
- Merge into `release/5.6`.

## Task State: #1538 Expense Import Route Runtime Type-Safety (2026-02-13)

### Goal

Reduce `any`/`as any` runtime debt in `apps/api/routes/export/expenseImport.ts` while preserving
import endpoint behavior and compatibility.

### Summary of Changes Made

- Added concrete route-local interfaces/types for import row shapes, populated store defaults,
  validation error rows, duplicate candidates, and batch import results.
- Replaced unsafe `any[]`/`as any` usage in:
  - LLM enrichment request deduplication and cache population path
  - store default mapping from populated records
  - row-state/category-review/recurring-review collections
  - validation error collection
  - duplicate-detection candidate matching
  - batch import `results.details` shape
- Kept endpoint contracts and behavior unchanged across expense import routes.
- Added task doc `docs/tasks/1538.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- __tests__/export-routes.test.ts` -> passed (1 suite, 41 tests)

### Remaining Work / Next Steps

- Commit on `issue/1538-expense-import-typesafety`.
- Merge into `release/5.6`.
- Continue pass-5 with the next runtime type-safety hotspot.

## Task State: #1510 Oversized Runtime Module Refactor (Phase 2) (2026-02-13)

### Goal

Reduce oversized runtime module risk by decomposing `apps/api/services/incomeService.ts` into
focused operation modules while preserving API behavior and exported contracts.

### Summary of Changes Made

- Extracted operation modules under `apps/api/services/incomeService/`:
  - `createIncomeTransaction.ts`
  - `updateIncomeStatus.ts`
  - `deleteIncomeTransaction.ts`
  - `getIncomeTransaction.ts`
  - `updateIncomeTransaction.ts`
  - `getIncomeTransactions.ts`
  - `getIncomeSummary.ts`
  - `getIncomeSummaryStats.ts`
  - `shared.ts`
  - `types.ts`
- Converted `apps/api/services/incomeService.ts` into a thin facade class that delegates to the
  extracted modules and preserves existing public methods/type exports.
- Reduced `apps/api/services/incomeService.ts` from 1119 lines to 93 lines.
- Updated task state doc: `docs/tasks/1510.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- __tests__/income-sources-routes.test.ts __tests__/income-transactions-routes.test.ts routes/__tests__/income-next-pay-date.test.ts routes/__tests__/income-transactions-summary.test.ts`
  -> passed (4 suites, 75 tests)

### Remaining Work / Next Steps

- Commit phase-2 changes on `issue/1510-refactor-oversized-runtime-modules-phase2`.
- Merge into `release/5.6`.
- Continue queue with `#1511`.

## Task State: #1537 Continue Auth Recovery/Admin Route Decomposition (Phase 3) (2026-02-13)

### Goal

Further decompose oversized auth recovery and admin route modules into focused subrouters/services
while preserving all existing endpoint behavior.

### Summary of Changes Made

- Slimmed `apps/api/routes/auth/recoveryRoutes.ts` into a mount router and extracted:
  - `apps/api/routes/auth/recoveryVerificationRoutes.ts`
  - `apps/api/routes/auth/recoveryPasswordRoutes.ts`
  - `apps/api/routes/auth/recoveryOptionsRoutes.ts`
  - `apps/api/routes/auth/recoveryTrustedDeviceRoutes.ts`
  - `apps/api/routes/auth/recoveryPaymentRoutes.ts`
  - `apps/api/routes/auth/recoveryEmailChangeService.ts`
  - `apps/api/routes/auth/recoveryPaymentVerificationService.ts`
- Slimmed `apps/api/routes/auth/adminRoutes.ts` into a mount router and extracted:
  - `apps/api/routes/auth/adminProAccessRoutes.ts`
  - `apps/api/routes/auth/adminSubscriptionCancellationRoutes.ts`
  - `apps/api/routes/auth/adminUserManagementRoutes.ts`
- Reduced `recoveryRoutes.ts` from 644 lines to 16 and `adminRoutes.ts` from 360 lines to 12.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- routes/__tests__/password-reset.test.ts routes/__tests__/recovery-options.test.ts routes/__tests__/trusted-device-recovery.test.ts routes/__tests__/payment-recovery.test.ts routes/__tests__/admin-subscription-actions.test.ts routes/__tests__/auth-session-cleanup.test.ts __tests__/invite-codes.test.ts`
  -> passed (7 suites, 41 tests)

### Remaining Work / Next Steps

- Commit on `issue/1537-auth-recovery-admin-decomposition`.
- Merge into `release/5.6`.

## Task State: #1536 Continue Auth Account Route Decomposition and Type-Safety Cleanup (2026-02-13)

### Goal

Further split auth account routes into focused modules and remove unsafe type casts in account
preferences notification settings updates.

### Summary of Changes Made

- Replaced `apps/api/routes/auth/accountRoutes.ts` with a thin mount router.
- Added focused auth-account modules:
  - `apps/api/routes/auth/accountProfileReadRoutes.ts`
  - `apps/api/routes/auth/accountProfileWriteRoutes.ts`
  - `apps/api/routes/auth/accountCredentialsRoutes.ts`
  - `apps/api/routes/auth/accountSessionRoutes.ts`
  - `apps/api/routes/auth/accountLifecycleRoutes.ts`
  - `apps/api/routes/auth/accountChangeEmailService.ts`
  - `apps/api/routes/auth/accountProfileResponse.ts`
  - `apps/api/routes/auth/accountProfilePreferences.ts`
  - `apps/api/routes/auth/accountNotificationSettings.ts`
- Removed `as any` notificationSettings writes by introducing typed helper functions.
- Reduced `apps/api/routes/auth/accountRoutes.ts` from 758 lines to 16 lines.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- routes/__tests__/password-reset.test.ts routes/__tests__/recovery-options.test.ts routes/__tests__/trusted-device-recovery.test.ts routes/__tests__/payment-recovery.test.ts routes/__tests__/admin-subscription-actions.test.ts routes/__tests__/auth-session-cleanup.test.ts __tests__/invite-codes.test.ts`
  -> passed (7 suites, 41 tests)

### Remaining Work / Next Steps

- Commit on `issue/1536-auth-account-routes-decomposition`.
- Merge into `release/5.6`.

## Task State: #1535 Continue Auth Route Decomposition (Phase 2) (2026-02-13)

### Goal

Reduce `apps/api/routes/auth.ts` by extracting invite, account, and admin route groups into
subrouters while preserving behavior.

### Summary of Changes Made

- Added `apps/api/routes/auth/inviteRoutes.ts` for invite-code endpoints.
- Added `apps/api/routes/auth/accountRoutes.ts` for profile/security/account lifecycle endpoints.
- Added `apps/api/routes/auth/adminRoutes.ts` for admin user/subscription endpoints.
- Added `apps/api/services/accountDeletionService.ts` and moved deletion cascade logic there.
- Updated `apps/api/routes/auth.ts` to keep only register/login and mount:
  - `inviteRoutes`
  - `accountRoutes`
  - `adminRoutes`
  - `recoveryRoutes`
  - `sessionRoutes`
- Reduced `apps/api/routes/auth.ts` from 1506 lines to 91 lines.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- routes/__tests__/password-reset.test.ts routes/__tests__/recovery-options.test.ts routes/__tests__/trusted-device-recovery.test.ts routes/__tests__/payment-recovery.test.ts routes/__tests__/admin-subscription-actions.test.ts routes/__tests__/auth-session-cleanup.test.ts __tests__/invite-codes.test.ts`
  -> passed (7 suites, 41 tests)

### Remaining Work / Next Steps

- Commit on `issue/1535-auth-route-decomposition-phase2`.
- Merge into `release/5.6`.

## Task State: #1534 Decompose Auth Route Module (2026-02-13)

### Goal

Reduce `apps/api/routes/auth.ts` size by extracting cohesive auth recovery routes while preserving
existing endpoint behavior.

### Summary of Changes Made

- Added `apps/api/routes/auth/recoveryRoutes.ts` and moved these routes from `auth.ts`:
  - `/verify-email`
  - `/resend-verification`
  - `/forgot-password`
  - `/reset-password`
  - `/recovery-options`
  - `/recover-via-trusted-device`
  - `/recover-via-payment`
- Added `apps/api/routes/auth/stripeClient.ts` for shared lazy Stripe initialization.
- Updated `apps/api/routes/auth.ts` to:
  - import `getStripe` from `./auth/stripeClient`
  - mount `recoveryRoutes`
  - remove in-file recovery route implementations.
- Reduced `apps/api/routes/auth.ts` from 2251 lines to 1506 lines.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- routes/__tests__/password-reset.test.ts routes/__tests__/recovery-options.test.ts routes/__tests__/trusted-device-recovery.test.ts routes/__tests__/payment-recovery.test.ts routes/__tests__/admin-subscription-actions.test.ts routes/__tests__/auth-session-cleanup.test.ts __tests__/invite-codes.test.ts`
  -> passed (7 suites, 41 tests)

### Remaining Work / Next Steps

- Commit on `issue/1534-auth-route-decomposition`.
- Merge into `release/5.6`.

## Task State: #1533 Expense Service Runtime Type-Safety (2026-02-13)

### Goal

Reduce `any`/`as any` runtime debt in `apps/api/services/expenseService.ts` without changing expense
behavior.

### Summary of Changes Made

- Updated `apps/api/services/expenseService.ts`:
  - removed unsafe model casts (`as any`) from entity validation, balance update/revert, query
    reads, and delete flows.
  - added explicit types for entity validation, filter inputs, and duplicate-match candidate shape.
  - tightened `createExpense` return typing with `MatchingRecurringPayment | null`.
  - replaced loose filter/query construction with typed `FilterQuery<IExpense>`.
  - added small helper guards to safely read populated refs in duplicate matching.
- Added task documentation: `docs/tasks/1533.md`.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed (warnings only)
- `npm run test:api -- __tests__/expenses-duplicate-check.test.ts __tests__/expense-savings-goal.test.ts __tests__/expense-debt-account.test.ts __tests__/expenses.categoryFilter.test.ts __tests__/expenses-sorting.test.ts __tests__/recurring-insufficient-funds.test.ts`
  -> passed (6 suites, 44 tests)

### Remaining Work / Next Steps

- Run `BASE_REF=release/5.6 npm run lint:changed`.
- Commit on `issue/1533-expense-service-type-safety-pass3`.
- Merge into `release/5.6`.

## Task State: #1532 Resolve Remaining "Coming Soon" Help Signal (2026-02-13)

### Goal

Remove stale Help Center "coming soon" wording for income imports and add docs-process checks to
prevent recurrence.

### Summary of Changes Made

- Updated `apps/web/src/utils/helpArticleContentMap.ts`:
  - replaced stale wording in the expense CSV import article:
    - old: "Income imports are coming soon - for now, only expenses are imported"
    - new: direct users to `Settings -> Data & Export -> Import CSV (Income)` for income rows.
- Updated `.github/PULL_REQUEST_TEMPLATE.md`:
  - added docs-review checklist item to validate Help Center feature-availability copy.
- Added `docs/tasks/1532.md` with issue summary, capability verification, and validation record.

### Commands Run and Results

- pending

### Remaining Work / Next Steps

- Run lint check for changed files.
- Commit on `issue/1532-resolve-help-coming-soon-signal`.
- Merge into `release/5.6`.

## UX Audit: Quick Add With AI Inline Flow (2026-02-12)

Page Type: Task Page (Expenses)

UX Rule Evaluation:

- Rule 1: pass - modal remains focused on one job: parse + confirm a single expense.
- Rule 2: pass - one primary action remains `Create Expense`; parse is a preparatory action.
- Rule 3: pass - no new chrome competing with CTA.
- Rule 10: pass - removed the extra details modal to reduce UI duplication and cognitive load.
- Mobile Action Presentation: pass - no action-menu pattern changes in this task.
- Mobile Filters Affordance: not applicable.

Findings:

- violation risk identified: secondary “Complete Expense Details” modal duplicated controls and
  created a bloated multi-step confirmation for a Task flow.
- remediation implemented: move completion actions inline in parsed preview and remove dependency on
  second-step modal in Quick Add and Dashboard NLP card usage.

## Task State: Quick Add UI Simplification + Inline Date/Store Creation (2026-02-12)

### Goal

Simplify Quick AI expense confirmation UX by removing extra modal complexity, making date directly
editable via date input, and adding inline store creation affordances.

### Summary of Changes Made

- Updated `apps/web/src/components/Dashboard/NLPExpenseCard.tsx`:
  - removed dependency on selection-dialog reopen actions.
  - made date directly editable with an inline `type=\"date\"` input in parsed preview.
  - unified category/payment/store handling into inline `SearchableSelect` controls.
  - added inline create actions for store, including one-click create from AI-suggested store name.
- Updated `apps/web/src/components/ExpenseComponents/QuickAddWithAI.tsx`:
  - removed `UnifiedNLPModal` rendering from Quick Add modal flow.
  - wired date edit handlers (`onDateChange`, `onRevertDate`) into `NLPExpenseCard`.
- Updated `apps/web/src/components/Dashboard/NLPExpense.tsx`:
  - aligned with new inline card API and removed `UnifiedNLPModal` usage.
- Added tests:
  - `apps/web/src/components/Dashboard/__tests__/NLPExpenseCard.test.tsx`
    - date input change handling
    - inline “Create New Store” visibility
    - AI-suggested store quick-create flow.
- Updated docs:
  - `docs/NLP_ARCHITECTURE.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:web -- src/components/Dashboard/__tests__/NLPExpenseCard.test.tsx src/components/ExpenseComponents/__tests__/QuickAddWithAI.test.tsx`
  -> passed
- `npm run type-check:fast:web` -> passed
- `npx eslint apps/web/src/components/ExpenseComponents/QuickAddWithAI.tsx apps/web/src/components/Dashboard/NLPExpense.tsx apps/web/src/components/Dashboard/NLPExpenseCard.tsx apps/web/src/components/Dashboard/__tests__/NLPExpenseCard.test.tsx`
  -> warnings only, no errors

### Remaining Work / Next Steps

- Commit current frontend simplification changes.

## Task State: #1515 Resolver Observability Telemetry (2026-02-12)

### Goal

Implement structured decision telemetry for Quick AI resolver behavior, including leakage/abstain
signals and stage latency metrics for operational monitoring.

### Summary of Changes Made

- Updated `apps/api/services/llmService.ts`:
  - added `parseExpenseWithIdsWithTrace(...)` (non-breaking; existing `parseExpenseWithIds(...)`
    still supported)
  - added guardrail trace payload with deterministic decision reasons, abstain flags, leakage
    counters, and brand-miss indicators
  - added parser latency breakdown (`llmCompletionMs`, `resolverMs`, `totalMs`)
- Updated `apps/api/routes/nlp.ts` (`POST /api/nlp/parse-user`):
  - emits structured resolver telemetry logs with correlation IDs and stage timings
  - records aggregated telemetry events to in-memory store
  - includes fallback path for mocked/non-trace responses to preserve test compatibility
- Added telemetry store:
  - `apps/api/services/nlpTelemetryStore.ts`
  - tracks request totals, abstain/store-suppression/brand-miss/leakage rates, and latency p50/p95
  - supports threshold-based degraded status via env vars: `NLP_ALERT_BRAND_MISS_RATE_PCT`,
    `NLP_ALERT_LEAKAGE_DETECTED_RATE_PCT`, `NLP_ALERT_TOTAL_P95_MS`
- Updated health diagnostics:
  - `apps/api/routes/health.ts` now exposes `nlp.telemetry` in both `/health` and `/health/detailed`
- Added tests:
  - `apps/api/services/__tests__/nlpTelemetryStore.test.ts`
  - extended `apps/api/__tests__/llm-match-guardrails.test.ts` for trace suppression/leakage case
- Updated docs:
  - `docs/NLP_ARCHITECTURE.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- pending

### Remaining Work / Next Steps

- Run targeted API tests/type-check/lint checks.
- Commit on `issue/1515-nlp-observability-telemetry` and merge into `release/5.5`.

## Task State: #1516 Golden Eval Harness + CI Gates (2026-02-12)

### Goal

Implement Phase 4 reliability gate for Quick AI parsing with a versioned golden dataset and
threshold-based evaluation output.

### Summary of Changes Made

- Added golden evaluation service in `apps/api/services/nlpGoldenEvalService.ts`:
  - computes top-1 precision (category/payment/store), abstention accuracy, cross-domain leakage,
    and repeatability score
  - evaluates configured thresholds and emits violations.
- Added guardrail evaluation entrypoint in `apps/api/services/llmService.ts`:
  - `evaluateGuardrailsFromRaw(...)` for deterministic dataset replay without live LLM calls.
- Added versioned golden dataset fixture:
  - `apps/api/__tests__/fixtures/nlp-golden-dataset.json`
- Added CI-friendly evaluation script:
  - `apps/api/scripts/evaluateNlpGoldenDataset.ts`
  - npm script: `npm run eval:nlp-golden --workspace=@lightframe/api`
- Added harness regression test:
  - `apps/api/__tests__/nlp-golden-eval-harness.test.ts`
- Updated docs:
  - `docs/NLP_ARCHITECTURE.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:api -- __tests__/nlp-golden-eval-harness.test.ts __tests__/llm-match-guardrails.test.ts`
  -> passed
- `npm run eval:nlp-golden --workspace=@lightframe/api` -> passed (0 violations)
- `npm run type-check:fast:api` -> passed

### Remaining Work / Next Steps

- Add CI workflow wiring for `eval:nlp-golden` threshold gating if desired beyond local command use.

## Task State: #1517 Store Resolver Gating (2026-02-12)

### Goal

Implement Phase 3 deterministic store resolution with strict grammar gating (`at/in`) and no
hallucinated store creation when no explicit store signal exists.

### Summary of Changes Made

- Updated `apps/api/services/llmService.ts`:
  - added deterministic store-hint extraction from explicit `at/in` grammar.
  - added deterministic store resolver with ranked suggestions and strong-match thresholds.
  - enforced strict gating: if no explicit store hint is present, store is forced to empty.
  - when explicit store hint is present:
    - resolve to matched store deterministically when strong and unique
    - otherwise keep as new-store candidate with optional suggestions
  - expanded `StoreEntityOption` typing to include default category/payment method IDs for
    deterministic resolved-store payloads.
- Updated `apps/api/__tests__/llm-match-guardrails.test.ts`:
  - no explicit store signal forces empty store even if LLM proposes one.
  - explicit `at ...` store hint resolves deterministically.
  - unmatched explicit `at ...` hint remains a new-store candidate.

### Commands Run and Results

- `npm run test:api -- __tests__/llm-match-guardrails.test.ts` -> passed (11 tests)
- `npm run type-check:fast:api` -> passed

### Remaining Work / Next Steps

- Continue to Phase 4 (`#1516`) evaluation harness + CI reliability gates.

## Task State: #1514 Category Resolver Parity (2026-02-12)

### Goal

Implement Phase 2 deterministic category resolution with legacy synonym parity and abstention-first
behavior.

### Summary of Changes Made

- Updated `apps/api/services/llmService.ts`:
  - category resolution now returns structured resolution metadata (`resolved`, `explicitHint`,
    `suggestions`) similar to payment resolution.
  - expanded category synonym groups to better align with legacy `nlpService` category patterns
    (grocery, shopping, healthcare, utilities, housing, education, insurance, business).
  - explicit category hints now use deterministic matching and abstain when unresolved instead of
    auto-accepting unrelated LLM category IDs.
  - store-suppression guardrails now also accept unresolved explicit category hints from text.
- Updated `apps/api/__tests__/llm-match-guardrails.test.ts`:
  - added regression for legacy grocery-style hint parity (`for groceries` -> `Grocery`).
  - added regression ensuring unmatched explicit category hints abstain (`for dental` with no
    matching category).

### Commands Run and Results

- `npm run test:api -- __tests__/llm-match-guardrails.test.ts` -> passed (8 tests)
- `npm run type-check:fast:api` -> passed

### Remaining Work / Next Steps

- Continue with Phase 3 (`#1517`) after committing and merging this phase.

## Task State: #1513 Phase 1 Payment Resolver Split Start (2026-02-12)

### Goal

Begin implementation of Phase 1 (`#1513`): deterministic payment resolver behavior that prioritizes
explicit payment hints and abstains instead of selecting unrelated payment methods.

### Summary of Changes Made

- Created issue branch: `issue/1513-payment-resolver-split` from `release/5.5`.
- Updated `apps/api/services/llmService.ts`:
  - added payment hint extraction/resolution result model
  - added deterministic payment scoring with card-brand token weighting
  - added explicit-hint abstention behavior (returns unresolved payment + addNew hint instead of
    trusting unrelated LLM fallback)
  - propagated explicit payment hint into store suppression guardrails.
- Updated `apps/api/__tests__/llm-match-guardrails.test.ts`:
  - added regression test to ensure unmatched explicit brand prompts abstain instead of
    auto-selecting unrelated payment methods.

### Commands Run and Results

- `npm run test:api -- __tests__/llm-match-guardrails.test.ts` -> passed (6 tests)
- `npm run type-check:fast:api` -> passed

### Remaining Work / Next Steps

- Expand Phase 1 to reduce dependence on LLM payment ID/name when hints are absent or ambiguous.
- Add more deterministic tie-break coverage and compatibility tests for API response shape.

## Task State: Quick AI Whitepaper Implementation Issues (2026-02-12)

### Goal

Create GitHub implementation issues for the phased changes proposed in the Quick AI parsing
stability whitepaper.

### Summary of Changes Made

- Created umbrella-linked implementation issues under parent `#1512`:
  - `#1513` Phase 1: payment extraction + deterministic resolver
  - `#1514` Phase 2: category deterministic resolver + legacy synonym parity
  - `#1517` Phase 3: store deterministic resolver + grammar gating
  - `#1516` Phase 4: eval harness + CI reliability gates
  - `#1515` telemetry + observability for resolver decisions

### Commands Run and Results

- Used `gh issue create` from `release/5.5` for each implementation issue.
- Encountered intermittent `api.github.com` connectivity/auth flakiness, but issue creation
  completed.

### Remaining Work / Next Steps

- Refine issue bodies/labels as needed during sprint planning.
- Create issue branches from `release/5.5` using `issue/<number>-<short-description>`.

## Task State: Quick AI Parsing Stability Whitepaper (2026-02-12)

### Goal

Produce a review-ready whitepaper documenting Quick AI parsing instability, root causes, and
recommended architecture changes.

### Summary of Changes Made

- Added whitepaper draft:
  - `docs/tasks/quick-ai-expense-parsing-stability-whitepaper.md`
- Document includes:
  - problem statement
  - observed issues and root-cause analysis
  - phased recommendations (extraction/resolver split, hard-rule engine, abstention policy, eval CI)
  - acceptance criteria and open review questions.
- Incorporated reviewer feedback:
  - added structured telemetry requirements for decision trace logs (Datadog/CloudWatch readiness)
  - added migration/parity guidance for legacy synonym logic currently in `nlpService`.

### Commands Run and Results

- File authoring only (no runtime behavior change).
- Tests/type-check/lint not required for docs-only task in this step.

### Remaining Work / Next Steps

- Share whitepaper for architecture review and incorporate reviewer decisions into an implementation
  RFC or issue plan.

## UX Audit: Quick Add Prompt Examples (2026-02-12)

Page Type: Task Page (Expenses)

UX Rule Evaluation:

- Rule 1: pass - modal remains focused on one purpose (capture and parse expense input)
- Rule 2: pass - primary action remains `Parse Expense`; prompt examples are assistive
- Rule 3: pass - no chrome/action hierarchy changes introduced
- Mobile Action Presentation: pass - no action-menu behavior change
- Mobile Filters Affordance: pass - not applicable to this modal

Findings:

- no violations found
- UX gap identified: desktop discoverability of prompt examples depends on manual toggle; examples
  should be visible by default on desktop while preserving compact behavior on mobile.

## Task State: Quick Add Desktop Prompt Examples (2026-02-12)

### Goal

Show Quick AI prompt examples by default on desktop in the Quick Add modal, while keeping mobile
compact.

### Summary of Changes Made

- Updated desktop/mobile prompt example rendering in
  `apps/web/src/components/ExpenseComponents/QuickAddWithAI.tsx`:
  - desktop: examples are now always visible under the input
  - mobile: examples remain toggle-driven via the eye button.
- Added component tests in
  `apps/web/src/components/ExpenseComponents/__tests__/QuickAddWithAI.test.tsx`:
  - desktop default visibility
  - mobile toggle behavior.
- Updated docs:
  - `docs/NLP_ARCHITECTURE.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:web -- src/components/ExpenseComponents/__tests__/QuickAddWithAI.test.tsx` -> passed
- `npm run type-check:fast:web` -> passed
- `npm run lint:changed` -> passed (warnings only, no errors)

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: Quick AI Expense Match Guardrails (2026-02-12)

### Goal

Fix Quick AI expense parsing so category/payment-method suggestions stay in their own domains, and
ensure low-confidence matching still lets users choose from all existing categories/payment methods.

### Summary of Changes Made

- Hardened NLP parsing in `apps/api/services/llmService.ts`:
  - added post-LLM guardrails to filter out cross-domain suggestions (for example payment methods in
    category suggestions)
  - added explicit payment-hint resolution from input text (`on visa`, `via amex`, `using ...`)
  - added explicit category-hint resolution from input text (`for food`, `for groceries`) so
    conflicting category picks can be corrected deterministically
  - added explicit store guardrails so prompts without store grammar (`at ...` / `in ...`) suppress
    fake store candidates such as `Food` or `Visa`
  - normalized extracted payment/category hints by trimming relative-time tails (for example
    `last sunday`) before entity scoring so explicit card-brand prompts remain stable
  - updated LLM prompt instructions to enforce domain-safe suggestions and explicit brand handling.
- Added API regression tests in `apps/api/__tests__/llm-match-guardrails.test.ts` for:
  - explicit Visa prompt selecting Visa payment method
  - domain-safe filtering of suggestions
  - suppression of fake store add-new candidates when no explicit store signal exists.
  - explicit `on visa last sunday` still resolving to Visa (not weak fallback matches).
- Updated frontend fallback behavior in `apps/web/src/hooks/useNlplightframe.ts`:
  - if category confidence is low and API suggestions are empty, show all active categories
  - if payment-method confidence is low and API suggestions are empty, show all payment methods.
- Added web hook tests in `apps/web/src/hooks/__tests__/useNlplightframe.test.ts` to cover both
  fallback cases.
- Updated docs:
  - `docs/NLP_ARCHITECTURE.md`
  - `docs/user-guides/navigation.md`.

### Commands Run and Results

- `npm run lint:changed` -> passed (warnings only, no errors)
- `npm run type-check:fast:api` -> passed
- `npm run type-check:fast:web` -> passed
- `npm run test:api -- __tests__/llm-match-guardrails.test.ts __tests__/llm-description-enhancement.test.ts`
  -> passed
- `npm run test:api -- __tests__/llm-match-guardrails.test.ts` -> passed
- `npm run test:web -- src/hooks/__tests__/useNlplightframe.test.ts` -> passed

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: #1501 Connect Card In-Step + Create/Return Flow (2026-02-11)

### Goal

Reduce debt-setup friction by placing credit-card linking in Basic Information and allowing users to
create a credit-card payment method mid-flow, then return to debt setup.

### Summary of Changes Made

- Moved card linking from a dedicated first step into Basic Information in
  `apps/web/src/components/Debts/DebtAccountWizard.tsx`.
- Card-link section now appears only when Account Type is `Credit Card`.
- Added CTA in wizard: `Create credit card payment method`.
  - stores draft to `sessionStorage`
  - navigates to payment-method create route with return parameters.
- Added return-path support in `apps/web/src/components/Pages/PaymentMethodPage.tsx`:
  - honors `returnTo=/app/...` query
  - on successful create, navigates back with `linkedPaymentMethodId=<newId>`.
- Added auto-resume in `apps/web/src/components/Pages/DebtsPage.tsx`:
  - opens Add Debt modal when `openAddDebt=1`
  - forwards returned `linkedPaymentMethodId` to debt wizard for preselection.
- Debt wizard now accepts `prefillLinkedPaymentMethodId` prop and auto-links when available.
- Updated tests:
  - `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  - `apps/web/src/components/Pages/__tests__/DebtsPage.test.tsx`
  - `apps/web/src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`

### Commands Run and Results

- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
  -> passed
- `npm run type-check:fast:web` -> passed
- `npx eslint --fix ...DebtAccountWizard.tsx ...DebtsPage.tsx ...PaymentMethodPage.tsx ...DebtAccountWizard.test.tsx`
  -> passed with warnings only (no errors)

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: #1501 Connect Payment Method First (2026-02-11)

### Goal

Make debt setup start by linking an existing credit-card payment method, and persist that linkage on
debt accounts for better setup clarity and future risk/context features.

### Summary of Changes Made

- Added first-step wizard flow in `apps/web/src/components/Debts/DebtAccountWizard.tsx`:
  - new `Connect Card` step before basics
  - selects from existing active credit-card payment methods
  - stores `linkedPaymentMethodId`
  - prefills account name/balance/APR for new account setup.
- Increased debt add/edit modal width in `apps/web/src/components/Pages/DebtsPage.tsx` from `2xl` to
  `3xl` for improved desktop readability.
- Added additive backend support for optional payment-method linkage:
  - `apps/api/models/DebtAccount.ts`: `linkedPaymentMethodId` + virtual
  - `apps/api/middleware/validation/schemas/debt.ts`: validation for `linkedPaymentMethodId`
  - `apps/api/services/debtService.ts`: create/update/get/list handling, ownership/type guard
    (`card`/`credit_card`), populated response payload.
- Added migration:
  - `apps/api/migrations/20260228120000-add-debt-linked-payment-method.js`
  - idempotently backfills missing field to `null`.
- Updated shared API types:
  - `packages/shared/src/types/api/debtPlanner.ts`
  - regenerated synced files (`packages/shared/src/types/api.ts`, `apps/web/src/types/api.ts`,
    `apps/api/src/types/api.ts`).
- Added tests:
  - `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx` (step-order updates +
    prefill behavior)
  - `apps/api/__tests__/debts-routes.test.ts` (create/update with linked payment method + non-card
    rejection).
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`.

### Key Decisions and Assumptions

- Linkage is optional and additive; existing clients remain unaffected.
- Backend enforces linkage only to user-owned card-like payment methods to avoid invalid links.
- Prefill is applied for new account setup; edit mode keeps existing financial values unless user
  explicitly changes fields.

### Commands Run and Results

- `node scripts/sync-types.js` -> passed
- `npm run build:shared` -> passed
- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx` -> passed
- `npm run test:api -- __tests__/debts-routes.test.ts` -> passed
- `npm run type-check:fast:web` -> passed
- `npm run type-check:fast:api` -> passed
- `npx eslint ...DebtAccountWizard.tsx ...DebtAccountWizard.test.tsx ...debtService.ts` -> passed
  (warnings only, no errors)

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: #1501 Mobile Delete Parity + Debt Setup Clarification (2026-02-11)

### Goal

Close mobile/desktop parity gap for debt account deletion and clarify recommended setup direction
for credit-card/payment-method linkage.

### Summary of Changes Made

- Added mobile delete action to expanded debt cards in
  `apps/web/src/components/Debts/DebtAccountCard.tsx`.
- Wired delete flow in `apps/web/src/components/Pages/DebtsPage.tsx`:
  - account selection for deletion
  - confirmation dialog using `ConfirmationDialog`
  - delete API call via `debtsAPI.deleteAccount(...)`
  - success/error toast handling via `getErrorMessage(error)`
  - debt query invalidation and expanded-row cleanup.
- Added test coverage:
  - `apps/web/src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx` includes `onDelete`
    callback assertion from expanded mobile actions.
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/navigation.md`

### Key Decisions and Assumptions

- Kept desktop delete behavior in drawer unchanged; mobile now uses card-expanded action + confirm
  dialog.
- Did not introduce debt-account ↔ payment-method hard link in this patch (broader data-model
  change).

### Commands Run and Results

- `npm run test:web -- src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx` -> pending in
  this task step (to run after code patching)
- `npm run type-check:fast:web` -> pending in this task step (to run after code patching)

### Remaining Work / Next Steps

- Run targeted debt tests and fast web type-check.

---

## Task State: #1501 Promo BT Risk Escalation + Action Guidance (2026-02-11)

### Goal

Improve promo balance-transfer risk relevance by escalating alerts when purchase exposure is likely,
adding approximate statement-cycle awareness, and making recommended actions explicit.

### Summary of Changes Made

- Upgraded risk-card derivation in `apps/web/src/components/Dashboard/promoBalanceTransferRisk.ts`:
  - Added purchase-balance estimation (`current balance - BT outstanding`)
  - Added purchase-presence signal (`hasPurchaseBalance`)
  - Added recency heuristic (`hasRecentPurchaseSignal`) using last ~45 days of account activity
  - Added severity tiers: `baseline`, `purchases_detected`, `purchases_recent`
  - Sort now prioritizes higher-severity cards before outstanding amount
- Updated dashboard alert UX in
  `apps/web/src/components/Dashboard/PromoBalanceTransferRiskAlertCard.tsx`:
  - Dynamic copy for purchase-detected and recent-purchase cases
  - Action CTA switches to `Use another card for purchases` when purchase exposure is detected
  - Added direct recommended-action strip below alert
- Expanded learn-more guidance in
  `apps/web/src/components/Dashboard/PromoBalanceTransferRiskHelpContent.tsx`:
  - Added concrete `$500 purchases + $10,000 BT` example
  - Added explicit guidance to stop spending on the BT card during promo period
- Updated Storybook and tests:
  - `apps/web/src/components/Dashboard/PromoBalanceTransferRiskAlertCard.stories.tsx`
  - `apps/web/src/components/Dashboard/__tests__/promoBalanceTransferRisk.test.ts`
  - `apps/web/src/components/Dashboard/__tests__/PromoBalanceTransferRiskAlertCard.test.tsx`
- Updated docs:
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`
  - `docs/tasks/1501.md`

### Key Decisions and Assumptions

- True transaction-level “purchases on this card in current cycle” detection is not yet available in
  this alert path because debt accounts are not directly mapped to purchase transaction streams.
- Implemented a pragmatic MVP escalator using data already present on debt accounts:
  purchase-balance component + recent activity heuristic.

### Commands Run and Results

- `npm run test:web -- src/components/Dashboard/__tests__/promoBalanceTransferRisk.test.ts src/components/Dashboard/__tests__/PromoBalanceTransferRiskAlertCard.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx`
  -> passed
- `npm run type-check:fast:web` -> passed
- `npx eslint ...Dashboard/promoBalanceTransferRisk.ts ...PromoBalanceTransferRiskAlertCard.tsx ...PromoBalanceTransferRiskHelpContent.tsx ...__tests__/promoBalanceTransferRisk.test.ts ...__tests__/PromoBalanceTransferRiskAlertCard.test.tsx ...PromoBalanceTransferRiskAlertCard.stories.tsx`
  -> passed (warnings only; formatting applied)
- `npm run test:web -- src/components/Dashboard/__tests__/promoBalanceTransferRisk.test.ts src/components/Dashboard/__tests__/PromoBalanceTransferRiskAlertCard.test.tsx`
  -> passed

### Remaining Work / Next Steps

- Optional: introduce a first-class debt-account to payment-method mapping so alert confidence can
  be based on real purchase transactions per statement cycle rather than activity heuristics.

---

## Task State: #1501 Promo BT Risk Alert Copy Clarity (2026-02-11)

### Goal

Reduce user confusion between card-wide promotional APR fields and balance-transfer-specific APR
fields in the Debt Account wizard.

### Summary of Changes Made

- Updated debt wizard labels and helper copy in
  `apps/web/src/components/Debts/DebtAccountWizard.tsx`:
  - `Promo Rate %` -> `General Promo APR %`
  - `Months Remaining`/`Promo End Date` -> general promo-specific labels
  - `BT Promo APR/End Date/Outstanding` -> fully expanded balance-transfer-specific labels
  - Added guidance text indicating when to use general promo vs transfer promo.
- Added a `Promo Setup Type` selector in the Debt Account wizard:
  - `No promo setup`
  - `General card-wide promo`
  - `Balance transfer promo`
- Wizard now renders only the selected promo form path to reduce UI clutter and avoid mixed-input
  confusion.
- Submission payload now clears non-selected promo fields before API submit so hidden values are not
  persisted accidentally.
- Updated contextual details copy in `apps/web/src/components/Debts/DebtAccountDetails.tsx`.
- Added/updated wizard tests in `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  for conditional promo-section rendering.
- Updated docs:
  - `docs/tasks/1501.md` (Task Page UX audit + findings for field clarity)
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md` (setup guidance: which promo field
    to use)

### Key Decisions and Assumptions

- Kept data model and validation unchanged; this is a UX clarity change only.
- Enforced single-path UI at form level (one promo setup visible at a time) while preserving
  additive API compatibility.

### Commands Run and Results

- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx` -> passed
- `npm run type-check:fast:web` -> passed

### Remaining Work / Next Steps

- Optional: run broader `npm run ci:local:silent` before push/PR.

---

## Task State: Transfer Full-Balance Validation Bug (2026-02-11)

### Goal

Fix false "Insufficient available balance" errors when transferring the full displayed balance
between bank accounts.

### Summary of Changes Made

- Updated `apps/api/utils/balanceCalculation.ts` `checkEffectiveBalance(...)` to compare requested
  and available amounts using cent-normalized currency helpers instead of raw float comparison.
- Added API regression test in `apps/api/__tests__/effective-balance-validation.test.ts`:
  - removes account reservations
  - sets a source balance with floating-point artifact (`1495.299999999`)
  - verifies a full-balance transfer request (`1495.30`) succeeds.
- Updated technical/user docs:
  - `docs/tasks/transfer-money-precision.md`
  - `docs/user-guides/bank-account-balance-tracking.md`

### Key Decisions and Assumptions

- Root cause is precision drift in stored numeric values, not incorrect savings-goal reservation
  linkage for the reported account.
- Fix kept API contracts and error schema unchanged; only comparison math was hardened.

### Commands Run and Results

- `npm run test:api -- effective-balance-validation.test.ts` -> passed
- `npm run type-check:fast:api` -> passed
- `npx eslint apps/api/utils/balanceCalculation.ts apps/api/__tests__/effective-balance-validation.test.ts`
  -> passed (warnings only in existing complex functions; no errors)
- `npm run lint:changed` -> "No files to lint" in current branch diff context

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR for full local gate coverage.
- Added follow-up seed data scenario (same branch, no commit):
  - `apps/api/scripts/seed-data/finance-ledger.js` now creates `NAB Transaction` and
    `UBank Savings Joint` accounts for `john.doe@example.com`.
  - Source account balance is `1495.299999999` and has no savings-goal reservation, enabling
    repeatable QA of full-balance transfer precision behavior.
  - `apps/api/scripts/README.md` updated with repro instructions.

---

## Task State: Preview Quick Gates Optimization (2026-02-11)

### Goal

Reduce GitHub Actions runtime by running quick quality gates in preview workflows while preserving
full checks in later main/production workflow stages.

### Summary of Changes Made

- Updated `.github/workflows/deploy-preview.yml`:
  - Replaced preview full checks (`npm run type-check` + broad `npm test` loop) with quick gates:
    - `npm run lint:changed`
    - `npm run type-check:fast:api` + `npm run test:changed:api`
    - `npm run type-check:fast:web` + `npm run test:changed:web`
  - Added `code-changed` output to skip Node install/test setup when only workflow files changed.
  - Removed workflow-file coupling from `api-changed` / `web-changed` detection to avoid unnecessary
    app checks/deploy attempts.
  - Kept `workflow-changed` actionlint step intact.
- Updated `docs/GITHUB_WORKFLOW_PROCESS.md` to document:
  - preview uses quick gates
  - full type-check + full test suite remain in later main/release deployment stages.

### Key Decisions and Assumptions

- Preview CI should optimize for iteration speed and minutes usage.
- Full verification remains enforced by downstream main/release workflows before production
  promotion.

### Commands Run and Results

- `cat package.json` and workflow inspection commands to confirm available fast/changed scripts.

### Remaining Work / Next Steps

- Monitor 1-2 preview runs to confirm expected runtime reduction and no false negatives.

---

## Task State: Release Branch Issue Auto-Close Fix (2026-02-11)

### Goal

Ensure GitHub issues close automatically when issue PRs are merged into `release/*` branches.

### Summary of Changes Made

- Added workflow: `.github/workflows/close-linked-issues-on-release-merge.yml`.
- Workflow trigger: `pull_request` `closed` on base `release/**`, gated to merged PRs only.
- Workflow behavior:
  - Parses PR title/body for `Closes/Fixes/Resolves #<issue-number>` keywords.
  - Closes matching open issues in the same repository.
  - Skips already-closed issues and PR references.
  - Adds an audit comment on closed issues referencing the merged PR/base branch.
- Updated `docs/GITHUB_WORKFLOW_PROCESS.md` to document native-vs-release auto-close behavior.

### Key Decisions and Assumptions

- Existing release-branch strategy remains unchanged.
- Auto-close should be driven by PR body/title keywords to stay aligned with current template.
- Scope is same-repo issue numbers (`#123`), which matches existing branch/issue workflow.

### Commands Run and Results

- `git status -sb && git diff --stat` → clean before edits.
- `rg`/`sed` checks across `.github` and `docs` → confirmed no existing release-merge issue closer.

### Remaining Work / Next Steps

- Validate on next merged PR into `release/*` that includes `Closes #<issue-number>`.

---

## Task State: #1467 Frontend UX and Dynamic Currency Formatting

Last updated: 2026-02-08

### Goal

Replace hardcoded AUD currency formatting in targeted frontend surfaces with dynamic formatting
based on user preference, and add mixed-currency ambiguity controls.

### Acceptance Criteria

- Runtime hardcoded AUD formatter usage removed from targeted Phase 4 surfaces.
- Mixed-currency contexts include source/reporting disambiguation cues where applicable.
- UX audit documented with page classification and rule evaluation.
- Frontend tests updated and passing for changed behavior.

### Summary of Changes Made

- Replaced hardcoded formatting with `useCurrency().formatCurrency` in:
  - `apps/web/src/components/Debts/DebtAccountCard.tsx`
  - `apps/web/src/components/SavingsGoals/SavingsGoalCard.tsx`
  - `apps/web/src/components/Pages/SavingsGoals/SavingsGoalsOverviewPage.tsx`
  - `apps/web/src/components/Pages/RecommendationsPage.tsx`
  - `apps/web/src/components/Recommendations/RecommendationsList.tsx`
  - `apps/web/src/components/Recommendations/RecommendationsWidget.tsx`
  - `apps/web/src/components/NetWorth/NetWorthSummary.tsx`
  - `apps/web/src/components/NetWorth/LiabilityDetails/LiabilityDetailsContent.tsx`
  - `apps/web/src/components/NetWorth/LiabilityDetails/ExpenseListItem.tsx`
  - `apps/web/src/components/NetWorth/LiabilityDetails/RecurringPaymentListItem.tsx`
  - `apps/web/src/components/Forecasts/Forecasts.tsx`
  - `apps/web/src/components/Forecasts/ForecastKeyExpenseDrivers.tsx`
  - `apps/web/src/components/RecurringComponents/RecurringDetailsHeader.tsx`
  - `apps/web/src/components/RecurringComponents/RecurringDetailsContent.tsx`
- Completed remaining runtime sweep in additional frontend surfaces:
  - debt planner details/modal/timeline/wizard
  - savings goals automation/details/plan/snapshot/linked-assets
  - recurring payments rows/cards/history/mark-paid flow
  - calendar views and forecast dashboard widget
  - portfolio summary/table/metrics/allocation chart
  - mobile net worth liability row
- Removed utility-level hardcoded formatting:
  - `apps/web/src/utils/recurring.ts` now requires formatter injection.
  - `apps/web/src/utils/debtAccountDisplay.ts` now requires formatter injection.
  - `apps/web/src/components/RecurringPayments/utils.ts` no longer re-exports AUD formatter.
  - `apps/web/src/components/Portfolio/utils.ts` no longer re-exports AUD formatter.
- Updated mark-paid utility formatting:
  - Added formatter-injected `formatConfirmAmountWithFormatter(...)` for dynamic currency usage.
  - Kept `formatConfirmAmount(...)` as a backward-compatible fallback helper.
- Removed unused currency utility wrappers and dead tests:
  - deleted `formatCurrencyAUD`, `formatCurrencyEUR`, `formatCurrencyGBP`, `formatCurrencyCompact`,
    `formatCurrencyWhole` and their dedicated tests
  - updated `apps/web/src/utils/currencyUtils/index.ts` and `apps/web/src/utils/index.ts` exports
  - updated affected tests to use generic `formatCurrency(...)` or `useCurrency` hook mocks
- Replaced remaining `formatCurrencyUSD` usage with `useCurrency().formatCurrency` in:
  - dashboard charts and health insights
  - dashboard/quick-add NLP expense card formatting
  - dashboard-level formatter wiring
- Removed `formatCurrencyUSD` utility wrapper and dedicated test; updated barrel exports and chart
  tests to mock `useCurrency` directly.
- Replaced hardcoded `$` placeholders/examples in active dashboard NLP flows:
  - `NLPExpenseCard` prompt copy/placeholder now derives amount text from formatter callback
  - `NLPExpense` and `QuickAddWithAI` example prompts/placeholders now use dynamic formatter output
- Replaced dashboard summary-card empty-state `$0.00` literals with formatter-driven zero values.
- Added mixed-currency recommendation context:
  - reporting totals/currency fallback support
  - source currency line when source differs from reporting.
- Added tests:
  - `apps/web/src/components/Recommendations/__tests__/RecommendationsList.test.tsx`
  - Updated forecast tests for hook-based currency formatting.
- Added docs:
  - `docs/MULTI_CURRENCY_FRONTEND_UX_FORMATTING.md`
  - `docs/tasks/1467.md` (UX audit + page classification + findings)
  - Updated `docs/user-guides/currency-display-and-ledger.md`

### Key Decisions and Assumptions

- Phase 4 is additive on the frontend: legacy backend fields remain fallback paths.
- UI reads reporting currency fields when present and falls back to existing values when absent.
- Source-vs-reporting context is explicitly shown for recommendations where ambiguity is highest.
- API changes are not required to remove hardcoded frontend formatting; API changes are required
  only when source-vs-reporting conversion semantics must be introduced or corrected.

### Commands Run and Results

- `npm run test:web -- src/components/Forecasts/__tests__/Forecasts.test.tsx src/components/Forecasts/__tests__/ForecastKeyExpenseDrivers.test.tsx src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx src/components/NetWorth/LiabilityDetails/__tests__/LiabilityDetailsContent.test.tsx src/components/Debts/__tests__/DebtPlannerUI.test.tsx src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx src/components/Recommendations/__tests__/RecommendationsList.test.tsx`
  - passed
- `npm run test:web -- src/components/Forecasts/__tests__/Forecasts.test.tsx src/components/Forecasts/__tests__/ForecastKeyExpenseDrivers.test.tsx src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx src/components/NetWorth/LiabilityDetails/__tests__/LiabilityDetailsContent.test.tsx src/components/Debts/__tests__/DebtPlannerUI.test.tsx src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx src/components/Recommendations/__tests__/RecommendationsList.test.tsx src/components/RecurringPayments/__tests__/markPaidFormUtils.test.ts`
  - passed
- `npm run test:web -- src/components/Dashboard/Charts/__tests__/MonthlyTrendChart.test.tsx src/components/Dashboard/Charts/__tests__/CategoryPieChart.test.tsx src/components/Dashboard/Charts/__tests__/DailyAccumulativeChart.test.tsx src/components/Dashboard/Charts/__tests__/MonthlyComparisonChart.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Dashboard/__tests__/Dashboard.monthOverflow.test.tsx src/components/Dashboard/__tests__/DashboardAlertsSection.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - passed (warnings only; no errors)
- `npm run ci:local:silent`
  - passed
- `find apps/web/src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*/__tests__/*' ! -name '*.test.ts' ! -name '*.test.tsx' -print0 | xargs -0 grep -n "formatCurrencyAUD"`
  - only utility definition/export/index references remain (no runtime component usage)
- `find apps/web/src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 grep -n "formatCurrencyUSD"`
  - no remaining frontend references
- `npm run test:web -- src/components/Dashboard/Charts/__tests__/MonthlyTrendChart.test.tsx src/components/Dashboard/Charts/__tests__/CategoryPieChart.test.tsx src/components/Dashboard/Charts/__tests__/DailyAccumulativeChart.test.tsx src/components/Dashboard/Charts/__tests__/MonthlyComparisonChart.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Dashboard/__tests__/Dashboard.monthOverflow.test.tsx src/components/Dashboard/__tests__/DashboardAlertsSection.test.tsx src/components/Dashboard/__tests__/HealthScoreWidget.test.tsx`
  - passed
- `gh issue create --title \"[Phase 5] Currency Semantics and Integration Surface Hardening\" ...`
  - created `#1471` and linked to `#1463` + `#1468` in body

### Remaining Work / Next Steps

- Phase 4 runtime formatter migration is complete for `apps/web/src`.
- Start Phase 5 integration surfaces (import/export/NLP) after issue handoff.

---

## Task State: Dashboard cache-first widgets + component-owned skeletons (2026-02-09)

### Goal

- Dashboard should render cached widget data immediately and refresh in background with subtle
  spinner indicators.
- Skeletons should live inside widget components and match each widget layout.

### UX Audit

- Page Type: Dashboard
- Rule 1/2/3: pass (summary-first page, no new primary actions, neutral loading cues)
- Mobile Action Presentation: pass (no action-menu changes)
- Mobile Filters Affordance: pass (no filter controls)
- Findings: prior loading replaced content instead of preserving cached data; skeleton ownership
  mixed.

### Changes

- Added `isInitialLoading` and `isRefreshing` states to `useHomeActionTiles` and wired query fetch
  state semantics.
- Added initial-load skeleton and refresh spinner in `HomeNeedsAttentionTiles`.
- Added fetch-state output (`isFetching`) in `useIncomeVsExpensesComparison`.
- Added `isInitialLoading`/`isRefreshing` to `useHomeForecastWidget` and preserved content during
  refetch.
- Updated `HomeForecastWidget` to show a component-owned skeleton for first load and a small refresh
  spinner during background fetch.
- Updated dashboard widget tests and hook tests for first-load vs refresh behavior.
- Updated help center navigation guide with dashboard refresh behavior note.

### Commands Run

- `npm run test:web -- src/hooks/__tests__/useHomeActionTiles.test.ts src/components/Dashboard/__tests__/HomeNeedsAttentionTiles.test.tsx src/components/Dashboard/__tests__/HomeForecastWidget.test.tsx`
- `npm run type-check:fast:web`
- `npm run lint:changed`

### Remaining

- Optionally run broader `npm run ci:local:silent` if preparing to push.

---

## Task State: Seed Script Overhaul + Atlas Seed Run (2026-02-09)

### Goal

Replace deprecated/limited API seeding logic with comprehensive, model-aligned seed data and run it
against the provided Atlas test DB.

### Summary of Changes

- Replaced monolithic legacy `apps/api/scripts/seed-database.js` logic with modular seed
  architecture under `apps/api/scripts/seed-data/`.
- Added coverage for modern model fields and linked feature flows across:
  - users, categories, payment methods (including debit-card link validation), stores
  - expenses, recurring payments/history, income sources/transactions, transfers
  - savings goals, automation rules, allocation entries
  - liabilities, debt accounts, debt plans, assets, valuations
  - portfolios, transactions, balances, holdings, snapshots
  - notifications, recommendations, push subscriptions, sessions, security events
  - contact messages, chat logs, invite codes, global store metadata, exchange rates, email
    templates/logs
- Added safety controls to seeding CLI:
  - `--force` required for destructive/remote runs
  - `--no-drop` to preserve existing DB
  - `--uri` override support
  - `--seed` deterministic randomization
- Updated seeding documentation in `apps/api/scripts/README.md`.
- Added task documentation in `docs/tasks/seed-script-overhaul.md`.

### Commands Run

- `npm run type-check:fast:api` → passed
- `npm run lint:changed --workspace=@lightframe/api` → passed (warnings only)
- `npm run build --workspace=@lightframe/api` → passed
- `npm run seed --workspace=@lightframe/api -- --force --uri="mongodb+srv://expenseflowtest:1yUmxBezLOzoZ9wa@test.iqqzwlh.mongodb.net/?appName=Test"`
  → passed

### Seed Summary (remote Atlas)

- users: 3
- categories: 39
- paymentMethods: 18
- stores: 27
- expenses: 195
- recurringPayments: 9
- recurringHistory: 27
- incomeSources: 3
- incomeTransactions: 15
- transfers: 6
- savingsGoals: 3
- assets: 6
- liabilities: 3
- portfolios: 3
- assetBalances: 9
- recommendations: 6
- notifications: 9
- sessions: 6
- securityEvents: 12

---

## Task State: Release Notes Squash-Merge Hardening (2026-02-10)

### Goal

Ensure version bump and release note generation work for the release-branch workflow:
`release/<major>.<minor>` merged to `main` with squash merge.

### Acceptance Criteria

- Squash merge commit bodies with conventional commit lines are parsed into release notes/changelog.
- Merge metadata containing `release/x.y` can drive explicit version target `x.y.0`.
- Release-note scripts no longer rely only on top-level squash commit subject.

### Summary of Changes Made

- Added `scripts/release-commit-utils.js` with shared helpers for:
  - commit parsing (`subject + body`),
  - squash-body conventional-commit extraction,
  - release version detection from commit text (`release/x.y`),
  - semver comparison.
- Updated `scripts/version-bump.js` to:
  - parse expanded commits from squash bodies,
  - detect explicit release version from commit metadata,
  - prefer `release/x.y -> x.y.0` when greater than base version.
- Updated release metadata/note generators to use expanded commit parsing:
  - `scripts/update-releases.js`
  - `scripts/update-release-entry.js`
  - `scripts/generate-release-notes-template.js`
  - `scripts/generate-release-notes-llm.js`
  - `scripts/generate-all-release-notes.js`
- Added tests:
  - `apps/web/src/__tests__/release-commit-utils.test.ts`
  - expanded `apps/web/src/__tests__/version-bump.test.ts`
- Updated docs:
  - `docs/RELEASE_NOTES_AUTOMATION.md` with release-branch squash merge behavior.

### Commands Run and Results

- `npm run test:web -- src/__tests__/version-bump.test.ts src/__tests__/release-commit-utils.test.ts`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - no files linted for ref-diff set

### Remaining Work / Next Steps

- Optionally run full local CI (`npm run ci:local:silent`) before merging tooling changes.
- Regenerate release notes for target version after merging this fix.

---

## Task State: #1482 Prevent version over-bump on manual bump reruns (2026-02-10)

### Goal

Fix regression where re-running `bump-version-on-merge` via `workflow_dispatch` could over-bump from
`5.1.0` to `5.14.0` for `release/5.2` merges.

### Acceptance Criteria

- Release version detection survives squash-body expansion and preserves `release/x.y` hints.
- Manual reruns do not over-bump based on accumulated feature commit count.
- Unit tests cover release hint precedence.

### Summary of Changes Made

- Updated `scripts/version-bump.js` to:
  - compute highest release marker from original parsed commit texts,
  - carry `releaseVersionHint` through commit collection paths,
  - apply override using explicit hint even when expanded commit list omits merge subject.
- Added/updated tests in:
  - `apps/web/src/__tests__/version-bump.test.ts`
- Updated release automation docs:
  - `docs/RELEASE_NOTES_AUTOMATION.md`
- Created GitHub issue:
  - `#1482` fix(release-notes): prevent version over-bump on manual workflow reruns

### Commands Run and Results

- `npm run test:web -- src/__tests__/version-bump.test.ts src/__tests__/release-commit-utils.test.ts`
  → passed
- `npm run type-check:fast:web` → passed
- `npm run lint:changed` → no files linted for base diff

### Remaining Work / Next Steps

- Commit + PR + merge for `release/5.2.2`.

---

## Task State: Transfer Money Precision Hardening (2026-02-10)

### Goal

Fix floating-point precision mismatches in bank-account transfers so valid full-balance transfers
are not blocked when users enter standard 2-decimal currency amounts manually.

### Acceptance Criteria

- Transfer modal compares amounts and available balance at cent precision.
- `Max` uses a 2-decimal amount and matches manual-entry validation behavior.
- API transfer effective-balance checks use cent precision.
- API transfer amount is normalized to cents before persistence and balance updates.

### UX Audit

- Page Type: Task Page (Transfer Money modal)
- Findings: prior behavior mixed displayed 2dp currency with raw float comparisons, causing false
  "insufficient balance" for valid inputs.
- Rule evaluation: single purpose and primary action preserved; no CTA hierarchy or nav changes.

### Summary of Changes Made

- Updated transfer modal money math to cent precision:
  - normalized parsed input amount,
  - normalized available/effective balance comparisons,
  - `Max` now uses available balance precision and writes 2-decimal values.
- Added frontend regression coverage for:
  - floating-point max rounding,
  - effective-balance max behavior,
  - manual amount equal to rounded availability.
- Added API money utilities (`apps/api/utils/money.ts`) and wired them into:
  - effective-balance validation,
  - savings-goal available-balance computation,
  - transfer route amount normalization.
- Added API regression test covering the `1495.30`-style edge case.
- Updated docs:
  - `docs/tasks/transfer-money-precision.md`
  - `docs/user-guides/bank-account-balance-tracking.md`

### Commands Run and Results

- `npm run test:web -- src/components/PaymentMethods/__tests__/TransferModal.test.tsx`
  - passed
- `npm run test:api -- __tests__/effective-balance-validation.test.ts`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run lint:changed`
  - passed (warning only: ignored `scripts/version-bump.js`)

### Remaining Work / Next Steps

- Optional broad sweep: migrate remaining balance arithmetic paths to shared cent-based helpers for
  consistency across debts/income/other transfer-adjacent workflows.

---

## Task State: Money Precision Hardening (Savings Goals + Debt Frontend) (2026-02-10)

### Goal

Extend cent-precision money operations beyond transfer flow to savings-goal reservation checks and
debt-payment frontend interactions that depend on bank-balance limits.

### Acceptance Criteria

- Savings-goal reservation checks use cent-precision comparisons in API and UI.
- Debt payment modal parses/submits amount at cent precision and previews remaining balance
  consistently.
- Payment-method manual balance updates use cent-safe deltas for effective-balance enforcement.

### Summary of Changes Made

- Added frontend shared money helpers: `apps/web/src/utils/money.ts`.
- Updated transfer modal to consume shared frontend money helpers and migrated touched UI imports to
  `@/ui` contract.
- Updated savings-goal linked-assets modal:
  - reservation/spendable math to cent precision,
  - contribution totals/portfolio availability to normalized currency precision.
- Updated debt payment modal:
  - amount validation and submit payload use parsed cents,
  - estimated remaining balance uses cent-safe subtraction.
- Updated backend savings-goal reservation validation and aggregation:
  - spendable vs requested comparison via `apps/api/utils/money.ts`,
  - stored reservation amount normalized to currency precision.
- Updated backend payment-method manual balance update math:
  - normalized bank currentBalance updates,
  - cent-safe difference for effective-balance check and history entries.
- Added regression tests:
  - `apps/api/__tests__/savings-goals-validation.test.ts` precision edge case
  - `apps/web/src/components/SavingsGoals/__tests__/SavingsGoalLinkedAssetsModal.test.tsx`
  - `apps/web/src/components/Debts/__tests__/DebtPaymentModal.test.tsx`
- Updated docs:
  - `docs/tasks/transfer-money-precision.md`
  - `docs/user-guides/bank-account-balance-tracking.md`

### Commands Run and Results

- `npm run test:web -- src/components/PaymentMethods/__tests__/TransferModal.test.tsx src/components/SavingsGoals/__tests__/SavingsGoalLinkedAssetsModal.test.tsx src/components/Debts/__tests__/DebtPaymentModal.test.tsx`
  - passed
- `npm run test:api -- __tests__/effective-balance-validation.test.ts __tests__/savings-goals-validation.test.ts`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run lint:changed`
  - passed (warnings only; no errors)

### Remaining Work / Next Steps

- Optional: normalize non-blocking forecast/planning arithmetic to cent helpers for display-only
  consistency.

---

## Task State: Release Track Base-Version Recovery (Issue #1486) (2026-02-10)

### Goal

Prevent version-bump automation from jumping to a stale higher train (e.g. `5.14.x`) when release
metadata and tags indicate the intended release track (e.g. `5.2.x`).

### Changes

- Added `resolveBaseVersion(...)` in `scripts/version-bump.js`.
- Added `getMajorMinor(...)` helper for release-track comparison.
- Added recovery path: when release hint track matches latest tag track but differs from current
  `package.json` track, use `lastTagVersion` as base.
- Added regression tests in `apps/web/src/__tests__/version-bump.test.ts`.
- Updated `docs/RELEASE_NOTES_AUTOMATION.md` with stale-version recovery behavior.

### Commands Run

- `npm run test:web -- src/__tests__/version-bump.test.ts src/__tests__/release-commit-utils.test.ts`
  (passed)

### Remaining

- Commit and push fix on `release/5.3`.
- Ensure bump workflow re-runs against corrected script.

---

## Task State: Recurring mark-paid insufficient funds NaN + transfer recheck (2026-02-10)

### Goal

Fix recurring-payment mark-paid insufficient-funds UX so balance never renders as `NaN`, and ensure
insufficient-funds alert clears/revalidates after successful transfer return flow.

### Summary of Changes Made

- Added safe parser for insufficient-funds errors:
  - `apps/web/src/components/RecurringPayments/utils/insufficientFunds.ts`
- Updated mark-paid modal and mobile mark-paid page to consume parsed insufficient-funds data and
  use transfer-success timestamp-driven reset + payment-method refetch.
- Updated recurring list modals transfer-success path to pass `lastTransferTime` into
  `MarkPaidModal`.
- Updated insufficient-funds alert rendering:
  - shows `N/A` when `currentBalance` is missing/non-numeric
  - disables transfer CTA when `paymentMethodId` is unavailable
- Added regression tests in:
  - `apps/web/src/components/RecurringPayments/__tests__/MarkPaidModal.test.tsx`

### UX Audit

- Page Type: Task Page (Recurring payment mark-paid confirmation)
- Findings documented in `docs/tasks/recurring-mark-paid-insufficient-funds.md`.

### Commands Run and Results

- `npm run test:web -- src/components/RecurringPayments/__tests__/MarkPaidModal.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - blocked by existing unrelated `@/ui` import contract violations in
    `apps/web/src/components/Forms/RecurringPaymentForm.tsx`

### Remaining Work / Next Steps

- If needed, run full local CI after resolving existing baseline lint-contract violations.

---

## Task State: #1489 Mobile recurring history inline render regression (2026-02-10)

### Goal

Remove unintended inline rendering of Recurring Payment History on the mobile Recurring Expenses
list page.

### Summary of Changes Made

- Mobile modal wrapper now renders nothing instead of full history page:
  - `apps/web/src/components/RecurringPayments/RecurringPaymentHistoryWrapper.tsx`
- Added regression tests for wrapper behavior:
  - `apps/web/src/components/RecurringPayments/__tests__/RecurringPaymentHistoryWrapper.test.tsx`
- Added task record with UX audit:
  - `docs/tasks/1489.md`
- Updated navigation help content for recurring history behavior:
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:web -- src/components/RecurringPayments/__tests__/RecurringPaymentHistoryWrapper.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - blocked by existing UI import contract violations in:
    - `apps/web/src/components/Forms/RecurringPaymentForm.tsx`
    - `apps/web/src/components/RecurringPayments/InsufficientFundsAlert.tsx`

### Remaining Work / Next Steps

- Optional: resolve baseline lint-contract violations and rerun `npm run lint:changed`.

---

## Task State: Recurring debt-balance reminders + due reminders (2026-02-10)

### Goal

Fix debt-linked recurring mark-paid balance update fallback and add optional reminder flows for
approximate debt balance updates, including notification badges and dashboard visibility.

### Summary of Changes Made

- Backend reminders:
  - Extended notification model with `user_reminder` support and reminder fields.
  - Added `POST /api/notifications/reminders` to create reminders.
  - Added `PATCH /api/notifications/:notificationId/snooze` to postpone reminders.
  - Added due-only reminder synthesis in notifications feed (`getUserReminderNotifications`).
- Debt-linked recurring bugfix:
  - `markAsPaid` fallback for legacy one-sided links (`DebtAccount.linkedRecurringPaymentId`) in
    `apps/api/services/recurringPaymentService.ts`.
- Frontend recurring mark-paid:
  - Added approximate debt-balance notice + optional reminder controls in shared mark-paid form.
  - Added reminder creation wiring for desktop modal and mobile mark-paid page.
- Frontend notifications/dashboard:
  - Added reminder snooze actions in notification center (desktop dropdown + mobile bottom-sheet).
  - Added reminder-aware tile in dashboard “Needs attention”.
- Docs:
  - Added task log + UX audit doc: `docs/tasks/recurring-debt-balance-reminders.md`.
  - Updated user guide navigation with reminder behavior.
  - Updated features doc for recurring debt reminder flow.

### Commands Run and Results

- `npm run build:shared` - passed
- `node scripts/sync-types.js` - passed
- `npm run test:api -- notifications-routes.test.ts recurring-debt-account.test.ts` - passed
- `npm run test:web -- src/hooks/__tests__/useHomeActionTiles.test.ts src/components/Notifications/__tests__/NotificationCenter.test.tsx src/components/Pages/__tests__/NotificationsPage.test.tsx src/components/RecurringPayments/__tests__/MarkPaidModal.test.tsx src/components/Pages/__tests__/MarkRecurringPaymentPaidPage.test.tsx`
  - passed
- `npm run type-check:fast:web` - passed
- `npm run type-check:fast:api` - passed
- `npm run lint:changed` - blocked by existing lint error in
  `apps/web/src/components/RecurringPayments/__tests__/RecurringPaymentHistoryWrapper.test.tsx`

### Remaining Work / Next Steps

- Optional: resolve existing baseline lint errors/warnings and rerun `npm run lint:changed`.

---

## Task State: Debt payment/reconcile/details UI refinement (2026-02-10)

### Goal

Reduce fragmented UI in Debt Planner payment and reconciliation flows, tighten spacing, and simplify
linked-payment affordances.

### Summary of Changes Made

- Debt payment modal:
  - Consolidated repeated balance copy into one compact summary (current + balance after payment).
  - Added reusable lock-label tooltip pattern (`ReadOnlyFieldLabel`) for locked fields.
  - Added lock-context hint near linked recurring defaults and marked linked fields as locked in
    labels with hover/tap tooltip explanations.
  - Merged separate informational cards into a single contextual payment-behavior note.
  - Unified lock-default hint and payment-behavior hint to use the same reusable `Alert` component
    styling/pattern.
  - Tightened in-form note density by adding `Alert.contentClassName` and using compact `px-3 py-2`
    padding for these two alerts.
- Reusable pattern adoption:
  - Applied `ReadOnlyFieldLabel` to debt payment linked defaults fields.
  - Applied `ReadOnlyFieldLabel` to recurring payment edit mode `Start Date` lock state.
- Reconcile balance:
  - Reduced vertical spacing and tightened drawer padding for the reconcile view.
- Debt account details:
  - Removed linked-payments `Manage` button.
  - Made linked recurring payment name the direct deep link to recurring details.
  - Kept reconcile action as the contextual management action.
- Tests/docs:
  - Updated debt payment modal tests for revised copy and summary behavior.
  - Added DebtAccountDetails assertion for payment-name link and no-manage behavior.
  - Updated task doc + navigation help guide for refined UI behavior.

### Commands Run and Results

- `npx eslint apps/web/src/components/Debts/DebtPaymentModal.tsx apps/web/src/components/Debts/DebtBalanceReconcileForm.tsx apps/web/src/components/Debts/DebtAccountDetails.tsx apps/web/src/components/Debts/DebtAccountDrawerContainer.tsx apps/web/src/components/Debts/__tests__/DebtPaymentModal.test.tsx apps/web/src/components/Debts/__tests__/DebtPlannerUI.test.tsx`
  - failed initially on nested ternary (fixed), then passed with existing warnings only
- `npm run test:web -- src/components/Debts/__tests__/DebtPaymentModal.test.tsx src/components/Debts/__tests__/DebtBalanceReconcileForm.test.tsx src/components/Debts/__tests__/DebtPlannerUI.test.tsx`
  - passed
- `npm run test:web -- src/components/Debts/__tests__/DebtPaymentModal.test.tsx src/components/Forms/__tests__/ReadOnlyFieldLabel.test.tsx`
  - passed
- `npm run test:web -- src/components/Debts/__tests__/DebtPaymentModal.test.tsx`
  - passed
- `npx eslint apps/web/src/components/Debts/DebtPaymentModal.tsx apps/web/src/components/Debts/__tests__/DebtPaymentModal.test.tsx`
  - passed with existing warnings only
- `npx eslint apps/web/src/ui/Alert/Alert.tsx apps/web/src/components/Debts/DebtPaymentModal.tsx`
  - passed with existing warnings only
- `npx eslint apps/web/src/ui/FormField/FormField.tsx apps/web/src/components/Forms/ReadOnlyFieldLabel.tsx apps/web/src/components/Forms/RecurringPaymentForm.tsx apps/web/src/components/Debts/DebtPaymentModal.tsx apps/web/src/components/Debts/__tests__/DebtPaymentModal.test.tsx apps/web/src/components/Forms/__tests__/ReadOnlyFieldLabel.test.tsx`
  - passed with existing warnings only
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run broader `npm run lint:changed` after unrelated baseline warnings/errors are
  addressed.

---

## Task State: Debt/recurring confirm-flow alignment validation pass (2026-02-10)

### Goal

Confirm the latest debt/recurring UX alignment changes are stable and clear the UI import-contract
failure found during final lint validation.

### Summary of Changes Made

- Validation pass:
  - Ran fast web type-check and focused debt/recurring tests after latest UX edits.
- Lint contract fix:
  - Migrated deep UI imports in `RecurringPaymentForm` to the `@/ui` barrel.
  - Migrated deep UI import in `InsufficientFundsAlert` to the `@/ui` barrel.
- Re-ran lint and type-check after the import adjustments.

### Commands Run and Results

- `npm run type-check:fast:web`
  - passed
- `npm run test:web -- src/components/Debts/__tests__/DebtPaymentModal.test.tsx src/components/Debts/__tests__/DebtPlannerUI.test.tsx src/components/RecurringPayments/__tests__/MarkPaidModal.test.tsx`
  - passed
- `npm run lint:changed`
  - passed (warnings only); UI import contract passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run broader CI (`npm run ci:local:silent`) before merge if desired.

---

## Task State: #1470 Spending from savings goals (2026-02-11)

### Goal

Implement savings-goal spending so users can withdraw/spend against goals while preserving
historical progress (`saved + spent`) and keeping linked expense/account behavior consistent.

### Summary of Changes Made

- Backend model + progress math:
  - Added `withdrawnAmount` to `SavingsGoal` schema/model and seeded default values.
  - Updated progress and projection calculations to use `allocatedBalance + withdrawnAmount`.
- Expense-linked savings-goal bookkeeping:
  - Added `savingsGoalAllocatedImpact` to `Expense`.
  - On create/update/delete for linked expenses, roll forward/rollback:
    - `withdrawnAmount` by expense amount
    - `allocatedBalance` by tracked allocated impact.
- New spend endpoint:
  - Added `POST /api/goals/savings/:id/spend` with validation.
  - Added service flow to create an expense for goal spending with category fallback.
- Shared/web types and API wiring:
  - Added savings-goal spend request/response types.
  - Synced generated API type outputs.
  - Added frontend spend mutation + API client method.
- UI implementation:
  - Added `SavingsGoalSpendModal`.
  - Wired spend actions into savings-goal cards and details panel.
  - Updated goal progress display to show saved/spent/remaining context.
  - Restricted spend payment methods to bank accounts linked to the selected goal.
  - Added linked-assets modal `Max` actions and target-cap clamping for fixed + % + mixed setups.
- Tests and docs:
  - Updated API tests for linked expense create/update/delete behavior.
  - Added savings-goal spend route coverage.
  - Added spend modal frontend tests.
  - Added linked-assets modal tests for max-fill and target-cap behavior.
  - Added `docs/tasks/1470.md` (with UX audit) and updated Help Center guide for balance tracking.

### Commands Run and Results

- `npm run build:shared`
  - passed
- `node scripts/sync-types.js`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run test:api -- __tests__/savings-goals-routes.test.ts __tests__/expense-savings-goal.test.ts __tests__/recurring-savings-goal.test.ts`
  - passed
- `npm run test:web -- src/components/SavingsGoals/__tests__/SavingsGoalCard.test.tsx src/components/SavingsGoals/__tests__/SavingsGoalSpendModal.test.tsx`
  - passed
- `npm run test:api -- __tests__/savings-goals-routes.test.ts`
  - passed
- `npm run test:web -- src/components/SavingsGoals/__tests__/SavingsGoalSpendModal.test.tsx src/components/SavingsGoals/__tests__/SavingsGoalLinkedAssetsModal.test.tsx`
  - passed
- `npm run lint:changed`
  - passed (warnings only)
- `npm run ci:local:silent`
  - failed in full-suite run due unrelated/flaky failure in `src/components/Login.test.tsx`
- `npm run test:web -- src/components/Login.test.tsx`
  - passed in isolation

### Remaining Work / Next Steps

- Optional: rerun `npm run ci:local:silent` after stabilizing intermittent full-suite
  `Login.test.tsx` signal.

---

## Task State: #1501 Require linked card for credit-card debt setup (2026-02-11)

### Goal

Make debt wizard require a connected credit-card payment method when Account Type is `Credit Card`,
while keeping non-credit-card debt setup unchanged.

### Summary of Changes Made

- Updated `apps/web/src/components/Debts/DebtAccountWizard.tsx` validation to block progression from
  Basic Information when:
  - `type === 'credit_card'`
  - and `linkedPaymentMethodId` is missing.
- Added/used dedicated inline error state for linked payment method and ensured error clears when
  user selects a card or changes account type away from credit card.
- Updated credit-card connect section UI copy in wizard to required semantics.
- Updated `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx`:
  - added required-link behavior coverage
  - adjusted selectors to account for required field rendering
  - fixed numeric-input interactions to clear prefilled values before typing so assertions are
    deterministic.

### Key Decisions and Assumptions

- Kept this as a wizard-level requirement (not backend hard validation) to avoid breaking older
  clients that can still create debt accounts without `linkedPaymentMethodId`.

### Commands Run and Results

- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
  - failed initially (stale tests), then passed after test updates
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run broader web checks (`npm run lint:changed`) before commit/push.

## Task State: #1501 Debt Link Nudges + BT Registration Entry Point (2026-02-11)

### Goal

Reduce setup ambiguity by nudging credit-card users to link Debt Planner, support late
balance-transfer registration from debt details, and surface unlinked-card reminders on
dashboard/notifications.

### Summary of Changes Made

- Added debt details quick action for late BT setup:
  - `apps/web/src/components/Debts/DebtAccountDetails.tsx`
  - `apps/web/src/components/Debts/DebtAccountDrawerContainer.tsx`
  - New CTA: `Register balance transfer terms` / `Update balance transfer terms`
  - Opens account edit wizard at Promotional step.
- Added wizard initial-step support:
  - `apps/web/src/ui/Wizard/Wizard.tsx`
  - `apps/web/src/components/Debts/DebtAccountWizard.tsx` accepts `initialStepId`.
- Clarified debt wizard copy:
  - Standard APR wording in Financial Details
  - Minimum payment helper now explicitly notes issuer monthly recalculation
  - Promo setup helper clarifies default is `No promo setup`
  - Renamed BT field to `Current Balance-Transfer Portion (Optional)` with explanatory help text.
- Added credit-card payment method → debt planner linkage opt-in (default on):
  - `apps/web/src/components/Forms/PaymentMethodForm.tsx`
  - New `Debt planner sync (recommended)` section and checkbox.
- Added linked debt-account creation path during credit-card payment-method create:
  - `apps/web/src/components/Pages/PaymentMethodPage.tsx`
  - Creates debt account with linked payment method and safe defaults when enabled.
  - Skips auto-create when returning from debt wizard context (`returnContext=debt_wizard`) to avoid
    duplicates.
- Added dashboard alert for unlinked credit cards:
  - `apps/web/src/components/Dashboard/UnlinkedCreditCardDebtDashboardAlert.tsx`
  - `apps/web/src/components/Dashboard/unlinkedCreditCardDebtLinking.ts`
  - wired in `apps/web/src/components/Dashboard/Dashboard.tsx`.
- Added API notifications for unlinked credit cards:
  - `apps/api/routes/notificationsHelpers.ts`
  - emits `system_alert` with deep link to debt setup.
- Added/updated tests:
  - `apps/web/src/components/Dashboard/__tests__/unlinkedCreditCardDebtLinking.test.ts`
  - `apps/web/src/components/Dashboard/__tests__/Dashboard.test.tsx`
  - `apps/web/src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
  - `apps/api/__tests__/notifications-routes.test.ts`.
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`.

### Commands Run and Results

- `npm run test:web -- src/components/Pages/__tests__/PaymentMethodPage.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Dashboard/__tests__/unlinkedCreditCardDebtLinking.test.ts`
  - passed
- `npm run test:api -- __tests__/notifications-routes.test.ts`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npx eslint ...` targeted files
  - no blocking errors; existing warnings remain in legacy high-complexity files.

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before final push/PR.

## Task State: #1501 Debt Details/Edit Page Refactor (2026-02-11)

### Goal

Replace debt-list drawer/accordion interactions with dedicated debt account details and edit pages,
for consistent desktop/mobile behavior.

### Summary of Changes Made

- Added dedicated debt details route/page:
  - `apps/web/src/constants/routes.ts` (`PATTERNS.DEBT_ACCOUNT_DETAILS` + route builder)
  - `apps/web/src/routes/DebtRoutes.tsx`
  - `apps/web/src/components/Pages/DebtAccountDetailsPage.tsx`
- Updated debt edit page routing behavior:
  - `apps/web/src/components/Debts/DebtAccountWizardPage.tsx`
  - now respects `referrer` and optional `initialStepId` from navigation state.
- Refactored debt list interactions:
  - `apps/web/src/components/Pages/DebtsPage.tsx`
  - removed drawer usage for account details
  - card click now navigates to details page
  - quick `Record Payment` opens details page with `openPayment=1`.
- Removed mobile accordion behavior from debt cards:
  - `apps/web/src/components/Debts/DebtAccountCard.tsx`
  - card now acts as direct navigation + optional quick payment action.
- Updated debt deep links to the new details route:
  - `apps/web/src/components/Dashboard/PromoBalanceTransferRiskDashboardAlert.tsx`
  - `apps/web/src/components/RecurringComponents/RecurringDetailsContent.tsx`
  - `apps/web/src/components/RecurringPayments/reminderUtils.ts`.
- Added/updated tests:
  - `apps/web/src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx` (new)
  - `apps/web/src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx`
  - `apps/web/src/components/Debts/__tests__/DebtPlannerUI.test.tsx`
  - `apps/web/src/components/RecurringComponents/__tests__/RecurringDetailsContent.test.tsx`
  - `apps/web/src/components/Pages/__tests__/DebtsPage.test.tsx`.
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/navigation.md`.

### Commands Run and Results

- `npm run test:web -- src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx src/components/Debts/__tests__/DebtPlannerUI.test.tsx src/components/RecurringComponents/__tests__/RecurringDetailsContent.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push.

## Task State: #1501 Debt Page Header Alignment + Dedicated Create Page (2026-02-11)

### Goal

Align Debt Planner create/edit/details page chrome with lightframe page-header standards and remove
modal-based debt-account creation in favor of dedicated routed pages.

### Summary of Changes Made

- Removed add-account modal flow from `apps/web/src/components/Pages/DebtsPage.tsx`.
  - `Add Account` now navigates to `ROUTES.DEBT_ACCOUNT_NEW`.
  - Legacy debt-list query links (`openAddDebt`, `linkedPaymentMethodId`) now redirect to the
    dedicated create route for backward compatibility.
- Updated debt wizard payment-method return flow in
  `apps/web/src/components/Debts/DebtAccountWizard.tsx`.
  - Return target is now `/app/debts/accounts/new` (instead of list-page modal trigger).
- Updated debt wizard page shell in `apps/web/src/components/Debts/DebtAccountWizardPage.tsx`.
  - Added consistent breadcrumbs: `Home > More > Debt Planner > Add/Edit Account`.
  - Added standard subtitle/back-label.
  - Added support for `linkedPaymentMethodId` query prefill on routed create page.
- Updated debt details page header in `apps/web/src/components/Pages/DebtAccountDetailsPage.tsx`.
  - Single primary action: `Record Payment`.
  - Secondary actions moved to `Actions` menu (`Edit`, `Register balance transfer`, `Delete`).
  - Breadcrumbs aligned with parent section hierarchy.
- Updated unlinked-card dashboard alert deep link in
  `apps/web/src/components/Dashboard/UnlinkedCreditCardDebtDashboardAlert.tsx` to route directly to
  debt-account create page with prefilled linked payment method.
- Updated tests:
  - `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  - `apps/web/src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx`
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:web -- src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
  - passed
- `npm run test:web -- src/components/Debts/__tests__/DebtPlannerUI.test.tsx src/components/Debts/__tests__/DebtAccountCardPayment.test.tsx src/components/RecurringComponents/__tests__/RecurringDetailsContent.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before merge/push.

## Task State: #1501 Debt Overview + Accounts IA Split (2026-02-11)

### Goal

Align Debt Planner with UX page-type rules by separating dashboard overview concerns from account
management concerns, while preserving existing debt detail/edit/create flows.

### Summary of Changes Made

- Added Debt Planner section tabs + IA split:
  - `/app/debts` is now a dashboard-style **Overview** page (`DebtsPage`).
  - `/app/debts/accounts` is now a dedicated **Accounts** management page (`DebtAccountsPage`).
- Added route constant `ROUTES.DEBT_ACCOUNTS` in `apps/web/src/constants/routes.ts`.
- Added route in `apps/web/src/routes/DebtRoutes.tsx` for `ROUTES.DEBT_ACCOUNTS`.
- Added shared debt-page nav tabs in `apps/web/src/components/Debts/debtNavigation.ts`.
- Added debt overview metrics helper in `apps/web/src/components/Debts/debtOverviewMetrics.ts`:
  - total outstanding debt
  - weighted APR
  - next-30-day minimum total (due-day based)
  - projected debt-free estimate at current minimums
  - upcoming payments list.
- Replaced previous debt list landing implementation with overview dashboard in
  `apps/web/src/components/Pages/DebtsPage.tsx`.
- Added management list page in `apps/web/src/components/Pages/DebtAccountsPage.tsx` (search +
  account cards + add flow).
- Updated debt details and wizard defaults for management-first back behavior:
  - `apps/web/src/components/Pages/DebtAccountDetailsPage.tsx`
    - fallback back/delete navigation now goes to `ROUTES.DEBT_ACCOUNTS`
    - breadcrumbs include `Debt Planner > Accounts`.
  - `apps/web/src/components/Debts/DebtAccountWizardPage.tsx`
    - default close/success route now `ROUTES.DEBT_ACCOUNTS`
    - breadcrumbs/back label aligned to Accounts context.
- Added/updated tests:
  - `apps/web/src/components/Pages/__tests__/DebtAccountsPage.test.tsx` (new)
  - `apps/web/src/components/Pages/__tests__/DebtsPage.test.tsx` (overview assertions)
- Updated docs:
  - `docs/tasks/1501.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:web -- src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/DebtAccountsPage.test.tsx src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Dashboard/__tests__/Dashboard.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: #1501 BT Transfer Portion Max/Cap UX (2026-02-11)

### Goal

Improve clarity and speed when entering **Current Balance-Transfer Portion** by allowing users to
set it directly from current balance and preventing impossible values.

### Summary of Changes Made

- Updated promo BT section in `apps/web/src/components/Debts/DebtAccountWizard.tsx`:
  - Added `Max` button next to **Current Balance-Transfer Portion (Optional)**.
  - Added helper text with clickable current-balance value that applies the same max-fill action.
  - Added `max` bound and input clamping so `balanceTransferOutstanding` cannot exceed current
    account balance.
  - Added effect-level cap guard when current balance changes after transfer portion was set.
- Updated tests in `apps/web/src/components/Debts/__tests__/DebtAccountWizard.test.tsx`:
  - New test covers Max fill and cap behavior.
  - Updated shared helper to clear prefilled financial inputs before typing deterministic test
    values.
- Updated docs:
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`
  - `docs/tasks/1501.md`

### Commands Run and Results

- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  - passed
- `npm run test:web -- src/components/Debts/__tests__/DebtAccountWizard.test.tsx src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/DebtAccountsPage.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- Optional: run `npm run ci:local:silent` before push/PR.

## Task State: #1501 Help Center Context + Docs Sync (2026-02-11)

### Goal

Bring Help Center coverage up to date for Debt Planner IA changes and promo BT workflows, and map
debt pages to context-specific help content.

### Summary of Changes Made

- Created follow-up GitHub issue for mixed repayment accounting and underpayment debt carry-forward:
  - `https://github.com/nushydude/expenseflow/issues/1504`
  - local draft: `.github/ISSUES/credit-card-repayment-accounting-modes.md`
- Added new Help Center articles metadata in `apps/web/src/components/Pages/HelpCenter.tsx`:
  - `debt-planner-overview`
  - `credit-card-debt-linking`
  - `balance-transfer-risk-alerts`
- Added full article content for the above in `apps/web/src/utils/helpArticleContentMap.ts`.
- Updated help context mapping in `apps/web/src/utils/helpArticleMapping.ts`:
  - New contexts: `debt-overview`, `debt-accounts`, `debt-account-details`, `debt-account-setup`
  - Expanded debt and payment-method mappings to include new debt/promo/linking articles.
- Updated PageHeader help contexts:
  - `apps/web/src/components/Pages/DebtsPage.tsx` -> `debt-overview`
  - `apps/web/src/components/Pages/DebtAccountsPage.tsx` -> `debt-accounts`
  - `apps/web/src/components/Pages/DebtAccountDetailsPage.tsx` -> `debt-account-details`
  - `apps/web/src/components/Debts/DebtAccountWizardPage.tsx` -> `debt-account-setup`
- Added new user guide:
  - `docs/user-guides/debt-planner-credit-card-linking.md`
- Updated related user guides:
  - `docs/user-guides/promotional-balance-transfer-risk-alert.md`
  - `docs/user-guides/navigation.md`
- Updated task log:
  - `docs/tasks/1501.md`

### Commands Run and Results

- `gh issue create --title "Credit card repayment modes to prevent double counting and model mixed purchase/debt behavior" --body-file .github/ISSUES/credit-card-repayment-accounting-modes.md`
  - created issue `#1504`
- `npm run test:web -- src/components/Pages/__tests__/HelpCenter.test.tsx src/components/Pages/__tests__/DebtsPage.test.tsx src/components/Pages/__tests__/DebtAccountsPage.test.tsx src/components/Pages/__tests__/DebtAccountDetailsPage.test.tsx src/components/Debts/__tests__/DebtAccountWizard.test.tsx`
  - passed
- `npm run test:web -- src/utils/__tests__/helpArticleContentMap.test.ts`
  - passed
- `npm run type-check:fast:web`
  - passed

### Remaining Work / Next Steps

- If green, commit all current branch changes per issue branch workflow.

## Task State: #1519 Debit Card Linked Bank Requirement (2026-02-12)

### Goal

Require linked active bank accounts for debit-card payment methods across create/edit and
quick-create surfaces, including an inline create-bank recovery path.

### Summary of Changes Made

- Enforced debit-card linked-bank validation and active-bank filtering in:
  - `apps/web/src/components/Forms/PaymentMethodForm.tsx`
- Added return-flow handling so bank-account creation can return to debit-card setup:
  - `apps/web/src/components/Pages/PaymentMethodPage.tsx`
- Updated desktop settings modal create/edit flow to preserve debit linked-bank data and reopen
  create modal with debit prefill from return params:
  - `apps/web/src/components/Set/PaymentMethods.tsx`
  - `apps/web/src/components/Set/PaymentMethodModal.tsx`
- Extended quick-create payment-method flow for debit-card linking and inline bank-account creation:
  - `apps/web/src/components/Modals/QuickCreateModal.tsx`
  - `apps/web/src/components/Modals/quickCreatePaymentMethodPayload.ts`
- Updated quick-create handlers to preserve selected payment-method type and linkage (instead of
  forcing `other`):
  - `apps/web/src/components/Forms/hooks/useExpenseForm.ts`
  - `apps/web/src/components/Forms/StoreFormLogic.tsx`
  - `apps/web/src/components/Forms/RecurringPaymentForm.tsx`
  - `apps/web/src/components/Dashboard/NLPExpense.tsx`
  - `apps/web/src/components/ExpenseComponents/QuickAddWithAI.tsx`
- Updated Unified NLP payment-method creation flow for debit linked-bank enforcement + inline bank
  creation:
  - `apps/web/src/components/Dashboard/hooks/useNlpModalState.ts`
  - `apps/web/src/components/Dashboard/hooks/useNlpOperations.ts`
  - `apps/web/src/components/Dashboard/components/NlpModalPaymentMethodStep.tsx`
  - `apps/web/src/components/Dashboard/UnifiedNLPModal.tsx`
- Updated tests:
  - `apps/web/src/components/Forms/__tests__/PaymentMethodForm.test.tsx`
  - `apps/web/src/components/Dashboard/hooks/__tests__/useNlpModalState.test.ts`
  - `apps/web/src/components/Dashboard/hooks/__tests__/useNlpOperations.test.ts`
- Updated docs/help content:
  - `docs/tasks/1519.md`
  - `docs/user-guides/navigation.md`
  - `apps/web/src/utils/helpArticleContentMap.ts`

### Commands Run and Results

- `npm run test:web -- src/components/Forms/__tests__/PaymentMethodForm.test.tsx src/components/Dashboard/hooks/__tests__/useNlpModalState.test.ts src/components/Dashboard/hooks/__tests__/useNlpOperations.test.ts src/components/Forms/__tests__/StoreFormLogic.test.tsx src/components/Forms/__tests__/RecurringPaymentForm.test.tsx src/components/ExpenseComponents/__tests__/QuickAddWithAI.test.tsx src/components/Pages/__tests__/PaymentMethodPage.test.tsx`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - passed (warnings only)

### Remaining Work / Next Steps

- Next follow-up issue to implement: recurring debit-card insufficient-funds alerts +
  notifications/push flow.

## Task State: #1520 Debit recurring linked-bank insufficient-funds alerts (2026-02-12)

### Goal

Add proactive critical alerts for upcoming recurring expenses paid by debit card when the linked
bank account balance is insufficient, including dashboard surfacing, Notification Center entries,
and service-worker push delivery with dedupe per recurring + due-date window.

### Summary of Changes Made

- Added recurring debit insufficient-funds synthesis helper:
  - `apps/api/routes/recurringInsufficientFundsNotifications.ts`
  - `apps/api/routes/recurringInsufficientFundsNotificationTypes.ts`
- Extended recurring notifications output to include debit linked-bank shortfall alerts + create
  payloads:
  - `apps/api/routes/notificationsHelpers.ts`
- Persisted new deduped insufficient-funds notifications and sent push for newly created alerts:
  - `apps/api/routes/notifications.ts`
- Added `recurring_insufficient_funds` notification type support:
  - `apps/api/models/Notification.ts`
  - `packages/shared/src/types/notifications.ts`
  - `packages/shared/src/types/api/notifications.ts`
- Added dashboard critical alert banner and wired it into dashboard:
  - `apps/web/src/components/Dashboard/DebitRecurringInsufficientFundsDashboardAlert.tsx`
  - `apps/web/src/components/Dashboard/Dashboard.tsx`
- Updated Notification Center rendering/deep-link metadata for new type:
  - `apps/web/src/components/Notifications/NotificationCenter.tsx`
- Added/updated regression tests:
  - `apps/api/__tests__/notifications-routes.test.ts`
  - `apps/web/src/components/Dashboard/__tests__/Dashboard.test.tsx`
  - `apps/web/src/components/Notifications/__tests__/NotificationCenter.test.tsx`
- Updated docs/task logs:
  - `docs/tasks/1520.md`
  - `docs/user-guides/navigation.md`
  - `docs/user-guides/push-notifications.md`
  - `docs/PUSH_NOTIFICATIONS_INTERNAL.md`

### Commands Run and Results

- `npm run test:api -- __tests__/notifications-routes.test.ts`
  - passed
- `npm run test:web -- src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Notifications/__tests__/NotificationCenter.test.tsx`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run lint:changed`
  - failed due pre-existing unrelated errors in other changed branch files
- `npx eslint apps/api/routes/recurringInsufficientFundsNotificationTypes.ts apps/api/routes/recurringInsufficientFundsNotifications.ts apps/api/routes/notifications.ts apps/web/src/components/Dashboard/DebitRecurringInsufficientFundsDashboardAlert.tsx`
  - passed with warnings only (no errors)

### Remaining Work / Next Steps

- Commit and merge issue `#1520` into `release/5.5`.
- Move to issue `#1521` (bank-account recurring insufficient-funds alerts) reusing the same
  notification infrastructure.

## Task State: #1521 Bank-account recurring insufficient-funds alerts (2026-02-12)

### Goal

Add critical recurring insufficient-funds alerts for recurring expenses paid directly from bank
accounts, including dashboard surface, Notification Center entries, and deduped push delivery.

### Summary of Changes Made

- Generalized recurring insufficient-funds candidate collection to support:
  - debit-card recurring payments (linked bank account balance)
  - bank-account recurring payments (bank payment method balance)
  - `apps/api/routes/recurringInsufficientFundsNotificationTypes.ts`
- Updated recurring insufficient-funds notification builder:
  - source-aware titles/meta for debit vs bank recurring alerts
  - message includes available balance, shortfall amount, and required amount
  - additive meta keys `fundingAccountId` and `fundingAccountName`
  - `apps/api/routes/recurringInsufficientFundsNotifications.ts`
  - `apps/api/routes/notificationsHelpers.ts`
- Updated shared notification meta types:
  - `packages/shared/src/types/notifications.ts`
  - `packages/shared/src/types/api/notifications.ts`
- Renamed and generalized dashboard alert component for recurring funding risk:
  - `apps/web/src/components/Dashboard/RecurringInsufficientFundsDashboardAlert.tsx`
  - `apps/web/src/components/Dashboard/Dashboard.tsx`
- Added/updated tests:
  - `apps/api/__tests__/notifications-routes.test.ts`
  - `apps/web/src/components/Dashboard/__tests__/Dashboard.test.tsx`
  - `apps/web/src/components/Notifications/__tests__/NotificationCenter.test.tsx`
- Updated docs/help content:
  - `docs/tasks/1521.md`
  - `docs/PUSH_NOTIFICATIONS_INTERNAL.md`
  - `docs/user-guides/push-notifications.md`
  - `docs/user-guides/navigation.md`

### Commands Run and Results

- `npm run test:api -- __tests__/notifications-routes.test.ts`
  - passed
- `npm run test:web -- src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Notifications/__tests__/NotificationCenter.test.tsx`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run build:shared`
  - passed
- `BASE_REF=HEAD npm run lint:changed`
  - passed with warnings only (no errors)
- `npx eslint <touched files>`
  - passed with warnings only (no errors)

### Remaining Work / Next Steps

- Commit changes for issue `#1521`.
- Merge `issue/1521-bank-recurring-insufficient-funds-alerts` into `release/5.5`.
- Move to next follow-up issue (`#1522`, card-expiry warning/notifications/push).

## Task State: #1523 Card expiry missing warnings + card-expiry push alerts (2026-02-12)

### Goal

Add non-critical dismissable dashboard/notification warnings for credit/debit cards missing expiry
dates and send deduped push notifications for newly created card-expiry alerts.

### Summary of Changes Made

- Added notification type support:
  - `card_expiry_missing` in `apps/api/models/Notification.ts`
  - `card_expiry_missing` in `packages/shared/src/types/notifications.ts`
- Extended card notifications synthesis to:
  - include debit cards for expiry checks
  - generate `card_expiry_missing` notifications for cards without expiry dates
  - emit create payloads for deduped persistence and push delivery
  - `apps/api/routes/notificationsHelpers.ts`
- Updated notifications route to persist/push both recurring creates and card creates:
  - `apps/api/routes/notifications.ts`
- Added dashboard warning component and dashboard wiring:
  - `apps/web/src/components/Dashboard/CardExpiryMissingDashboardAlert.tsx`
  - `apps/web/src/components/Dashboard/Dashboard.tsx`
- Updated notification UI handling for the new type:
  - `apps/web/src/components/Notifications/NotificationCenter.tsx`
  - `apps/web/src/components/NotificationsBell.tsx`
  - updated settings copy in `apps/web/src/components/Notifications/NotificationSettings.tsx`
- Added/updated tests:
  - `apps/api/__tests__/notifications-routes.test.ts`
  - `apps/web/src/components/Dashboard/__tests__/Dashboard.test.tsx`
  - `apps/web/src/components/Notifications/__tests__/NotificationCenter.test.tsx`
- Updated docs/help content:
  - `docs/tasks/1523.md`
  - `docs/PUSH_NOTIFICATIONS_INTERNAL.md`
  - `docs/user-guides/navigation.md`
  - `docs/user-guides/push-notifications.md`

### Commands Run and Results

- `npm run test:api -- __tests__/notifications-routes.test.ts`
  - passed
- `npm run test:web -- src/components/Dashboard/__tests__/Dashboard.test.tsx src/components/Notifications/__tests__/NotificationCenter.test.tsx`
  - passed
- `npm run type-check:fast:api`
  - passed
- `npm run type-check:fast:web`
  - passed
- `npm run build:shared`
  - passed
- `BASE_REF=HEAD npm run lint:changed`
  - passed with warnings only (no errors)

### Remaining Work / Next Steps

- Commit changes for issue `#1523`.
- Merge `issue/1523-card-expiry-missing-notifications` into `release/5.5`.

## UX Audit: Admin Debug Push Notification Test (2026-02-12)

Page Type: Utility (Admin Debug)

UX Rule Evaluation:

- Rule 1: pass - page remains focused on debugging/diagnostic utilities.
- Rule 2: pass - no new workflow-primary CTA; action is utility-scoped.
- Rule 3: pass - no new page chrome competing with actions.
- Mobile Action Presentation: pass - no demoted action menu pattern added.
- Mobile Filters Affordance: not applicable.

Findings:

- no violations found.

## Task State: #1525 Admin Debug Push Notification Testing (2026-02-12)

### Goal

Add an admin-only capability on Admin Debug to send a real push notification test through existing
push infrastructure.

### Summary of Changes Made

- Added admin-only API endpoint in `apps/api/routes/admin.ts`:
  - `POST /api/admin/debug/push-test`
  - validates optional `title`, `body`, `link`
  - returns `400` when admin has no push subscriptions
  - sends push via `notificationService.sendPushToUser(...)` with `type: admin_push_test`
- Added API coverage in `apps/api/__tests__/admin-debug-push-routes.test.ts`:
  - success for admin with subscription
  - `400` for no subscriptions
  - `403` for non-admin
- Added web admin API helper in `apps/web/src/services/api/admin.ts`:
  - `sendTestPushNotification()`
- Extended `apps/web/src/hooks/queries/useAdminMutations.ts`:
  - new `sendTestPushNotification` mutation
- Added admin debug UI card in `apps/web/src/components/Pages/Admin/PushNotificationTestCard.tsx`:
  - send action, success/error feedback, toast handling
- Wired card into `apps/web/src/components/Pages/Admin/DebugPage.tsx`.
- Added web tests:
  - `apps/web/src/components/Pages/Admin/__tests__/PushNotificationTestCard.test.tsx`
  - updated `apps/web/src/components/Pages/Admin/__tests__/DebugPage.test.tsx`
  - updated `apps/web/src/hooks/queries/__tests__/useAdminMutations.test.tsx`
- Updated docs:
  - `docs/PUSH_NOTIFICATIONS_INTERNAL.md`
  - `docs/user-guides/push-notifications.md`
  - `docs/tasks/1525.md`

### Commands Run and Results

- `npm run test:api -- __tests__/admin-debug-push-routes.test.ts` -> passed
- `npm run test:web -- src/components/Pages/Admin/__tests__/DebugPage.test.tsx src/components/Pages/Admin/__tests__/PushNotificationTestCard.test.tsx src/hooks/queries/__tests__/useAdminMutations.test.tsx`
  -> passed
- `npm run type-check:fast:api` -> passed
- `npm run type-check:fast:web` -> passed
- `BASE_REF=HEAD npm run lint:changed` -> passed (warnings only)

### Remaining Work / Next Steps

- Ready for commit/merge when requested.

## Task State: #1529 Runtime Type-Safety Debt (2026-02-12)

### Goal

Reduce runtime type-safety debt in API hotspot code without changing behavior.

### Summary of Changes Made

- Refactored `apps/api/services/recurringPaymentService.ts` to remove unsafe `any` usage in service
  logic and model access.
- Added explicit service-level types for auth user shape, linked debt account summary hydration,
  suggestion payloads, and duplicate-match error metadata.
- Replaced `(Model as any)` queries with typed model calls and typed lean results.
- Tightened `markAsPaid` amount handling with explicit required-amount guard.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `npm run test:api` -> passed (147 suites, 1617 tests)
- `BASE_REF=release/5.6 npm run lint:changed` -> passed with warnings only

### Remaining Work / Next Steps

- Commit and merge `issue/1529-runtime-type-safety-pass2-followup` into `release/5.6`.
- Continue with `#1530`, `#1531`, `#1532` in order.

## Task State: #1530 Oversized Runtime Module Reduction (2026-02-12)

### Goal

Reduce oversized runtime module risk in recurring-payment service flows while preserving contracts.

### Summary of Changes Made

- Split `apps/api/services/recurringPaymentService.ts` into focused modules under
  `apps/api/services/recurringPaymentService/`.
- Kept `apps/api/services/recurringPaymentService.ts` as a compatibility wrapper so existing imports
  remain stable.
- Added `apps/api/services/__tests__/recurringPaymentService.smoke.test.ts` to guard the public
  service API surface.

### Commands Run and Results

- `npm run type-check:fast:api` -> passed
- `npm run test:api -- services/__tests__/recurringPaymentService.smoke.test.ts __tests__/recurring-debt-account.test.ts __tests__/recurring-completion.test.ts __tests__/recurring-suggestions.test.ts __tests__/recurring-insufficient-funds.test.ts __tests__/recurring-savings-goal.test.ts`
  -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed with warnings only

### Remaining Work / Next Steps

- Commit and merge `issue/1530-reduce-oversized-runtime-modules-pass2-phase2` into `release/5.6`.
- Continue with `#1531`.

## Task State: #1531 Deep Relative Import Guardrails (2026-02-12)

### Goal

Reduce deep relative import coupling and prevent future growth via guardrails.

### Summary of Changes Made

- Migrated targeted admin page imports from deep relative paths to `@/...` aliases.
- Expanded UI barrel exports to include `MultiSelectDropdown` and `IconOnlyButton` so alias
  migration remains compatible with the UI import contract.
- Added `scripts/check-deep-relative-imports.js` and wired it into `lint`/`lint:changed` via
  `package.json`.
- Updated `docs/AI_ASSISTANT_GUIDELINES.md` with the new guardrail command.

### Commands Run and Results

- `npm run type-check:fast:web` -> passed
- `BASE_REF=release/5.6 npm run lint:changed` -> passed with warnings only
- `npm run test:web -- src/components/Pages/Admin` -> passed
- `npm run check:deep-relative-imports` -> passed

### Remaining Work / Next Steps

- Commit and merge `issue/1531-reduce-deep-relative-import-coupling-guardrails` into `release/5.6`.
- Continue with `#1532`.

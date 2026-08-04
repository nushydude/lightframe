# 63 - Settings Information Architecture and Accessibility

## Priority and Type

- Priority: P1
- Type: product design, accessibility, maintainability
- Dependencies: task 59 is recommended but not mandatory
- Expected branch: `codex/settings-ia-accessibility`
- Required final gate: `pnpm run ci:frontend`

## Goal

Replace the single long Settings modal with a navigable, searchable, keyboard-safe settings
workspace while preserving every current setting, validation rule, save/retry behavior, codec
diagnostic, and system integration.

## Required Sections

Use these sections unless implementation evidence supports a small naming adjustment:

1. General
   - theme.
   - window bounds.
   - update channel.
   - default-app integration.
2. Viewing
   - image fit.
   - thumbnails.
   - captions.
   - mouse wheel.
   - folder sort and refresh.
3. Review
   - saved review presets.
   - review behavior introduced by tasks 61/62 when present.
4. Slideshow and Present
   - interval, direction, loop, shuffle, fullscreen, projector options.
5. Editing
   - crop save behavior.
   - quick destinations.
   - external editor.
6. Performance
   - performance mode.
   - cache summary and cache controls.
7. Support
   - format/codec health.
   - diagnostics preview/export.
   - app version.

If review-session tasks are not yet merged, create a section that can accept those settings later
without adding nonexistent controls.

## Layout Requirements

- Left navigation at wide widths.
- Compact select/tab navigation at narrow widths.
- One scrollable content area whose heading matches the selected section.
- Settings search available from the header.
- Search results show setting label, section, and relevant help text.
- Choosing a result navigates to and focuses the setting.
- Section selection and search query are ephemeral; do not persist them unless a clear UX benefit is
  demonstrated.

## Accessibility Requirements

- Dialog uses `role="dialog"`, `aria-modal="true"`, and a labelled heading.
- Focus moves into the dialog when opened.
- Tab/Shift+Tab remain inside while open.
- Escape closes only the topmost settings subdialog/menu.
- Focus returns to the exact opener on close.
- Section navigation uses appropriate tab/list semantics with selected state.
- Every input has a programmatic label; visible labels use `htmlFor`.
- Toggle state is announced.
- Help text uses `aria-describedby` where useful.
- Save, load, codec, and cache status messages use appropriate polite/assertive live regions.
- Keyboard and screen-reader operation do not depend on hover.
- Reduced-motion and forced-colors modes remain usable.

## Component Architecture

Create schema/metadata for search and navigation:

```ts
type SettingDefinition = {
  id: string;
  section: SettingsSectionId;
  label: string;
  keywords?: string[];
  help?: string;
};
```

Do not move persisted values into a second store. `settingsStore` remains authoritative.

Extract focused section components and reusable field primitives:

- settings row.
- toggle.
- select/input.
- help text.
- status/error block.
- destructive/maintenance button group.

Avoid a general-purpose component library in this task.

## Behavioral Requirements

- Optimistic/pessimistic save semantics remain exactly as defined by task 48/current store.
- Leaving a section cannot discard an in-flight change.
- Search never mutates settings.
- Cache clear and codec retry retain busy/error states.
- External editor and destination dialogs return focus correctly.
- Diagnostics export remains explicitly user initiated.
- All current IDs relied on by tests or automation are preserved or mapped deliberately.

## Required Tests

- Every existing setting appears in exactly one section.
- Search finds labels, keywords, and help text case-insensitively.
- Search result navigation focuses the correct field.
- Wide and narrow navigation variants select the same section.
- Initial focus, focus trap, Escape, nested dialog behavior, and focus restoration.
- Save/load error and retry survive section changes.
- No setting value changes merely from navigation/search.
- Codec/cache/diagnostics busy and error states.
- Keyboard-only operation of toggles and section navigation.
- At least one forced-colors/reduced-motion CSS assertion or manual verification.

## Manual QA

- 640px, 800px, and 1200px windows.
- dark, light, and system themes.
- 100%, 150%, and 200% Windows scaling where available.
- keyboard only.
- screen reader smoke test if available.
- settings load failure and save failure injection.

## Validation Commands

```powershell
pnpm run test:run -- src/components/SettingsPanel.test.tsx src/state/settingsStore.test.ts
pnpm run ci:frontend
pnpm tauri dev
```

## Acceptance Criteria

- Settings are divided into the seven coherent sections.
- Search navigates to real controls.
- Modal focus behavior meets the stated requirements.
- No setting or support action is lost.
- Save/retry/error behavior remains reliable across navigation.
- Minimum-width and scaled layouts remain usable.

## Reviewer Checklist

- Use a source inventory to ensure no setting disappeared.
- Test focus with nested dialogs and menus.
- Reject visual-only tabs without correct keyboard semantics.
- Confirm search metadata cannot drift silently from rendered settings.
- Confirm no duplicate settings state was introduced.

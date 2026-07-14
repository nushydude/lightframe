export function isInteractiveTargetOutsideGrid(
  target: EventTarget | null,
  grid: Element | null
): boolean {
  if (!(target instanceof Element)) return false;

  const interactive = target.closest(
    'input, select, textarea, button, a, [contenteditable="true"]'
  );
  return Boolean(interactive && !(grid?.contains(interactive) ?? false));
}

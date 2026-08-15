export const dialogFocusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapDialogTabKey(panel: HTMLElement, event: KeyboardEvent, activeElement: Element | null = document.activeElement) {
  if (event.key !== 'Tab') return;
  const focusable = [...panel.querySelectorAll<HTMLElement>(dialogFocusableSelector)];
  if (focusable.length === 0) { event.preventDefault(); panel.focus(); return; }
  const first = focusable[0]!; const last = focusable.at(-1)!;
  if (!panel.contains(activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  else if (event.shiftKey && activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && activeElement === last) { event.preventDefault(); first.focus(); }
}

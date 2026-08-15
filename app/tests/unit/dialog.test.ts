import { describe, expect, it, vi } from 'vitest';
import { trapDialogTabKey } from '../../src/client/components/dialog-focus.js';

function focusTarget() {
  return { focus: vi.fn() } as unknown as HTMLElement;
}

function tabEvent(shiftKey: boolean) {
  return { key: 'Tab', shiftKey, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe('dialog focus trap', () => {
  it.each([
    { shiftKey: false, target: 'first' },
    { shiftKey: true, target: 'last' },
  ] as const)('pulls focus back to the $target control when it has left the panel', ({ shiftKey, target }) => {
    const first = focusTarget();
    const last = focusTarget();
    const panel = {
      contains: () => false,
      focus: vi.fn(),
      querySelectorAll: () => [first, last],
    } as unknown as HTMLDivElement;
    const event = tabEvent(shiftKey);

    trapDialogTabKey(panel, event, {} as Element);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(target === 'first' ? first.focus : last.focus).toHaveBeenCalledOnce();
  });
});

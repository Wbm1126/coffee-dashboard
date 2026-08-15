import { useEffect, useRef, type ReactNode } from 'react';
import { dialogFocusableSelector, trapDialogTabKey } from './dialog-focus';

interface DialogProps {
  open: boolean;
  labelledBy: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
  className?: string;
}

export function Dialog({ open, labelledBy, onClose, returnFocusTo, children, className = '' }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = returnFocusTo ?? document.activeElement as HTMLElement | null;
    panel?.querySelector<HTMLElement>(dialogFocusableSelector)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (panel) trapDialogTabKey(panel, event);
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('dialog-open');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('dialog-open');
      previouslyFocused?.focus();
    };
  }, [onClose, open, returnFocusTo]);
  if (!open) return null;
  return <div className="dialog-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} className={`dialog-panel ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
      {children}
    </div>
  </div>;
}

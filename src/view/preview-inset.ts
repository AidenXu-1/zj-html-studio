/** Keep a floating host status bar outside the course's visible/captured area. */
export function previewBottomInset(view: HTMLElement, statusBar: HTMLElement | null): number {
  if (!statusBar?.isConnected || !statusBar.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return 0;
  const area = view.getBoundingClientRect(), bar = statusBar.getBoundingClientRect();
  if (!area.height || !bar.width || !bar.height || bar.right <= area.left || bar.left >= area.right
    || bar.bottom < area.bottom - 1 || bar.top >= area.bottom) return 0;
  return Math.ceil(Math.min(area.height, area.bottom - bar.top));
}

export function observePreviewInset(view: HTMLElement, win: Window): { update: () => void; stop: () => void } {
  let statusBar: HTMLElement | null = null;
  let frame = 0;
  const update = (): void => {
    if (frame || win.closed) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (view.ownerDocument !== win.document) return;
      const bar = win.document.querySelector<HTMLElement>('.status-bar');
      if (bar !== statusBar) {
        if (statusBar) observer.unobserve(statusBar);
        statusBar = bar;
        if (statusBar) observer.observe(statusBar);
      }
      const value = `${previewBottomInset(view, statusBar)}px`;
      // Avoid triggering the picture observer on every unchanged layout event.
      if (view.style.getPropertyValue('--html-studio-bottom-inset') !== value) view.style.setProperty('--html-studio-bottom-inset', value);
    });
  };
  const observer = new ResizeObserver(update);
  observer.observe(view);
  const onTransition = (event: TransitionEvent): void => {
    const target = event.target as Element | null;
    if (target?.contains?.(view) || target === statusBar) update();
  };
  win.addEventListener('resize', update);
  win.document.addEventListener('transitionend', onTransition);
  update();
  return { update, stop: () => {
    // This observer is owned by the plugin's realm, not the migrated window.
    observer.disconnect();
    if (!win.closed) {
      win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', update);
      win.document.removeEventListener('transitionend', onTransition);
    }
  } };
}

/** The tray icon's hover text. The count is left out while stream-safe mode hides mail. */
export function trayTooltip(unread: number): string {
  return unread > 0 ? `IMC-Mail: ${unread} unread` : 'IMC-Mail'
}

/** What closing the window does: hide to the tray, or really quit. */
export function closeAction(opts: { closeToTray: boolean; quitting: boolean }): 'hide' | 'close' {
  return opts.closeToTray && !opts.quitting ? 'hide' : 'close'
}

import { describe, expect, it } from 'vitest'
import { closeAction, trayTooltip } from './tray'

describe('tray', () => {
  it('shows the unread count in the tooltip, and nothing extra when there is none', () => {
    expect(trayTooltip(0)).toBe('IMC-Mail')
    expect(trayTooltip(12)).toBe('IMC-Mail: 12 unread')
  })
  it('hides on close only when asked to and not while quitting', () => {
    expect(closeAction({ closeToTray: true, quitting: false })).toBe('hide')
    expect(closeAction({ closeToTray: true, quitting: true })).toBe('close')
    expect(closeAction({ closeToTray: false, quitting: false })).toBe('close')
  })
})

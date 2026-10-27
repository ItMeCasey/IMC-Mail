// A browser-style history of the screens a person has been through, for the phone: Back returns to the previous screen,
// and Forward goes to the one just left (until something new is opened, which drops what was ahead). Kept as plain
// functions over a value so it can be tested without a phone.

export interface NavHistory<T> {
  entries: readonly T[]
  index: number
}

/** How many screens are remembered. */
const MAX_ENTRIES = 50

export const navStart = <T>(first: T): NavHistory<T> => ({ entries: [first], index: 0 })
export const navCurrent = <T>(h: NavHistory<T>): T => h.entries[h.index]!
export const navCanBack = <T>(h: NavHistory<T>): boolean => h.index > 0
export const navCanForward = <T>(h: NavHistory<T>): boolean => h.index < h.entries.length - 1

/** Opens a new screen after the current one. Anything that was ahead (reachable by Forward) is dropped. */
export function navPush<T>(h: NavHistory<T>, screen: T): NavHistory<T> {
  const entries = [...h.entries.slice(0, h.index + 1), screen].slice(-MAX_ENTRIES)
  return { entries, index: entries.length - 1 }
}

export const navBack = <T>(h: NavHistory<T>): NavHistory<T> => (navCanBack(h) ? { ...h, index: h.index - 1 } : h)
export const navForward = <T>(h: NavHistory<T>): NavHistory<T> => (navCanForward(h) ? { ...h, index: h.index + 1 } : h)

/** Takes screens out of the history that no longer make sense (an account that was removed), keeping the current one when it stays. */
export function navFilter<T>(h: NavHistory<T>, keep: (screen: T) => boolean, fallback: T): NavHistory<T> {
  const cur = navCurrent(h)
  const entries = h.entries.filter(keep)
  if (entries.length === 0) return navStart(fallback)
  const at = keep(cur) ? entries.lastIndexOf(cur) : Math.min(h.index, entries.length - 1)
  return { entries, index: Math.max(0, at) }
}

import { useEffect, useState } from 'react'

// Screens that show synced things (labels, deals, the calendar) need to redraw when those change: after a sync brings
// something in, or when this phone changes one. This is the one place that says "something changed".

const listeners = new Set<() => void>()

export function notifyChanged(): void {
  for (const l of [...listeners]) l()
}

/** A number that goes up each time something changed. Put it in an effect's list to run again then. */
export function useChanged(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const l = () => setN((x) => x + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return n
}

export interface ThreadInput {
  id: string
  /** The Message-ID header, with angle brackets. */
  messageId: string | null
  /** In-Reply-To and References, with angle brackets. */
  refs: string[]
  subject: string
  date: number
}

const PREFIX = /^\s*((re|fwd?|aw|wg|sv|vs|antw|tr|rv|enc)(\[\d+\])?\s*:\s*)+/i

export const isReplySubject = (s: string): boolean => PREFIX.test(s)

/** "Re: Re: Fwd:  Hello  World" -> "hello world" */
export function normalizeSubject(s: string): string {
  return s.replace(PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Extracts every <message-id> from a References / In-Reply-To header value. */
export function parseMessageIds(header: string): string[] {
  return header.match(/<[^<>\s]+>/g) ?? []
}

const SUBJECT_WINDOW_MS = 60 * 24 * 3600 * 1000

/**
 * Groups one account's messages into conversations.
 *
 * Messages connect through Message-ID / In-Reply-To / References, so two replies to a
 * message we never downloaded still join via their shared ancestor. A reply with no usable
 * references falls back to subject matching, but only against an earlier non-reply message
 * with the same subject, so bulk mail sharing a subject ("Your receipt") never merges.
 *
 * Returns message id -> thread key. The key is the id of the oldest message in the thread.
 */
export function computeThreads(msgs: ThreadInput[]): Map<string, string> {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    while (parent.get(x) !== r) {
      const next = parent.get(x)!
      parent.set(x, r)
      x = next
    }
    return r
  }
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x)
  }
  const union = (a: string, b: string) => {
    add(a)
    add(b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const node = (m: ThreadInput) => m.messageId ?? `local:${m.id}`
  for (const m of msgs) {
    add(node(m))
    for (const r of m.refs) union(node(m), r)
  }

  // Subject fallback for replies that no reference connects to anything.
  const size = new Map<string, number>()
  for (const m of msgs) size.set(find(node(m)), (size.get(find(node(m))) ?? 0) + 1)
  const originals = new Map<string, ThreadInput[]>()
  for (const m of msgs) {
    if (isReplySubject(m.subject)) continue
    const key = normalizeSubject(m.subject)
    if (!key) continue
    originals.set(key, [...(originals.get(key) ?? []), m])
  }
  for (const m of msgs) {
    if (!isReplySubject(m.subject) || (size.get(find(node(m))) ?? 0) > 1) continue
    const key = normalizeSubject(m.subject)
    const candidates = (originals.get(key) ?? []).filter(
      (o) => o.date <= m.date && m.date - o.date <= SUBJECT_WINDOW_MS
    )
    // Only join an unambiguous original; two candidates means a generic subject.
    if (candidates.length === 1) union(node(m), node(candidates[0]!))
  }

  const oldest = new Map<string, ThreadInput>()
  for (const m of msgs) {
    const root = find(node(m))
    const cur = oldest.get(root)
    if (!cur || m.date < cur.date || (m.date === cur.date && m.id < cur.id)) oldest.set(root, m)
  }
  const out = new Map<string, string>()
  for (const m of msgs) out.set(m.id, oldest.get(find(node(m)))!.id)
  return out
}

import type { Summary } from './imap'

// Searching the saved message list. Words must all appear in the sender, recipients or subject; operators narrow it:
// from:alex  to:me  subject:invoice  is:unread  is:read  is:starred  label:sponsors  (quote a name with spaces).

export interface SearchContext {
  /** The names of the labels on a message. */
  labelsOf?: (m: Summary) => string[]
}

export interface ParsedQuery {
  words: string[]
  from: string[]
  to: string[]
  subject: string[]
  label: string[]
  unread?: boolean
  starred?: boolean
}

const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Splits a search into words and operators. Quotes keep a phrase together; `from:"Alex Rivera"` works too. */
export function parseQuery(text: string): ParsedQuery {
  const q: ParsedQuery = { words: [], from: [], to: [], subject: [], label: [] }
  for (const m of text.matchAll(/(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const op = m[1]?.toLowerCase()
    const value = norm(m[2] ?? m[3] ?? '')
    if (!value) continue
    if (op === 'from') q.from.push(value)
    else if (op === 'to') q.to.push(value)
    else if (op === 'subject') q.subject.push(value)
    else if (op === 'label' || op === 'tag') q.label.push(value)
    else if (op === 'is' && value === 'unread') q.unread = true
    else if (op === 'is' && value === 'read') q.unread = false
    else if (op === 'is' && (value === 'starred' || value === 'flagged')) q.starred = true
    else q.words.push(norm(m[0]!.replace(/^"|"$/g, '')))
  }
  return q
}

const people = (list: { name: string; address: string }[]) => norm(list.map((a) => `${a.name} ${a.address}`).join(' '))

/** The messages that match, in the order given. An empty search matches everything. */
export function searchSummaries(list: Summary[], text: string, ctx: SearchContext = {}): Summary[] {
  const q = parseQuery(text)
  return list.filter((m) => {
    const from = norm(m.from ? `${m.from.name} ${m.from.address}` : '')
    const to = people([...m.to, ...m.cc])
    const subject = norm(m.subject)
    if (q.unread !== undefined && m.flags.includes('\\Seen') === q.unread) return false
    if (q.starred && !m.flags.includes('\\Flagged')) return false
    if (q.from.some((w) => !from.includes(w))) return false
    if (q.to.some((w) => !to.includes(w))) return false
    if (q.subject.some((w) => !subject.includes(w))) return false
    if (q.label.length > 0) {
      const names = (ctx.labelsOf?.(m) ?? []).map(norm)
      if (q.label.some((w) => !names.some((n) => n.includes(w)))) return false
    }
    return q.words.every((w) => from.includes(w) || to.includes(w) || subject.includes(w))
  })
}

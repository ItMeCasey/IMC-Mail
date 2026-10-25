/**
 * Search query language, e.g.  from:nova "q4 brief" is:unread has:attachment after:2026-10-01
 *
 *   from: to: subject:      match inside that field (prefix match)
 *   "exact phrase"          phrase match; bare words match anywhere and as prefixes
 *   -word                   exclude messages containing the word
 *   is:unread|read|starred  flags
 *   has:attachment          downloaded messages with a real attachment
 *   account:work            account email or name contains "work"
 *   in:inbox|sent|trash|... folder role or folder name
 *   before:YYYY-MM-DD after:YYYY-MM-DD
 */

export interface ParsedQuery {
  /** FTS5 MATCH expression, or null when only filters were given. */
  fts: string | null
  is: ('unread' | 'read' | 'starred' | 'suspicious')[]
  hasAttachment: boolean
  account: string[]
  inFolder: string[]
  /** Epoch ms, local midnight, exclusive upper bound. */
  before: number | null
  /** Epoch ms, local midnight, inclusive lower bound. */
  after: number | null
  category: string[]
}

const FIELD: Record<string, string> = { from: 'sender', to: 'recipients', subject: 'subject' }

/** Splits on spaces, keeping "quoted phrases" (and key:"quoted values") together. */
export function tokenize(q: string): string[] {
  const out: string[] = []
  const re = /(-?[A-Za-z]+:)?(-?)"([^"]*)"?|\S+/g
  for (let m = re.exec(q); m; m = re.exec(q)) out.push(m[0])
  return out
}

const clean = (s: string) => s.replace(/["*()^:]/g, ' ').replace(/\s+/g, ' ').trim()

/** One FTS5 operand: a quoted phrase, or a quoted word matched as a prefix. */
function operand(text: string, phrase: boolean): string | null {
  const t = clean(text)
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return null
  return phrase || t.includes(' ') ? `"${t}"` : `"${t}"*`
}

function parseDate(v: string): number | null {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = {
    fts: null,
    is: [],
    hasAttachment: false,
    account: [],
    inFolder: [],
    before: null,
    after: null,
    category: []
  }
  const positive: string[] = []
  const negative: string[] = []

  for (const raw of tokenize(q)) {
    const op = /^([A-Za-z]+):(.*)$/s.exec(raw)
    if (op) {
      const key = op[1]!.toLowerCase()
      const value = op[2]!.replace(/^"|"$/g, '').trim()
      if (FIELD[key]) {
        const o = operand(value, /^".*"$/.test(op[2]!))
        if (o) positive.push(`${FIELD[key]} : ${o}`)
        continue
      }
      if (key === 'is') {
        const v = value.toLowerCase()
        if (v === 'unread' || v === 'read' || v === 'starred' || v === 'suspicious') out.is.push(v)
        else if (v === 'scam' || v === 'phishing') out.is.push('suspicious')
        else if (v === 'flagged') out.is.push('starred')
        continue
      }
      if (key === 'has') {
        if (/^attach/i.test(value)) out.hasAttachment = true
        continue
      }
      if (key === 'account') {
        if (value) out.account.push(value.toLowerCase())
        continue
      }
      if (key === 'in') {
        if (value) out.inFolder.push(value.toLowerCase())
        continue
      }
      if (key === 'category' || key === 'cat' || key === 'type') {
        if (value) out.category.push(value.toLowerCase())
        continue
      }
      if (key === 'before' || key === 'after') {
        const t = parseDate(value)
        if (t !== null) out[key] = t
        continue
      }
      // An unknown operator with nothing after it ("re:") is just noise.
      if (!value) continue
      // Anything else ("http://...") is plain text.
    }
    const neg = raw.startsWith('-') && raw.length > 1
    const body = neg ? raw.slice(1) : raw
    const o = operand(body.replace(/^"|"$/g, ''), /^".*"$/.test(body))
    if (!o) continue
    ;(neg ? negative : positive).push(o)
  }

  if (positive.length > 0) {
    out.fts = [positive.join(' '), ...negative.map((n) => `NOT ${n}`)].join(' ')
  }
  return out
}

export interface BuiltSearch {
  sql: string
  params: Record<string, unknown>
}

export const SEARCH_LIMIT = 200

/** SQL for a parsed query. Trash and Junk are skipped unless `in:` asks for them. */
export function buildSearch(p: ParsedQuery, limit = SEARCH_LIMIT): BuiltSearch {
  const where: string[] = []
  const params: Record<string, unknown> = { limit }
  const from = p.fts
    ? 'message_fts f JOIN message m ON m.rowid = f.rowid'
    : 'message m'
  if (p.fts) {
    where.push('message_fts MATCH @fts')
    params['fts'] = p.fts
  }
  for (const s of p.is) {
    where.push(
      s === 'unread'
        ? "instr(m.flags, '\\Seen') = 0"
        : s === 'read'
          ? "instr(m.flags, '\\Seen') > 0"
          : s === 'suspicious'
            ? "m.risk_safe = 0 AND m.risk IN ('caution', 'danger')"
            : "instr(m.flags, '\\Flagged') > 0"
    )
  }
  if (p.hasAttachment) {
    where.push(
      `EXISTS (SELECT 1 FROM message_body b, json_each(b.attachments) j
                WHERE b.message_id = m.id AND json_extract(j.value, '$.inline') = 0)`
    )
  }
  p.account.forEach((a, i) => {
    where.push(`(lower(ac.email) LIKE @acc${i} OR lower(ac.display_name) LIKE @acc${i})`)
    params[`acc${i}`] = `%${a}%`
  })
  if (p.inFolder.length > 0) {
    const parts = p.inFolder.map((f, i) => {
      params[`in${i}`] = f
      params[`inlike${i}`] = `%${f}%`
      return `(fo.role = @in${i} OR lower(fo.name) LIKE @inlike${i})`
    })
    where.push(`(${parts.join(' OR ')})`)
  } else {
    where.push("(fo.role IS NULL OR fo.role NOT IN ('trash', 'junk'))")
  }
  p.category.forEach((c, i) => {
    where.push(`COALESCE(m.category_manual, m.category, 'other') LIKE @cat${i}`)
    params[`cat${i}`] = `${c}%`
  })
  if (p.before !== null) {
    where.push('m.date < @before')
    params['before'] = p.before
  }
  if (p.after !== null) {
    where.push('m.date >= @after')
    params['after'] = p.after
  }

  return {
    sql: `SELECT m.id, m.account_id, m.folder_id, m.uid, m.from_name, m.from_addr, m.subject,
                 m.date, m.flags, COALESCE(m.category_manual, m.category, 'other') AS category,
                 CASE WHEN m.risk_safe = 1 THEN 'none' ELSE COALESCE(m.risk, 'none') END AS risk,
                 NULL AS snoozed_until,
                 NULL AS follow_up_at,
                 EXISTS (SELECT 1 FROM event_message em WHERE em.message_id = m.id) AS has_invite,
                 CASE WHEN m.thread_id IS NULL THEN 1
                      ELSE (SELECT COUNT(*) FROM message t WHERE t.thread_id = m.thread_id) END
                   AS thread_size
            FROM ${from}
            JOIN folder fo ON fo.id = m.folder_id
            JOIN account ac ON ac.id = m.account_id
           WHERE ${where.join(' AND ')}
           ORDER BY m.date DESC, m.uid DESC
           LIMIT @limit`,
    params
  }
}

/**
 * Message templates ("snippets"): canned replies with {{variables}}. Pure, so desktop and mobile
 * fill them the same way.
 */

export interface TemplateVars {
  /** The first recipient, as typed: "Pat Lee <pat@brand.example>" or "pat@brand.example". */
  recipient?: string
  /** Who is writing. */
  myName?: string
  myEmail?: string
  subject?: string
  /** Override the brand guessed from the recipient. */
  brand?: string
  now?: Date
}

/** "Pat Lee <pat@x.co>" -> { name: "Pat Lee", address: "pat@x.co" }. */
export function parseRecipient(entry: string): { name: string; address: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry)
  if (m) return { name: (m[1] ?? '').trim(), address: (m[2] ?? '').trim() }
  return { name: '', address: entry.trim() }
}

/** A readable company name: the display name without a trailing "(note)", else the domain. */
export function brandFrom(name: string, addr: string): string {
  const clean = name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^"|"$/g, '').trim()
  if (clean && !clean.includes('@')) return clean
  const domain = addr.slice(addr.lastIndexOf('@') + 1).split('.')[0] ?? ''
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'New deal'
}

const FREE = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','gmx.com','gmx.net','mail.com','zoho.com'])

/** A company name from a work address's domain; empty for personal mailboxes. */
function brandFromAddress(addr: string): string {
  const domain = addr.slice(addr.lastIndexOf('@') + 1).toLowerCase()
  if (!addr.includes('@') || FREE.has(domain)) return ''
  const label = domain.split('.')[0] ?? ''
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' })
const LONG_DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long' })

export function variableValues(v: TemplateVars): Record<string, string> {
  const r = v.recipient ? parseRecipient(v.recipient) : { name: '', address: '' }
  const looksLikeName = r.name && !r.name.includes('@')
  const first = looksLikeName ? (r.name.split(/\s+/)[0] ?? '') : ''
  const now = v.now ?? new Date()
  const out: Record<string, string> = {
    name: looksLikeName ? r.name : '',
    first_name: first,
    email: r.address,
    brand: v.brand ?? brandFromAddress(r.address),
    my_name: v.myName ?? '',
    my_email: v.myEmail ?? '',
    subject: v.subject ?? '',
    date: LONG_DATE.format(now),
    today: LONG_DATE.format(now),
    weekday: WEEKDAY.format(now)
  }
  // Drop what we could not work out, so it stays visible as {{variable}} for you to fill in.
  for (const k of Object.keys(out)) if (!out[k]) delete out[k]
  return out
}

const VAR = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g

export const hasPlaceholders = (text: string): boolean => /\{\{\s*[A-Za-z_]\w*\s*\}\}/.test(text)

/** Names of the {{variables}} in a text, without duplicates. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]!.toLowerCase()))]
}

/**
 * Fills known variables (case-insensitive). Unknown or unavailable ones are left in place so the
 * writer sees what still needs filling; `unresolved` lists them.
 */
export function fillTemplate(
  text: string,
  vars: TemplateVars,
  /** Escape values for HTML bodies. */
  html = false
): { text: string; unresolved: string[] } {
  const values = variableValues(vars)
  const unresolved = new Set<string>()
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out = text.replace(VAR, (whole, key: string) => {
    const v = values[key.toLowerCase()]
    if (v === undefined) {
      unresolved.add(key.toLowerCase())
      return whole
    }
    return html ? esc(v) : v
  })
  return { text: out, unresolved: [...unresolved] }
}

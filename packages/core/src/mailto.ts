// Reading a mailto: link (RFC 6068): who it is to, the subject and the text, so IMC-Mail can open a new message filled in
// when it is the app that handles mail links. Shared by the desktop and the phone.
//
// A link comes from anywhere (a web page, another app), so it is treated as untrusted: only the fields a person would
// expect are read, line breaks are taken out of anything that becomes a header, lengths are capped, and things a link
// could use to cause harm (such as an "attach" field naming a file on this computer) are ignored.

export interface MailtoDraft {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** Plain text for the body. */
  body: string
}

const MAX_RECIPIENTS = 50
const MAX_SUBJECT = 300
const MAX_BODY = 50_000
const ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/

/** Percent-decoding that does not fail on a stray "%". Also turns "+" into a space only where a form would (not here). */
function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
  }
}

/** Addresses from text that may hold several, separated by commas or semicolons. Anything that is not an address is dropped. */
function addresses(text: string): string[] {
  const out: string[] = []
  for (const part of decode(text).split(/[,;]/)) {
    // "Name <a@b.com>" is not valid in a mailto but is common; take what is inside the brackets.
    const inside = /<([^>]+)>/.exec(part)?.[1] ?? part
    const a = inside.trim()
    if (ADDRESS.test(a) && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a)
  }
  return out
}

/** One line of text with no line breaks or other control characters, so it cannot add a header. */
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_SUBJECT)

/** A body keeps its line breaks (as \n) and drops other control characters. */
const bodyText = (s: string): string =>
  s
    .replace(/\r\n|\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, MAX_BODY)

/** The draft a mailto: link asks for, or null when the text is not a mailto link or names no one and says nothing. */
export function parseMailto(link: string): MailtoDraft | null {
  const text = link.trim()
  if (!/^mailto:/i.test(text)) return null
  const rest = text.slice('mailto:'.length).replace(/^\/\//, '')
  const q = rest.indexOf('?')
  const path = q === -1 ? rest : rest.slice(0, q)
  const query = q === -1 ? '' : rest.slice(q + 1)

  const draft: MailtoDraft = { to: addresses(path), cc: [], bcc: [], subject: '', body: '' }
  for (const pair of query.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const name = decode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase()
    const value = eq === -1 ? '' : pair.slice(eq + 1)
    switch (name) {
      case 'to':
        for (const a of addresses(value)) if (!draft.to.some((x) => x.toLowerCase() === a.toLowerCase())) draft.to.push(a)
        break
      case 'cc':
        draft.cc.push(...addresses(value))
        break
      case 'bcc':
        draft.bcc.push(...addresses(value))
        break
      case 'subject':
        draft.subject = oneLine(decode(value))
        break
      case 'body':
        draft.body = bodyText(decode(value))
        break
      // Everything else (attach, in-reply-to, x-...) is ignored on purpose.
    }
  }
  draft.to = draft.to.slice(0, MAX_RECIPIENTS)
  draft.cc = [...new Set(draft.cc)].slice(0, MAX_RECIPIENTS)
  draft.bcc = [...new Set(draft.bcc)].slice(0, MAX_RECIPIENTS)
  // A link with no one to send to is still useful (a body and subject to start from), but an empty one is not.
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0 && draft.subject === '' && draft.body === '') return null
  return draft
}

/** The first mailto link in a list of command-line arguments (how Windows hands a clicked link to a program), or null. */
export function mailtoFromArgs(args: readonly string[]): string | null {
  return args.find((a) => /^mailto:/i.test(a.trim())) ?? null
}

/**
 * The files named by "--attach <path>" in a program's arguments, in order. This is how the Explorer right-click item
 * "Mail this" hands a file over. A path that is another flag, or empty, is skipped.
 */
export function attachPathsFromArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--attach') continue
    const p = args[i + 1]!.trim()
    if (p !== '' && !p.startsWith('--')) out.push(p)
  }
  return out
}

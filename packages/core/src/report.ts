/**
 * Problem reports go to GitHub Issues through a pre-filled "new issue" page that opens in your
 * browser: you read it, edit it and press Submit with your own GitHub account. Nothing is sent
 * from the app, and no token is shipped inside it.
 */

export const ISSUES_REPO = 'ItMeCasey/IMC-Mail'

/**
 * Where "Send report" posts to: the relay on the project's website, which files the GitHub issue
 * (see services/report-relay). If it is empty, or the relay is unreachable, the app offers the
 * pre-filled GitHub page instead. Can be overridden with the IMC_REPORT_URL environment variable.
 */
export const REPORT_RELAY_URL = 'https://itmecasey.com/imc-mail/report'

/** Only a secure address (or this computer, for testing) may receive a report. */
export function isAllowedRelayUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
  } catch {
    return false
  }
}

/**
 * Takes out what should not leave the computer: email addresses, your Windows user name in file
 * paths, and long token-like strings. Applied to every error text before it is shown or sent.
 */
export function scrub(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/([A-Za-z]:\\+Users\\+)[^\\/\s'"]+/g, '$1<user>')
    .replace(/(\/(?:Users|home)\/)[^/\s'"]+/g, '$1<user>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}

export interface CrashEntry {
  /** Epoch ms. */
  at: number
  kind: 'error' | 'rejection' | 'renderer-gone' | 'process-gone'
  message: string
  stack?: string
}

export interface ReportInfo {
  version: string
  platform: string
  electron?: string
  note?: string
  crashes: CrashEntry[]
}

const KIND_LABEL: Record<CrashEntry['kind'], string> = {
  error: 'Uncaught error',
  rejection: 'Unhandled rejection',
  'renderer-gone': 'Window process ended',
  'process-gone': 'Helper process ended'
}

/** The text of the issue. Everything in it is shown to you before anything is submitted. */
export function reportBody(info: ReportInfo): string {
  const lines = [
    '**What happened**',
    info.note?.trim() ? scrub(info.note.trim()) : '_(please describe what you were doing)_',
    '',
    '**App**',
    `- Version: ${info.version}`,
    `- Platform: ${info.platform}${info.electron ? `, Electron ${info.electron}` : ''}`
  ]
  if (info.crashes.length > 0) {
    lines.push('', '**Recent errors**')
    for (const c of info.crashes) {
      lines.push(`- ${new Date(c.at).toISOString()} ${KIND_LABEL[c.kind]}: ${scrub(c.message).slice(0, 300)}`)
      if (c.stack) lines.push('  ```', ...scrub(c.stack).split('\n').slice(0, 8).map((l) => '  ' + l.slice(0, 200)), '  ```')
    }
  }
  lines.push('', '_No mail, addresses or passwords are included. Email addresses and your user name were removed from the text above._')
  return lines.join('\n')
}

/** Browsers and GitHub cap the length of a link, so a long report is cut rather than refused. */
const MAX_URL = 7000

export function issueUrl(title: string, body: string, repo = ISSUES_REPO): string {
  const base = `https://github.com/${repo}/issues/new`
  const make = (b: string) => `${base}?title=${encodeURIComponent(title.slice(0, 120))}&labels=bug&body=${encodeURIComponent(b)}`
  let url = make(body)
  if (url.length <= MAX_URL) return url
  // Trim whole lines from the end of the body until it fits, and say it was cut.
  const lines = body.split('\n')
  while (lines.length > 4 && url.length > MAX_URL) {
    lines.pop()
    url = make(lines.join('\n') + '\n\n_(report shortened to fit a link)_')
  }
  return url.length <= MAX_URL ? url : make('_(report too long for a link)_')
}

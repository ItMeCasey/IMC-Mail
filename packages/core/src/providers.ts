import type { Provider, ServerConfig } from './schemas'

export interface ServerGuess {
  provider: Provider
  imap: ServerConfig
  smtp: ServerConfig
  /** Shown in the wizard when the provider needs something other than the account password. */
  note?: string
}

const known: Record<string, Omit<ServerGuess, 'provider'> & { provider?: Provider }> = {
  'gmail.com': {
    provider: 'gmail',
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    note: 'Gmail needs an app password (Google Account > Security > 2-Step Verification > App passwords).'
  },
  'outlook.com': {
    provider: 'microsoft',
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
    note: 'Microsoft has turned off password sign-in for many accounts. If this fails, OAuth sign-in is coming.'
  },
  'yahoo.com': {
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    note: 'Yahoo needs an app password.'
  },
  'icloud.com': {
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    note: 'iCloud needs an app-specific password.'
  },
  'fastmail.com': {
    imap: { host: 'imap.fastmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.fastmail.com', port: 465, security: 'tls' }
  }
}

const aliases: Record<string, string> = {
  'googlemail.com': 'gmail.com',
  'hotmail.com': 'outlook.com',
  'live.com': 'outlook.com',
  'msn.com': 'outlook.com',
  'office365.com': 'outlook.com',
  'ymail.com': 'yahoo.com',
  'me.com': 'icloud.com',
  'mac.com': 'icloud.com'
}

/** Best-effort server settings from an email address. Returns null if the address is malformed. */
export function guessServers(email: string): ServerGuess | null {
  const at = email.lastIndexOf('@')
  if (at < 1 || at === email.length - 1) return null
  const raw = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  const domain = aliases[raw] ?? raw
  const hit = known[domain]
  if (hit) return { provider: 'imap', ...hit }
  return {
    provider: 'imap',
    imap: { host: `imap.${raw}`, port: 993, security: 'tls' },
    smtp: { host: `smtp.${raw}`, port: 465, security: 'tls' }
  }
}

// Which company a message came from, for showing its logo: the sender's own domain, not a subdomain used for mailing
// ("email.spotify.com" is Spotify), and nothing for personal mailboxes, where a person's initials are the right mark.

const PERSONAL = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'mail.com'
])

/** Second-level names that sit under a country code ("co.uk", "com.au"), so the company name is one label further left. */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go'])

/** The domain whose logo to show for a sender address, or null when there is no company to show. */
export function logoDomain(address: string | null | undefined): string | null {
  const host = address?.split('@')[1]?.trim().toLowerCase().replace(/\.$/, '')
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null
  const labels = host.split('.').filter(Boolean)
  if (labels.length < 2) return null
  const last = labels[labels.length - 1]!
  const keep = last.length === 2 && labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2
  const domain = labels.slice(-keep).join('.')
  return PERSONAL.has(domain) ? null : domain
}

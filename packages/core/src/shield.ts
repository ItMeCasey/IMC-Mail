/**
 * Scam shield: spots the phishing and fake-sponsor tricks aimed at streamers and creators.
 * Pure and deterministic. Every verdict carries plain-language reasons the person can check.
 */

export type RiskLevel = 'none' | 'caution' | 'danger'

export interface RiskReason {
  code: string
  level: 'caution' | 'danger'
  /** One sentence a non-technical person can verify for themselves. */
  text: string
}

export interface Risk {
  level: RiskLevel
  reasons: RiskReason[]
}

export interface RiskInput {
  fromAddr: string
  fromName?: string
  subject: string
  replyTo?: string
  /** The raw Authentication-Results header, when present. */
  authResults?: string
  text?: string
  links?: { href: string; text: string }[]
  attachments?: { filename: string }[]
}

interface Brand {
  name: string
  /** Words that, in a display name or domain, claim to be this brand. */
  tokens: string[]
  /** The only domains that really belong to it. */
  domains: string[]
}

const BRANDS: Brand[] = [
  { name: 'Twitch', tokens: ['twitch'], domains: ['twitch.tv', 'twitch.com', 'twitchcon.com', 'twitchtv.com'] },
  { name: 'YouTube', tokens: ['youtube'], domains: ['youtube.com', 'google.com', 'youtu.be', 'withgoogle.com'] },
  { name: 'Google', tokens: ['google'], domains: ['google.com', 'googlemail.com', 'youtube.com'] },
  { name: 'Microsoft', tokens: ['microsoft', 'outlook', 'office365'], domains: ['microsoft.com', 'outlook.com', 'live.com', 'office.com', 'office365.com', 'microsoftonline.com', 'xbox.com'] },
  { name: 'Apple', tokens: ['apple', 'icloud'], domains: ['apple.com', 'icloud.com', 'me.com'] },
  { name: 'Amazon', tokens: ['amazon'], domains: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazonses.com', 'twitch.tv'] },
  { name: 'PayPal', tokens: ['paypal'], domains: ['paypal.com', 'paypal.me', 'paypal-communication.com'] },
  { name: 'Discord', tokens: ['discord'], domains: ['discord.com', 'discordapp.com', 'discord.gg'] },
  { name: 'Steam', tokens: ['steam'], domains: ['steampowered.com', 'valvesoftware.com', 'steamcommunity.com'] },
  { name: 'Patreon', tokens: ['patreon'], domains: ['patreon.com'] },
  { name: 'Stripe', tokens: ['stripe'], domains: ['stripe.com'] },
  { name: 'Meta', tokens: ['facebook', 'instagram', 'meta'], domains: ['facebook.com', 'facebookmail.com', 'instagram.com', 'meta.com', 'fb.com'] },
  { name: 'TikTok', tokens: ['tiktok'], domains: ['tiktok.com', 'tiktokmail.com', 'bytedance.com'] },
  { name: 'Kick', tokens: ['kick'], domains: ['kick.com'] },
  { name: 'Streamlabs', tokens: ['streamlabs'], domains: ['streamlabs.com'] },
  { name: 'StreamElements', tokens: ['streamelements'], domains: ['streamelements.com'] },
  { name: 'X', tokens: ['twitter'], domains: ['twitter.com', 'x.com'] },
  { name: 'DocuSign', tokens: ['docusign'], domains: ['docusign.com', 'docusign.net'] },
  { name: 'Dropbox', tokens: ['dropbox'], domains: ['dropbox.com', 'dropboxmail.com'] },
  { name: 'Zoom', tokens: ['zoom'], domains: ['zoom.us', 'zoom.com'] },
  { name: 'Spotify', tokens: ['spotify'], domains: ['spotify.com'] },
  { name: 'Epic Games', tokens: ['epicgames'], domains: ['epicgames.com'] }
]

const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com'])

/** Words that make a display name read like an official department rather than a person. */
const OFFICIAL_WORDS = new Set(['support', 'team', 'security', 'notice', 'notices', 'noreply', 'no-reply', 'copyright', 'partner', 'partners', 'payments', 'payment', 'billing', 'official', 'service', 'services', 'help', 'creators', 'creator', 'studio', 'alerts', 'alert', 'verification', 'verify', 'trust', 'safety', 'account', 'accounts', 'admin', 'the', 'and', 'of', 'inc', 'legal', 'dmca', 'monetization', 'program', 'center'])

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'rebrand.ly'])

const RISKY_EXT = ['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'jar', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'lnk', 'ps1', 'hta', 'dll', 'apk', 'iso', 'img', 'reg']
const MACRO_EXT = ['docm', 'xlsm', 'pptm', 'dotm', 'xlsb']
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz']
const DECOY_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'jpg', 'jpeg', 'png', 'txt', 'mp4', 'mov']

// ---- domains ----------------------------------------------------------------------

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'])

export function hostOf(urlOrAddr: string): string {
  const s = urlOrAddr.trim().toLowerCase()
  if (s.includes('@') && !s.includes('://')) return s.slice(s.lastIndexOf('@') + 1).replace(/[>\s].*$/, '')
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname.replace(/\.$/, '')
  } catch {
    return ''
  }
}

/** "mail.accounts.google.co.uk" -> "google.co.uk" (naive, good enough for brand checks). */
export function registrable(host: string): string {
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const last = labels[labels.length - 1]!
  const second = labels[labels.length - 2]!
  const take = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2
  return labels.slice(-take).join('.')
}

export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]!
}

const isLegit = (host: string, brand: Brand) => {
  const r = registrable(host)
  return brand.domains.some((d) => r === d || host === d || host.endsWith('.' + d))
}

/** A brand this host imitates: a near-miss spelling of its domain, or its name wrapped in extra words. */
function lookalikeOf(host: string): { brand: Brand; kind: 'typo' | 'wrapped' } | null {
  if (!host) return null
  const r = registrable(host)
  const label = r.split('.')[0] ?? ''
  for (const b of BRANDS) {
    if (isLegit(host, b)) continue
    // Brand name wrapped in extra words: twitch-support.com, youtube-copyright-team.net
    for (const t of b.tokens) {
      if (t.length >= 4 && label.includes(t) && label !== t) return { brand: b, kind: 'wrapped' }
    }
    // Near-miss of the real domain: twtich.tv, youtub3.com, paypa1.com
    for (const d of b.domains) {
      const dist = editDistance(r, d, 2)
      if (label.length >= 5 && dist > 0 && dist <= 2) return { brand: b, kind: 'typo' }
    }
  }
  return null
}

// ---- content patterns ---------------------------------------------------------------

const URGENT = /\b(within \d+ ?(hours?|hrs?|days?)|immediately|urgent(ly)?|final (notice|warning)|last chance|(will|is going to) be (suspended|terminated|deleted|disabled|banned|closed)|(account|channel|video) .{0,25}(suspended|terminated|deleted|disabled|banned)|act now|expires? (today|soon|in))\b/i
const CREDENTIALS = /\b(verify your (account|identity|email|channel)|confirm your (password|identity|account)|re-?enter your|update your (payment|billing|password)|login (here|to)|sign in (here|to)|security check|(your )?password)\b/i
const MONEY_TRICK = /\b(gift ?cards?|itunes card|google play card|steam card|bitcoin|btc\b|crypto(currency)?|usdt|ethereum|wallet address|western union|wire (the )?(money|funds)|cash ?app|zelle|overpay|refund the (difference|excess))\b/i
const OFF_PLATFORM = /\b(move|continue|talk|chat|message me) (this |the |our )?(conversation|chat|discussion)?\s*(to|on|via|over)\s+(telegram|whatsapp|signal|discord|wechat)\b|\b(add|dm|text) me on (telegram|whatsapp|signal|discord)\b/i
const DOWNLOAD_BAIT = /\b(download|install|run|open|play ?test|try)\b.{0,70}\b(our|the|this)\b.{0,30}\b(game|build|demo|app|software|tool|installer|plugin|overlay|extension|launcher|beta)\b/i
const FAKE_BADGE = /\b(verified badge|verification badge|get verified|blue check|monetization (restored|reinstated|enabled)|reinstate your (channel|account)|appeal (your|the) (strike|claim|ban)|channel (will|has) (be|been) (deleted|terminated))\b/i

const reason = (code: string, level: 'caution' | 'danger', text: string): RiskReason => ({ code, level, text })

function authReasons(auth: string, claimsBrand: boolean): RiskReason[] {
  const out: RiskReason[] = []
  const a = auth.toLowerCase()
  if (/dmarc=fail/.test(a)) {
    out.push(reason('dmarc-fail', claimsBrand ? 'danger' : 'caution', "The sender's domain failed its own email security check (DMARC), a common sign of a forged sender."))
  } else if (/spf=(fail|softfail)/.test(a) || /dkim=fail/.test(a)) {
    out.push(reason('auth-fail', 'caution', 'The email failed a sender-verification check (SPF or DKIM), so it may not really come from who it says.'))
  }
  return out
}

export function assess(m: RiskInput): Risk {
  const reasons: RiskReason[] = []
  const add = (r: RiskReason) => {
    if (!reasons.some((x) => x.code === r.code)) reasons.push(r)
  }

  const fromHost = hostOf(m.fromAddr)
  const fromReg = registrable(fromHost)
  const name = (m.fromName ?? '').toLowerCase()
  const nameTokens = name.split(/[^a-z0-9-]+/).filter(Boolean)
  let claimsBrand: Brand | null = null

  // 1. The display name claims to be a brand the sending domain does not belong to.
  for (const b of BRANDS) {
    if (!b.tokens.some((t) => nameTokens.includes(t))) continue
    if (isLegit(fromHost, b)) continue
    claimsBrand = b
    const onlyOfficial = nameTokens.every((w) => b.tokens.includes(w) || OFFICIAL_WORDS.has(w))
    add(
      reason(
        'name-spoof',
        onlyOfficial ? 'danger' : 'caution',
        `The sender calls itself "${m.fromName}" but the email comes from ${fromReg || m.fromAddr}, which is not ${b.name}'s domain.`
      )
    )
    break
  }

  // 2. The domain imitates a brand's.
  const look = lookalikeOf(fromHost)
  if (look) {
    const sure = look.kind === 'wrapped' || claimsBrand !== null
    claimsBrand ??= look.brand
    add(
      reason(
        'lookalike-domain',
        sure ? 'danger' : 'caution',
        `${fromReg} looks like ${look.brand.name}'s real domain. Scammers register names like this on purpose.`
      )
    )
  }
  if (fromHost.includes('xn--')) add(reason('punycode', 'caution', 'The sender domain uses look-alike characters that can pass for a familiar name.'))
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(fromHost)) add(reason('non-ascii-domain', 'danger', 'The sender domain contains look-alike letters from another alphabet.'))

  // 3. Sender verification and reply routing.
  if (m.authResults) for (const r of authReasons(m.authResults, claimsBrand !== null)) add(r)
  if (m.replyTo) {
    const replyHost = hostOf(m.replyTo)
    const replyReg = registrable(replyHost)
    if (replyReg && fromReg && replyReg !== fromReg) {
      const toFree = FREEMAIL.has(replyReg) && !FREEMAIL.has(fromReg)
      add(
        reason(
          'reply-to',
          toFree && claimsBrand ? 'danger' : 'caution',
          `Replies would go to ${replyReg}, not to ${fromReg} where the email claims to come from.`
        )
      )
    }
  }

  // 4. Links that lie about where they go.
  const brandOfLink = new Set<string>()
  for (const l of m.links ?? []) {
    const host = hostOf(l.href)
    if (!host) continue
    const shown = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/|$)/i.test(l.text.trim()) ? hostOf(l.text.trim()) : ''
    if (shown && registrable(shown) !== registrable(host)) {
      add(reason('link-mismatch', 'danger', `A link reads "${shown}" but actually goes to ${registrable(host)}.`))
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add(reason('ip-link', 'caution', 'A link goes to a bare number address instead of a website name.'))
    if (SHORTENERS.has(registrable(host))) add(reason('shortener', 'caution', 'A link is shortened, so you cannot see where it leads before clicking.'))
    const ll = lookalikeOf(host)
    if (ll) brandOfLink.add(ll.brand.name)
  }
  for (const name of brandOfLink) add(reason('link-lookalike', 'danger', `A link goes to a fake-looking ${name} address.`))

  // 5. What the message asks for.
  const body = `${m.subject}\n${(m.text ?? '').slice(0, 6000)}`
  const urgent = URGENT.test(body)
  const wantsLogin = CREDENTIALS.test(body)
  const hasLinks = (m.links ?? []).length > 0
  if (MONEY_TRICK.test(body)) add(reason('money-trick', 'danger', 'It talks about gift cards, crypto, or wiring money, which real sponsors and platforms never ask a creator to do.'))
  if (OFF_PLATFORM.test(body)) add(reason('off-platform', 'caution', 'It asks you to continue the conversation on Telegram, WhatsApp, Signal or Discord.'))
  if (FAKE_BADGE.test(body) && hasLinks) add(reason('fake-badge', claimsBrand ? 'danger' : 'caution', 'It offers a verified badge, an appeal, or a restored channel through a link. Platforms only show these inside your own account.'))
  if (urgent && (wantsLogin || hasLinks)) {
    add(reason('urgency', claimsBrand ? 'danger' : 'caution', 'It pressures you to act fast, and asks you to log in or click.'))
  } else if (wantsLogin && claimsBrand) {
    add(reason('credentials', 'danger', `It asks for your login while claiming to be ${claimsBrand.name}.`))
  }

  // 6. Attachments and "try our game" bait.
  const files = m.attachments ?? []
  for (const f of files) {
    const parts = f.filename.toLowerCase().split('.')
    const ext = parts.length > 1 ? parts[parts.length - 1]! : ''
    const prev = parts.length > 2 ? parts[parts.length - 2]! : ''
    if (RISKY_EXT.includes(ext)) {
      add(reason('risky-attachment', 'danger', `The attachment "${f.filename}" is a program file. Opening it could install malware.`))
    } else if (ext && DECOY_EXT.includes(prev) && (RISKY_EXT.includes(ext) || ARCHIVE_EXT.includes(ext))) {
      add(reason('double-extension', 'danger', `"${f.filename}" pretends to be a document but is really a ${ext} file.`))
    } else if (MACRO_EXT.includes(ext)) {
      add(reason('macro-attachment', 'caution', `"${f.filename}" can run hidden code when opened in Office.`))
    } else if (ARCHIVE_EXT.includes(ext) && DOWNLOAD_BAIT.test(body)) {
      add(reason('archive-bait', 'caution', 'It sends a compressed file and asks you to run what is inside, a common way to spread malware to streamers.'))
    }
  }
  if (DOWNLOAD_BAIT.test(body) && hasLinks && !reasons.some((r) => r.code === 'archive-bait')) {
    add(reason('download-bait', 'caution', 'It asks you to download and run their game, app, or tool. "Review builds" are a common way to infect streamers.'))
  }

  const level: RiskLevel = reasons.some((r) => r.level === 'danger') ? 'danger' : reasons.length ? 'caution' : 'none'
  // Most serious first, and never an overwhelming wall of text.
  reasons.sort((a, b) => Number(b.level === 'danger') - Number(a.level === 'danger'))
  return { level, reasons: reasons.slice(0, 5) }
}

/** Anchors in an HTML body, for the link checks. Works on raw or sanitized markup. */
export function extractLinks(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = []
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
  for (let m = re.exec(html); m && out.length < 200; m = re.exec(html)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim()
    const text = (m[4] ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    if (/^https?:\/\//i.test(href)) out.push({ href, text })
  }
  return out
}

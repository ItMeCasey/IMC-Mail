import type { Category } from './schemas'

/**
 * Rule-based sorting of mail into the kinds a creator gets. Pure and deterministic so it can run
 * on every message as it arrives, on any device, with no network. Every verdict names its reasons.
 */

export interface Classifiable {
  fromAddr: string
  fromName?: string
  subject: string
  /** Body text when it has been downloaded; headers alone still classify. */
  text?: string
}

export interface Verdict {
  category: Category
  /** What triggered it, for "why is this here?" and for tests. */
  reasons: string[]
}

const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'zoho.com'
])

/** Streaming and creator platforms whose own mail is a notice, not a conversation. */
export const PLATFORM_DOMAINS = [
  'twitch.tv', 'twitch.com', 'youtube.com', 'kick.com', 'tiktok.com', 'instagram.com',
  'facebookmail.com', 'meta.com', 'discord.com', 'steampowered.com', 'valvesoftware.com',
  'epicgames.com', 'patreon.com', 'ko-fi.com', 'streamlabs.com', 'streamelements.com',
  'nightbot.tv', 'obsproject.com', 'elgato.com', 'restream.io', 'x.com', 'twitter.com',
  'spotify.com', 'bandcamp.com', 'itch.io', 'gumroad.com', 'teespring.com', 'spring.com'
]

const PAYMENT_DOMAINS = ['paypal.com', 'stripe.com', 'wise.com', 'quickbooks.com', 'intuit.com', 'freshbooks.com', 'square.com', 'squareup.com', 'gusto.com', 'payoneer.com']

const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase()

const matchesDomain = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith('.' + d))

interface Rule {
  category: Category
  /** Whole-word-ish phrases; matched case-insensitively. */
  terms: string[]
  weight: number
}

const SUBJECT_RULES: Rule[] = [
  {
    category: 'platform',
    weight: 4,
    terms: ['copyright claim', 'copyright strike', 'community guidelines', 'terms of service', 'partner program', 'affiliate program', 'monetization', 'verification', 'your channel', 'your payout', 'payout', 'dmca', 'content id', 'policy update', 'account security', 'two-factor', 'login attempt']
  },
  {
    category: 'invoice',
    weight: 4,
    terms: ['invoice', 'receipt', 'payment received', 'payment due', 'past due', 'overdue', 'remittance', 'purchase order', 'statement', 'net 30', 'net 15', 'wire transfer', 'billing', 'your order']
  },
  {
    category: 'sponsorship',
    weight: 4,
    terms: ['sponsor', 'sponsorship', 'sponsored', 'brand deal', 'brand partnership', 'paid partnership', 'paid promotion', 'campaign brief', 'campaign', 'integration', 'rate card', 'media kit', 'ambassador', 'deliverables', 'usage rights', 'partnership opportunity', 'partnership', 'creator program', 'product seeding', 'gifting', 'affiliate offer', 'influencer']
  },
  {
    category: 'collab',
    weight: 4,
    terms: ['collab', 'collaboration', 'collaborate', 'guest on', 'guest spot', 'be a guest', 'podcast', 'interview', 'co-stream', 'costream', 'duo stream', 'raid', 'feature you', 'feature your', 'appearance', 'panel', 'speaking']
  },
  {
    category: 'cold',
    weight: 4,
    terms: ['limited time', '% off', 'discount', 'exclusive offer', 'special offer', 'webinar', 'newsletter', 'unsubscribe', 'boost your', 'grow your channel', 'grow your audience', 'increase your views', 'buy followers', 'seo', 'free trial', 'act now', 'last chance', 'black friday', 'we noticed your', 'quick question', 'quick call']
  },
  {
    category: 'fan',
    weight: 3,
    terms: ['love your', 'big fan', 'your stream', 'your videos', 'your content', 'fan art', 'fanart', 'thank you for', 'thanks for the', 'emote', 'subscribed', 'you inspired', 'keep it up', 'huge fan']
  }
]

const BODY_WEIGHT = 1

function hits(haystack: string, terms: string[]): string[] {
  const h = haystack.toLowerCase()
  return terms.filter((t) => {
    const i = h.indexOf(t)
    if (i < 0) return false
    // Short words must stand alone ("seo" in "diseño" does not count).
    if (t.length <= 4) {
      const before = h[i - 1]
      const after = h[i + t.length]
      return !(before && /\p{L}/u.test(before)) && !(after && /\p{L}/u.test(after))
    }
    return true
  })
}

const TIE_ORDER: Category[] = ['platform', 'invoice', 'sponsorship', 'collab', 'cold', 'fan']

export function classify(m: Classifiable): Verdict {
  const domain = domainOf(m.fromAddr)
  const local = m.fromAddr.slice(0, m.fromAddr.lastIndexOf('@')).toLowerCase()
  const score = new Map<Category, number>()
  const why = new Map<Category, string[]>()
  const add = (c: Category, n: number, reason: string) => {
    score.set(c, (score.get(c) ?? 0) + n)
    why.set(c, [...(why.get(c) ?? []), reason])
  }

  // Who it is from is the strongest signal.
  if (matchesDomain(domain, PLATFORM_DOMAINS)) add('platform', 10, `from ${domain}`)
  if (matchesDomain(domain, PAYMENT_DOMAINS)) add('invoice', 6, `from ${domain}`)
  if (/^(billing|invoices?|accounts?|accounting|payments?|ar|ap)$/.test(local)) add('invoice', 4, `sent from ${local}@`)
  if (/^(partnerships?|sponsor(s|ships?)?|brand|influencer|creators?|collabs?)$/.test(local)) add('sponsorship', 4, `sent from ${local}@`)
  if (/^(newsletter|news|marketing|promo|offers|deals|hello|info)$/.test(local) && !FREEMAIL.has(domain)) add('cold', 2, `sent from ${local}@`)

  for (const rule of SUBJECT_RULES) {
    for (const t of hits(m.subject, rule.terms)) add(rule.category, rule.weight, `subject: ${t}`)
    if (m.text) {
      const found = hits(m.text.slice(0, 4000), rule.terms)
      for (const t of found.slice(0, 3)) add(rule.category, BODY_WEIGHT, `body: ${t}`)
    }
  }

  // A real person on a free mailbox writing warmly is fan mail; a company domain writing about
  // work is more likely business.
  const personal = FREEMAIL.has(domain)
  if (personal && score.get('sponsorship')) add('sponsorship', -2, 'free mailbox')
  if (!personal && score.get('sponsorship')) add('sponsorship', 1, 'company domain')
  if (personal && (score.get('fan') ?? 0) > 0) add('fan', 2, 'personal address')
  if (personal && !score.size && m.text && m.text.length < 1500) add('fan', 1, 'short note from a personal address')

  let best: Category = 'other'
  let top = 0
  for (const c of TIE_ORDER) {
    const s = score.get(c) ?? 0
    if (s > top) {
      top = s
      best = c
    }
  }
  // One weak body mention is not enough to file a message away.
  if (top < 3 && best !== 'platform') return { category: 'other', reasons: [] }
  return { category: best, reasons: why.get(best) ?? [] }
}

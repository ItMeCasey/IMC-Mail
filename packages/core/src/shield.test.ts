import { describe, expect, it } from 'vitest'
import { assess, editDistance, extractLinks, hostOf, registrable, type RiskInput } from './shield'

const r = (over: Partial<RiskInput>) =>
  assess({ fromAddr: 'someone@example.org', subject: 'Hello', ...over })
const codes = (over: Partial<RiskInput>) => r(over).reasons.map((x) => x.code)

describe('domain helpers', () => {
  it('finds the registrable domain', () => {
    expect(registrable('mail.accounts.google.com')).toBe('google.com')
    expect(registrable('news.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrable('twitch.tv')).toBe('twitch.tv')
    expect(hostOf('Pat <pat@Mail.Brand.Example>')).toBe('mail.brand.example')
    expect(hostOf('https://Evil.Example/path?x=1')).toBe('evil.example')
  })
  it('measures edit distance with an early exit', () => {
    expect(editDistance('twitch.tv', 'twtich.tv')).toBe(2)
    expect(editDistance('paypal.com', 'paypa1.com')).toBe(1)
    expect(editDistance('abc', 'abcdefgh', 2)).toBeGreaterThan(2)
  })
})

describe('real mail stays quiet', () => {
  it('does not flag genuine platform mail', () => {
    expect(r({ fromAddr: 'no-reply@twitch.tv', fromName: 'Twitch', subject: 'Your payout has been issued' }).level).toBe('none')
    expect(r({ fromAddr: 'noreply@accounts.google.com', fromName: 'YouTube', subject: 'Security alert', authResults: 'dmarc=pass spf=pass dkim=pass' }).level).toBe('none')
    expect(r({ fromAddr: 'pat@gmail.com', fromName: 'Pat', subject: 'Dinner?' }).level).toBe('none')
    expect(r({ fromAddr: 'partnerships@nova.example', fromName: 'Nova Energy', subject: 'Sponsorship brief', links: [{ href: 'https://nova.example/brief', text: 'the brief' }] }).level).toBe('none')
  })
})

describe('impersonation', () => {
  it('flags an official-sounding name on the wrong domain', () => {
    const risk = r({ fromAddr: 'support@mail-secure.example', fromName: 'Twitch Support Team' })
    expect(risk.level).toBe('danger')
    expect(risk.reasons[0]?.code).toBe('name-spoof')
    expect(risk.reasons[0]?.text).toContain('mail-secure.example')
  })

  it('is gentler when a person merely mentions a brand in their name', () => {
    const risk = r({ fromAddr: 'jess@agency.example', fromName: 'Jess from Twitch Partners Inc' })
    expect(risk.level).toBe('caution')
  })

  it('flags typosquatted and wrapped domains', () => {
    expect(codes({ fromAddr: 'help@twtich.tv', fromName: 'Twitch' })).toContain('lookalike-domain')
    expect(r({ fromAddr: 'copyright@youtube-copyright-team.net', subject: 'Notice' }).level).toBe('danger')
    expect(r({ fromAddr: 'service@paypa1.com', fromName: 'PayPal' }).level).toBe('danger')
    // A near-miss on its own, with no brand claim, is only a caution.
    expect(r({ fromAddr: 'a@patron.com', subject: 'Hi' }).level).toBe('caution')
  })

  it('flags look-alike alphabets and punycode', () => {
    expect(codes({ fromAddr: 'a@xn--twtch-9ra.tv' })).toContain('punycode')
    expect(codes({ fromAddr: 'a@twіtch.tv' })).toContain('non-ascii-domain') // Cyrillic і
  })
})

describe('sender verification and reply routing', () => {
  it('treats a failed DMARC as worse when a brand is claimed', () => {
    expect(r({ fromAddr: 'a@b.example', authResults: 'mx.x; dmarc=fail (p=reject) spf=pass' }).level).toBe('caution')
    expect(r({ fromAddr: 'a@mailer.example', fromName: 'YouTube Team', authResults: 'dmarc=fail' }).level).toBe('danger')
    expect(codes({ fromAddr: 'a@b.example', authResults: 'spf=softfail' })).toContain('auth-fail')
    expect(r({ fromAddr: 'a@b.example', authResults: 'spf=pass dkim=pass dmarc=pass' }).level).toBe('none')
  })

  it('flags replies that go somewhere else', () => {
    expect(codes({ fromAddr: 'deals@brand.example', replyTo: 'deals@other-domain.example' })).toContain('reply-to')
    expect(r({ fromAddr: 'support@twitch-help.example', fromName: 'Twitch Support', replyTo: 'x@gmail.com' }).level).toBe('danger')
    expect(r({ fromAddr: 'a@brand.example', replyTo: 'b@mail.brand.example' }).level).toBe('none')
  })
})

describe('links', () => {
  it('flags a link whose text lies about its destination', () => {
    const risk = r({ links: [{ href: 'https://evil.example/login', text: 'https://www.paypal.com/security' }] })
    expect(risk.level).toBe('danger')
    expect(risk.reasons[0]?.text).toContain('evil.example')
  })
  it('flags bare IPs, shorteners and brand look-alikes', () => {
    expect(codes({ links: [{ href: 'http://192.168.4.5/x', text: 'click' }] })).toContain('ip-link')
    expect(codes({ links: [{ href: 'https://bit.ly/3xYz', text: 'appeal here' }] })).toContain('shortener')
    expect(codes({ links: [{ href: 'https://twitch-support-login.example/', text: 'Log in' }] })).toContain('link-lookalike')
  })
  it('accepts links that match their text', () => {
    expect(r({ links: [{ href: 'https://www.twitch.tv/settings', text: 'twitch.tv/settings' }] }).level).toBe('none')
  })
})

describe('what the message asks for', () => {
  it('flags money tricks', () => {
    expect(r({ subject: 'Sponsorship', text: 'We will pay you, please buy gift cards for the shipping fee.' }).level).toBe('danger')
    expect(codes({ text: 'Send the refund of the excess by Zelle' })).toContain('money-trick')
  })
  it('flags urgency plus a login or a link, harder when a brand is claimed', () => {
    const generic = r({ subject: 'Action needed', text: 'Your account will be suspended within 24 hours. Verify your account.', links: [{ href: 'https://x.example', text: 'here' }] })
    expect(generic.level).toBe('caution')
    const branded = r({ fromAddr: 'a@z.example', fromName: 'YouTube Team', text: 'Your channel will be deleted within 24 hours. Sign in here.', links: [{ href: 'https://z.example', text: 'appeal' }] })
    expect(branded.level).toBe('danger')
  })
  it('flags moving to a chat app, fake badges, and run-our-game bait', () => {
    expect(codes({ text: 'Great! Let us move this conversation to Telegram, add me on telegram.' })).toContain('off-platform')
    expect(codes({ text: 'Get verified: your monetization restored, appeal here', links: [{ href: 'https://a.example', text: 'appeal' }] })).toContain('fake-badge')
    expect(codes({ text: 'Please download our game build and play test it before the stream.', links: [{ href: 'https://files.example/build', text: 'download' }] })).toContain('download-bait')
  })
  it('does not fire on ordinary urgency without a call to act', () => {
    expect(r({ text: 'Please reply immediately when you can, no rush really.' }).level).toBe('none')
  })
})

describe('attachments', () => {
  it('flags program files and disguised ones', () => {
    expect(codes({ attachments: [{ filename: 'Brief.exe' }] })).toContain('risky-attachment')
    expect(codes({ attachments: [{ filename: 'invoice.pdf.exe' }] })).toContain('risky-attachment')
    expect(codes({ attachments: [{ filename: 'contract.pdf.zip' }] })).toContain('double-extension')
  })
  it('flags macro documents and run-this archives, but not plain documents', () => {
    expect(r({ attachments: [{ filename: 'rates.xlsm' }] }).level).toBe('caution')
    expect(codes({ text: 'Please download and run the game demo inside', attachments: [{ filename: 'demo.zip' }] })).toContain('archive-bait')
    expect(r({ attachments: [{ filename: 'brief.pdf' }, { filename: 'logo.png' }] }).level).toBe('none')
  })
})

describe('result shape', () => {
  it('lists the most serious reasons first and caps them', () => {
    const risk = r({
      fromAddr: 'a@twitch-support.example',
      fromName: 'Twitch Support',
      replyTo: 'x@gmail.com',
      authResults: 'dmarc=fail',
      subject: 'Final notice: account will be suspended within 24 hours',
      text: 'Verify your account. Pay with gift cards. Move to telegram.',
      links: [{ href: 'https://bit.ly/z', text: 'https://twitch.tv/login' }],
      attachments: [{ filename: 'a.exe' }]
    })
    expect(risk.level).toBe('danger')
    expect(risk.reasons.length).toBeLessThanOrEqual(5)
    expect(risk.reasons[0]?.level).toBe('danger')
  })
})

describe('extractLinks', () => {
  it('reads anchors, decodes entities, keeps only http(s)', () => {
    const html = `<p><a href="https://a.example/x?y=1&amp;z=2"><b>Open</b> it</a> <a href='mailto:a@b.co'>mail</a>
      <a class="x" href=https://c.example>c</a></p>`
    expect(extractLinks(html)).toEqual([
      { href: 'https://a.example/x?y=1&z=2', text: 'Open it' },
      { href: 'https://c.example', text: 'c' }
    ])
  })
})

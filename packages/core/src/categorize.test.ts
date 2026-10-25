import { describe, expect, it } from 'vitest'
import { classify, type Classifiable } from './categorize'

const c = (over: Partial<Classifiable>) =>
  classify({ fromAddr: 'someone@example.org', subject: '', ...over }).category

describe('classify', () => {
  it('treats mail from creator platforms as platform notices', () => {
    expect(c({ fromAddr: 'no-reply@twitch.tv', subject: 'Your payout has been issued' })).toBe('platform')
    expect(c({ fromAddr: 'noreply@youtube.com', subject: 'Copyright claim on your video' })).toBe('platform')
    expect(c({ fromAddr: 'x@mail.discord.com', subject: 'hi' })).toBe('platform') // subdomain
    expect(c({ fromAddr: 'copyright@gmail.com', subject: 'Copyright strike on your channel' })).toBe('platform')
  })

  it('recognizes invoices and payment mail', () => {
    expect(c({ fromAddr: 'accounts@pixelforge.example', subject: 'Invoice #2291 overdue' })).toBe('invoice')
    expect(c({ fromAddr: 'service@paypal.com', subject: 'You received a payment' })).toBe('invoice')
    expect(c({ fromAddr: 'billing@studio.example', subject: 'Statement for October' })).toBe('invoice')
  })

  it('recognizes sponsorship offers, favoring company senders', () => {
    const v = classify({ fromAddr: 'partnerships@novaenergy.example', subject: 'Paid partnership: Q4 campaign brief' })
    expect(v.category).toBe('sponsorship')
    expect(v.reasons.length).toBeGreaterThan(0)
    expect(c({ fromAddr: 'jo@brand.example', subject: 'Sponsorship opportunity for your channel' })).toBe('sponsorship')
    expect(c({ fromAddr: 'jo@brand.example', subject: 'Hi', text: 'We would love to discuss a brand deal and our rate card, with deliverables and usage rights.' })).toBe('sponsorship')
  })

  it('recognizes collab requests', () => {
    expect(c({ fromAddr: 'pat@y.example', subject: 'Collab idea for December?' })).toBe('collab')
    expect(c({ subject: 'Be a guest on our podcast' })).toBe('collab')
  })

  it('recognizes fan mail from personal addresses', () => {
    expect(c({ fromAddr: 'viewer44@gmail.com', subject: 'Love your stream!!' })).toBe('fan')
    expect(c({ fromAddr: 'sam@gmail.com', subject: 'hey', text: 'Just wanted to say thank you for the stream last night.' })).toBe('fan')
  })

  it('recognizes cold outreach', () => {
    expect(c({ fromAddr: 'sales@growthco.example', subject: 'Grow your channel: 50% off this week only' })).toBe('cold')
    expect(c({ fromAddr: 'newsletter@shop.example', subject: 'Black Friday: limited time offer' })).toBe('cold')
  })

  it('leaves ordinary mail alone', () => {
    expect(c({ fromAddr: 'mum@gmail.com', subject: 'Dinner on Sunday?' })).toBe('other')
    expect(c({ subject: '' })).toBe('other')
  })

  it('does not match short words inside other words', () => {
    expect(c({ fromAddr: 'a@b.example', subject: 'Diseño de interiores' })).toBe('other') // "seo"
    expect(c({ fromAddr: 'a@b.example', subject: 'Seo agency pitch' })).toBe('cold')
  })

  it('a single stray body mention is not enough', () => {
    expect(c({ fromAddr: 'a@b.example', subject: 'Hello', text: 'Unsubscribe at any time.' })).toBe('other')
  })

  it('lets the sender outweigh the subject, and the subject outweigh the body', () => {
    expect(c({ fromAddr: 'no-reply@twitch.tv', subject: 'Brand partnership invoice' })).toBe('platform')
    expect(c({ fromAddr: 'a@b.example', subject: 'Invoice 12', text: 'a paid partnership collab' })).toBe('invoice')
  })
})

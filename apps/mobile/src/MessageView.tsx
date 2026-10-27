import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { assess } from '@imc/core'
import type { Address, Summary } from '@imc/mail'
import { buildPhoneDocument, sanitizeEmailHtml, textToHtml } from '@imc/mail/render'
import type { PhoneAccount } from './auth'
import { readMessage, type OpenedMessage } from './inbox'
import MessageHtml from './MessageHtml'
import { tell } from './report'

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const who = (a: Address): string => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)
const size = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)

/**
 * One message. HTML mail is shown in a locked-down web view (sanitized, no scripts, web images off until you allow
 * them); plain text is shown the same way. A message that looks like a scam gets a warning and its links turned off.
 */
export default function MessageView({ account, summary, onBack }: { account: PhoneAccount; summary: Summary; onBack: () => void }) {
  const [opened, setOpened] = useState<OpenedMessage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [allowImages, setAllowImages] = useState(false)

  useEffect(() => {
    let live = true
    readMessage(account, summary.uid)
      .then((m) => {
        void tell({ opened: account.provider, fromCache: m.fromCache, rawBytes: m.rawBytes, textLength: m.message.text.length, htmlLength: m.message.html?.length ?? 0, attachments: m.message.attachments.length })
        if (live) setOpened(m)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        void tell({ openFailed: account.provider, message })
        if (live) setError(summary.uid && message ? `${message}` : 'This message could not be opened')
      })
    return () => {
      live = false
    }
  }, [account, summary.uid])

  const m = opened?.message
  const risk = useMemo(() => (m ? assess({ fromAddr: summary.from?.address ?? '', fromName: summary.from?.name ?? '', subject: summary.subject, text: m.text }) : null), [m, summary])
  const defang = risk?.level === 'danger'

  const page = useMemo(() => {
    if (!m) return null
    if (m.html) {
      const r = sanitizeEmailHtml(m.html, { allowImages, defangLinks: defang })
      return { doc: buildPhoneDocument(r.html, { allowImages, isText: false }), blocked: r.blockedImages }
    }
    return { doc: buildPhoneDocument(textToHtml(m.text || '(this message has no text)', { defangLinks: defang }), { allowImages, isText: true }), blocked: 0 }
  }, [m, allowImages, defang])

  const attachments = m?.attachments.filter((a) => !a.inline) ?? []
  const from = summary.from

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Pressable accessibilityRole="button" onPress={onBack}>
          <Text style={s.link}>Back</Text>
        </Pressable>
        <Text style={s.subject}>{summary.subject || '(no subject)'}</Text>
        <Text style={s.metaText}>From {from ? who(from) : '(unknown sender)'}</Text>
        {summary.to.length > 0 && <Text style={s.metaText}>To {summary.to.map(who).join(', ')}</Text>}
        {summary.cc.length > 0 && <Text style={s.metaText}>Cc {summary.cc.map(who).join(', ')}</Text>}
        {summary.date !== null && <Text style={s.metaText}>{full.format(summary.date)}</Text>}
        {risk && risk.level !== 'none' && (
          <View style={[s.warning, risk.level === 'danger' && s.danger]}>
            <Text style={s.warningTitle}>{risk.level === 'danger' ? 'This message looks like a scam. Its links are turned off.' : 'Be careful with this message.'}</Text>
            {risk.reasons.slice(0, 3).map((r) => (
              <Text key={r.code} style={s.warningText}>
                {r.text}
              </Text>
            ))}
          </View>
        )}
        {page !== null && page.blocked > 0 && !allowImages && (
          <Pressable accessibilityRole="button" onPress={() => setAllowImages(true)}>
            <Text style={s.link}>Show {page.blocked} blocked image{page.blocked === 1 ? '' : 's'} (the sender can tell you opened it)</Text>
          </Pressable>
        )}
        {attachments.length > 0 && (
          <Text style={s.metaText}>
            Attachments: {attachments.map((a) => `${a.filename} (${size(a.size)})`).join(', ')}
          </Text>
        )}
        {opened?.truncated && <Text style={s.note}>This message is long, so only the first part was downloaded.</Text>}
      </View>
      {opened === null && error === null && <ActivityIndicator color="#9aa4b2" style={s.spinner} />}
      {error !== null && <Text style={s.error}>{error}</Text>}
      {page !== null && <MessageHtml doc={page.doc} />}
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101418' },
  head: { padding: 16, paddingTop: 48, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3340' },
  link: { color: '#8ab4f8', paddingVertical: 6 },
  subject: { color: '#f2f4f7', fontSize: 19, fontWeight: '600' },
  metaText: { color: '#9aa4b2', fontSize: 13 },
  note: { color: '#9aa4b2', fontStyle: 'italic', fontSize: 13 },
  error: { color: '#f2a3a3', padding: 16 },
  spinner: { marginTop: 24 },
  warning: { backgroundColor: '#3a3320', borderRadius: 8, padding: 10, marginTop: 6, gap: 2 },
  danger: { backgroundColor: '#3d2222' },
  warningTitle: { color: '#f2f4f7', fontWeight: '600' },
  warningText: { color: '#e4cfa0', fontSize: 13 }
})

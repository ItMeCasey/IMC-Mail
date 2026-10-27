import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { Address, Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { readMessage, type OpenedMessage } from './inbox'
import { tell } from './report'

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const who = (a: Address): string => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)
const size = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)

/** One message, as plain text. The sender's HTML is never shown here, so nothing in a message can run. */
export default function MessageView({ account, summary, onBack }: { account: PhoneAccount; summary: Summary; onBack: () => void }) {
  const [opened, setOpened] = useState<OpenedMessage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    readMessage(account, summary.uid)
      .then((m) => {
        void tell({ opened: account.provider, rawBytes: m.rawBytes, textLength: m.message.text.length, htmlLength: m.message.html?.length ?? 0, attachments: m.message.attachments.length })
        if (live) setOpened(m)
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e)
        void tell({ openFailed: account.provider, message })
        if (live) setError(message)
      })
    return () => {
      live = false
    }
  }, [account, summary.uid])

  const m = opened?.message
  return (
    <ScrollView contentContainerStyle={s.body}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={s.link}>Back</Text>
      </Pressable>
      <Text style={s.subject}>{(m?.subject ?? summary.subject) || '(no subject)'}</Text>
      <View style={s.meta}>
        <Text style={s.metaText}>From {(m?.from ?? summary.from) ? who((m?.from ?? summary.from)!) : '(unknown sender)'}</Text>
        {(m?.to ?? summary.to).length > 0 && <Text style={s.metaText}>To {(m?.to ?? summary.to).map(who).join(', ')}</Text>}
        {(m?.cc ?? summary.cc).length > 0 && <Text style={s.metaText}>Cc {(m?.cc ?? summary.cc).map(who).join(', ')}</Text>}
        {(m?.date ?? summary.date) !== null && <Text style={s.metaText}>{full.format((m?.date ?? summary.date)!)}</Text>}
      </View>
      {opened === null && error === null && <ActivityIndicator color="#9aa4b2" />}
      {error !== null && <Text style={s.error}>{error}</Text>}
      {m && (
        <>
          <Text selectable style={s.text}>
            {m.text || '(this message has no text)'}
          </Text>
          {opened.truncated && <Text style={s.note}>This message is long, so only the first part was downloaded.</Text>}
          {m.attachments.filter((a) => !a.inline).length > 0 && (
            <View style={s.attachments}>
              <Text style={s.metaText}>Attachments</Text>
              {m.attachments
                .filter((a) => !a.inline)
                .map((a, i) => (
                  <Text key={`${a.filename}${i}`} style={s.attachment}>
                    {a.filename} ({size(a.size)})
                  </Text>
                ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  body: { padding: 20, paddingTop: 56, gap: 12 },
  link: { color: '#8ab4f8', paddingVertical: 6 },
  subject: { color: '#f2f4f7', fontSize: 20, fontWeight: '600' },
  meta: { gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3340', paddingBottom: 10 },
  metaText: { color: '#9aa4b2', fontSize: 13 },
  text: { color: '#e4e8ee', fontSize: 15, lineHeight: 22 },
  note: { color: '#9aa4b2', fontStyle: 'italic' },
  error: { color: '#f2a3a3' },
  attachments: { gap: 4, paddingTop: 8 },
  attachment: { color: '#c7d0dc', fontSize: 14 }
})

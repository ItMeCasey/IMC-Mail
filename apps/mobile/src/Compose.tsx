import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { fillTemplate, parseRecipient } from '@imc/core'
import type { Address, OutgoingAttachment } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { items } from './db'
import { sendMail } from './mail'
import { describeError, type ComposeStart } from './screens'
import { Body, Button, colors, ErrorText, Link, Note, Screen } from './ui'

const parseList = (text: string): Address[] =>
  text
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const r = parseRecipient(x)
      return { name: r.name, address: r.address }
    })

const validAddress = (a: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)

/** HTML from a synced template, as the plain text this composer sends. */
const htmlToText = (html: string): string =>
  html
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export default function Compose({ account, start, onDone }: { account: PhoneAccount; start?: ComposeStart; onDone: () => void }) {
  const [to, setTo] = useState(start?.to ?? '')
  const [cc, setCc] = useState(start?.cc ?? '')
  const [subject, setSubject] = useState(start?.subject ?? '')
  const [text, setText] = useState(start?.text ?? '')
  const [files, setFiles] = useState<OutgoingAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [templates, setTemplates] = useState(false)

  const templateList = items.list<{ name: string; subject: string; html: string }>('template')

  const pick = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      if (r.canceled) return
      const added: OutgoingAttachment[] = []
      for (const a of r.assets) added.push({ filename: a.name, mimeType: a.mimeType ?? 'application/octet-stream', content: await new File(a.uri).bytes() })
      setFiles((f) => [...f, ...added])
    } catch (e) {
      setError(describeError(e))
    }
  }

  const useTemplate = (t: { subject: string; html: string }) => {
    const first = to.split(',')[0]?.trim()
    const vars = { ...(first ? { recipient: first } : {}), myName: account.name, myEmail: account.email, subject }
    const body = fillTemplate(htmlToText(t.html), vars)
    setText((cur) => (cur.trim() ? `${body.text}\n\n${cur}` : body.text))
    if (!subject && t.subject) setSubject(fillTemplate(t.subject, vars).text)
    setTemplates(false)
  }

  const send = async () => {
    setError(null)
    const toList = parseList(to)
    const ccList = parseList(cc)
    if (toList.length === 0) return setError('Add someone to send this to.')
    const bad = [...toList, ...ccList].find((a) => !validAddress(a.address))
    if (bad) return setError(`"${bad.address}" is not an email address.`)
    setBusy(true)
    try {
      const r = await sendMail(account, { to: toList, cc: ccList, subject, text, attachments: files, inReplyTo: start?.inReplyTo ?? null, references: start?.references ?? [] })
      if (r === 'queued') setNote('No connection. The message is in the outbox and will go when the phone is online.')
      onDone()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <View style={st.bar}>
      <Link onPress={onDone}>Discard</Link>
      <Button onPress={() => void send()} disabled={busy}>
        {busy ? 'Sending…' : 'Send'}
      </Button>
    </View>
  )

  return (
    <Screen footer={footer}>
      <Body>
        <Note>From {account.email}</Note>
        <Field label="To" value={to} onChange={setTo} keyboard="email-address" />
        <Field label="Cc" value={cc} onChange={setCc} keyboard="email-address" />
        <Field label="Subject" value={subject} onChange={setSubject} />
        <TextInput value={text} onChangeText={setText} multiline placeholder="Write your message" placeholderTextColor={colors.faint} style={[st.input, st.body]} textAlignVertical="top" />
        {files.map((f, i) => (
          <Link key={i} onPress={() => setFiles((all) => all.filter((_, j) => j !== i))}>{`📎 ${f.filename} — remove`}</Link>
        ))}
        <View style={st.row}>
          <Link onPress={() => void pick()}>Attach a file</Link>
          {templateList.length > 0 && <Link onPress={() => setTemplates(!templates)}>Templates</Link>}
        </View>
        {templates && templateList.map((t) => <Link key={t.id} onPress={() => useTemplate(t.data)}>{t.data.name || '(untitled)'}</Link>)}
        {error !== null && <ErrorText>{error}</ErrorText>}
        {note !== null && <Note>{note}</Note>}
      </Body>
    </Screen>
  )
}

function Field({ label, value, onChange, keyboard }: { label: string; value: string; onChange: (v: string) => void; keyboard?: 'email-address' }) {
  return (
    <View style={st.field}>
      <Text style={st.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={keyboard} autoCapitalize={keyboard ? 'none' : 'sentences'} autoCorrect={!keyboard} style={[st.input, { flex: 1 }]} placeholderTextColor={colors.faint} />
    </View>
  )
}

const st = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.muted, width: 56 },
  input: { color: colors.text, backgroundColor: colors.raised, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
  body: { minHeight: 220 },
  row: { flexDirection: 'row', gap: 20 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }
})

import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { fillTemplate, parseRecipient } from '@imc/core'
import type { Address, OutgoingAttachment } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { AppBar, CloseIcon, IconButton, MenuItem, MenuLabel, Sheet } from './chrome'
import { items } from './db'
import { sendMail } from './mail'
import { describeError, type ComposeStart } from './screens'
import { colors, ErrorText, Note, radius, Screen } from './ui'

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

/** Writing a message: a bar with Send, the addressing rows, and a roomy body. */
export default function Compose({ account, start, onDone }: { account: PhoneAccount; start?: ComposeStart; onDone: () => void }) {
  const [to, setTo] = useState(start?.to ?? '')
  const [cc, setCc] = useState(start?.cc ?? '')
  const [showCc, setShowCc] = useState(!!start?.cc)
  const [subject, setSubject] = useState(start?.subject ?? '')
  const [text, setText] = useState(start?.text ?? '')
  const [files, setFiles] = useState<OutgoingAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      await sendMail(account, { to: toList, cc: ccList, subject, text, attachments: files, inReplyTo: start?.inReplyTo ?? null, references: start?.references ?? [] })
      onDone()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <AppBar
        left={
          <IconButton label="Discard" onPress={onDone}>
            <CloseIcon />
          </IconButton>
        }
        title={start?.subject.startsWith('Re:') ? 'Reply' : start?.subject.startsWith('Fwd:') ? 'Forward' : 'New message'}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={busy} onPress={() => void send()} style={[st.send, busy && { opacity: 0.5 }]}>
            <Text style={st.sendText}>{busy ? 'Sending…' : 'Send'}</Text>
          </Pressable>
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>
          <Row label="From">
            <Text numberOfLines={1} style={st.fromText}>
              {account.email}
            </Text>
          </Row>
          <Row label="To">
            <TextInput value={to} onChangeText={setTo} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} style={st.input} placeholder="name@example.com" placeholderTextColor={colors.faint} />
            {!showCc && (
              <Pressable accessibilityRole="button" onPress={() => setShowCc(true)} hitSlop={8}>
                <Text style={st.link}>Cc</Text>
              </Pressable>
            )}
          </Row>
          {showCc && (
            <Row label="Cc">
              <TextInput value={cc} onChangeText={setCc} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} style={st.input} />
            </Row>
          )}
          <Row label="Subject">
            <TextInput value={subject} onChangeText={setSubject} style={st.input} />
          </Row>
          <TextInput value={text} onChangeText={setText} multiline placeholder="Write your message" placeholderTextColor={colors.faint} style={st.body} textAlignVertical="top" />
          {files.length > 0 && (
            <View style={st.chips}>
              {files.map((f, i) => (
                <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Remove ${f.filename}`} onPress={() => setFiles((all) => all.filter((_, j) => j !== i))} style={st.chip}>
                  <Text numberOfLines={1} style={st.chipText}>
                    {f.filename}  ✕
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {error !== null && (
            <View style={{ padding: 16 }}>
              <ErrorText>{error}</ErrorText>
            </View>
          )}
        </ScrollView>
        <View style={st.tools}>
          <Pressable accessibilityRole="button" onPress={() => void pick()} style={st.tool}>
            <Text style={st.toolText}>Attach</Text>
          </Pressable>
          {templateList.length > 0 && (
            <Pressable accessibilityRole="button" onPress={() => setTemplates(true)} style={st.tool}>
              <Text style={st.toolText}>Templates</Text>
            </Pressable>
          )}
          <Note style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 12 }}>{files.length > 0 ? `${files.length} attached` : ''}</Note>
        </View>
      </KeyboardAvoidingView>

      <Sheet open={templates} onClose={() => setTemplates(false)}>
        <MenuLabel>Insert a template</MenuLabel>
        {templateList.map((t) => (
          <MenuItem key={t.id} label={t.data.name || '(untitled)'} onPress={() => useTemplate(t.data)} />
        ))}
      </Sheet>
    </Screen>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={st.row}>
      <Text style={st.label}>{label}</Text>
      {children}
    </View>
  )
}

const st = StyleSheet.create({
  send: { backgroundColor: colors.accent, borderRadius: radius, paddingHorizontal: 16, paddingVertical: 9, marginRight: 8 },
  sendText: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  label: { color: colors.muted, fontSize: 14, width: 56 },
  fromText: { flex: 1, color: colors.soft, fontSize: 15 },
  input: { flex: 1, color: colors.text, fontSize: 15, paddingVertical: 12 },
  link: { color: colors.link, fontSize: 14, fontWeight: '500' },
  body: { flex: 1, minHeight: 240, color: colors.text, fontSize: 16, lineHeight: 23, paddingHorizontal: 16, paddingVertical: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  chip: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  chipText: { color: colors.soft, fontSize: 13 },
  tools: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.rail },
  tool: { borderWidth: 1, borderColor: colors.line, borderRadius: radius, paddingHorizontal: 14, paddingVertical: 10 },
  toolText: { color: colors.soft, fontSize: 14, fontWeight: '500' }
})

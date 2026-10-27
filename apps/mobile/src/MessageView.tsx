import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Sharing from 'expo-sharing'
import { assess } from '@imc/core'
import { labelsByMessage, listLabels, setLabel, setSnooze, snoozedUntil, startDraft, type Address, type Folder, type MessageAction, type ReplyMode, type Summary } from '@imc/mail'
import { buildPhoneDocument, sanitizeEmailHtml, textToHtml } from '@imc/mail/render'
import type { PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { items } from './db'
import { actOn, readMessage, saveAttachment, type OpenedMessage } from './mail'
import MessageHtml from './MessageHtml'
import { tell } from './report'
import { describeError, type ComposeStart } from './screens'
import { colors, ErrorText, Link, Note, Screen } from './ui'

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const who = (a: Address): string => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)
const size = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)
const addressText = (list: Address[]): string => list.map((a) => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)).join(', ')

interface Props {
  account: PhoneAccount
  folder: Folder
  summary: Summary
  onBack: () => void
  onCompose: (start: ComposeStart) => void
}

/**
 * One message. HTML mail is shown in a locked-down web view (sanitized, no scripts, web images off until you allow
 * them); plain text is shown the same way. A message that looks like a scam gets a warning and its links turned off.
 */
export default function MessageView({ account, folder, summary, onBack, onCompose }: Props) {
  const [opened, setOpened] = useState<OpenedMessage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [allowImages, setAllowImages] = useState(false)
  const [more, setMore] = useState(false)
  const [starred, setStarred] = useState(summary.flags.includes('\\Flagged'))
  const changed = useChanged()

  useEffect(() => {
    let live = true
    readMessage(account, folder, summary)
      .then((m) => {
        void tell({ opened: account.provider, fromCache: m.fromCache, rawBytes: m.rawBytes })
        if (live) setOpened(m)
      })
      .catch((e: unknown) => {
        if (live) setError(describeError(e) || 'This message could not be opened')
      })
    return () => {
      live = false
    }
  }, [account, folder, summary])

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

  const labels = useMemo(() => {
    void changed
    return { all: listLabels(items), on: new Set(summary.messageId ? (labelsByMessage(items, account.email).get(summary.messageId) ?? []) : []) }
  }, [account, summary, changed])
  const snoozed = summary.messageId ? snoozedUntil(items, account.email, summary.messageId) : null

  const attachments = m?.attachments.map((a, index) => ({ a, index })).filter(({ a }) => !a.inline) ?? []
  const from = summary.from

  const run = async (action: MessageAction, leave: boolean) => {
    try {
      await actOn(account, folder, [summary], action)
      if (action === 'star' || action === 'unstar') setStarred(action === 'star')
      if (leave) onBack()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const reply = (mode: ReplyMode) => {
    // The quoted text comes from the message body, so wait until it has been read.
    if (!m) return setError('Wait for the message to finish loading, then try again.')
    const d = startDraft({ from: summary.from, to: summary.to, cc: summary.cc, subject: summary.subject, messageId: summary.messageId, references: summary.references, date: summary.date, text: m.text }, mode, account.email)
    onCompose({ to: addressText(d.to), cc: addressText(d.cc), subject: d.subject, text: d.text, inReplyTo: d.inReplyTo, references: d.references })
  }

  const snooze = (until: number | null) => {
    if (!summary.messageId) return
    setSnooze(items, account.email, summary.messageId, until)
    notifyChanged()
    if (until !== null) onBack()
  }
  const at = (days: number, hour: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    d.setHours(hour, 0, 0, 0)
    return d.getTime()
  }

  const openAttachment = async (index: number) => {
    try {
      const f = await saveAttachment(account, folder, summary, index)
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(f.uri, { mimeType: f.mimeType, dialogTitle: f.filename })
      else setError('This phone cannot open files from here.')
    } catch (e) {
      setError(describeError(e))
    }
  }

  const footer = (
    <View style={st.bar}>
      <Link onPress={() => reply('reply')}>Reply</Link>
      <Link onPress={() => reply('replyAll')}>Reply all</Link>
      <Link onPress={() => reply('forward')}>Forward</Link>
      <Link onPress={() => void run('archive', true)}>Archive</Link>
      <Link onPress={() => void run('trash', true)}>Trash</Link>
      <Link onPress={() => setMore(!more)}>{more ? 'Less' : 'More'}</Link>
    </View>
  )

  return (
    <Screen footer={footer}>
      <ScrollView style={st.head} contentContainerStyle={{ padding: 16, gap: 3 }} nestedScrollEnabled>
        <Link onPress={onBack}>‹ Back</Link>
        <Text style={st.subject}>{summary.subject || '(no subject)'}</Text>
        <Text style={st.meta}>From {from ? who(from) : '(unknown sender)'}</Text>
        {summary.to.length > 0 && <Text style={st.meta}>To {summary.to.map(who).join(', ')}</Text>}
        {summary.cc.length > 0 && <Text style={st.meta}>Cc {summary.cc.map(who).join(', ')}</Text>}
        {summary.date !== null && <Text style={st.meta}>{full.format(summary.date)}</Text>}
        {snoozed !== null && <Note>Snoozed until {full.format(snoozed)}</Note>}
        {risk && risk.level !== 'none' && (
          <View style={[st.warning, risk.level === 'danger' && st.danger]}>
            <Text style={st.warningTitle}>{risk.level === 'danger' ? 'This message looks like a scam. Its links are turned off.' : 'Be careful with this message.'}</Text>
            {risk.reasons.slice(0, 3).map((r) => (
              <Text key={r.code} style={st.warningText}>
                {r.text}
              </Text>
            ))}
          </View>
        )}
        {page !== null && page.blocked > 0 && !allowImages && <Link onPress={() => setAllowImages(true)}>{`Show ${page.blocked} blocked image${page.blocked === 1 ? '' : 's'} (the sender can tell you opened it)`}</Link>}
        {attachments.map(({ a, index }) => (
          <Link key={index} onPress={() => void openAttachment(index)}>{`📎 ${a.filename} (${size(a.size)})`}</Link>
        ))}
        {opened?.truncated && <Note>This message is long, so only the first part was downloaded.</Note>}
        {more && (
          <View style={st.more}>
            <Link onPress={() => void run('markUnread', true)}>Mark unread</Link>
            <Link onPress={() => void run(starred ? 'unstar' : 'star', false)}>{starred ? 'Remove star' : 'Star'}</Link>
            <Link onPress={() => void run('junk', true)}>Junk</Link>
            <Link danger onPress={() => Alert.alert('Delete forever?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run('delete', true) }])}>
              Delete forever
            </Link>
            {summary.messageId && (
              <>
                <Note>Snooze until</Note>
                <View style={st.wrap}>
                  <Link onPress={() => snooze(Date.now() + 3 * 3_600_000)}>3 hours</Link>
                  <Link onPress={() => snooze(at(1, 8))}>Tomorrow</Link>
                  <Link onPress={() => snooze(at(7, 8))}>Next week</Link>
                  {snoozed !== null && <Link onPress={() => snooze(null)}>Stop snoozing</Link>}
                </View>
                {labels.all.length > 0 && <Note>Labels</Note>}
                <View style={st.wrap}>
                  {labels.all.map((l) => (
                    <Pressable
                      key={l.id}
                      accessibilityRole="button"
                      onPress={() => {
                        setLabel(items, account.email, summary.messageId!, l.id, !labels.on.has(l.id))
                        notifyChanged()
                      }}
                      style={[st.label, labels.on.has(l.id) && st.labelOn]}
                    >
                      <Text style={st.labelText}>{l.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </View>
        )}
      </ScrollView>
      <View style={{ flex: 1 }}>
        {opened === null && error === null && <ActivityIndicator color={colors.muted} style={{ marginTop: 24 }} />}
        {error !== null && <ErrorText>{error}</ErrorText>}
        {page !== null && <MessageHtml doc={page.doc} />}
      </View>
    </Screen>
  )
}

const st = StyleSheet.create({
  head: { flexGrow: 0, maxHeight: '45%', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  subject: { color: colors.text, fontSize: 19, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 13 },
  warning: { borderLeftWidth: 3, borderLeftColor: colors.warn, backgroundColor: colors.raised, padding: 10, marginTop: 6, gap: 2 },
  danger: { borderLeftColor: colors.danger },
  warningTitle: { color: colors.text, fontWeight: '600' },
  warningText: { color: colors.soft, fontSize: 13 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 16, paddingVertical: 4, justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  more: { gap: 4, paddingTop: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  label: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  labelOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  labelText: { color: colors.soft, fontSize: 12 }
})

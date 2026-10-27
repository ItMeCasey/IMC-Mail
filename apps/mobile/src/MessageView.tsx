import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Sharing from 'expo-sharing'
import { assess } from '@imc/core'
import { labelsByMessage, listLabels, logoDomain, setLabel, setSnooze, snoozedUntil, startDraft, type Address, type Folder, type MessageAction, type ReplyMode, type Summary } from '@imc/mail'
import { buildPhoneDocument, sanitizeEmailHtml, textToHtml } from '@imc/mail/render'
import type { PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { AppBar, Avatar, BackIcon, IconButton, MenuItem, MenuLabel, Sheet } from './chrome'
import { items, settings } from './db'
import { actOn, readMessage, saveAttachment, type OpenedMessage } from './mail'
import MessageHtml from './MessageHtml'
import { tell } from './report'
import { describeError, type ComposeStart } from './screens'
import { colors, ErrorText, Link, Note, radius, Screen } from './ui'

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const who = (a: Address): string => (a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address)
const size = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} KB` : `${n} B`)
const addressText = (list: Address[]): string => list.map(who).join(', ')

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
  const [details, setDetails] = useState(false)
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
  const sender = from?.name || from?.address || '(unknown sender)'

  const run = async (action: MessageAction, leave: boolean) => {
    setMore(false)
    try {
      await actOn(account, folder, [summary], action)
      if (action === 'star' || action === 'unstar') setStarred(action === 'star')
      if (leave) onBack()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const reply = (mode: ReplyMode) => {
    setMore(false)
    // The quoted text comes from the message body, so wait until it has been read.
    if (!m) return setError('Wait for the message to finish loading, then try again.')
    const d = startDraft({ from: summary.from, to: summary.to, cc: summary.cc, subject: summary.subject, messageId: summary.messageId, references: summary.references, date: summary.date, text: m.text }, mode, account.email)
    onCompose({ to: addressText(d.to), cc: addressText(d.cc), subject: d.subject, text: d.text, inReplyTo: d.inReplyTo, references: d.references })
  }

  const snooze = (until: number | null) => {
    setMore(false)
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
      <Action label="Reply" primary onPress={() => reply('reply')} />
      <Action label="Archive" onPress={() => void run('archive', true)} />
      <Action label="Trash" onPress={() => void run('trash', true)} />
      <Action label="More" onPress={() => setMore(true)} />
    </View>
  )

  return (
    <Screen footer={footer}>
      <AppBar
        left={
          <IconButton label="Back" onPress={onBack}>
            <BackIcon />
          </IconButton>
        }
        title={folder.name}
        subtitle={account.email}
      />
      <View style={st.head}>
        <Text style={st.subject}>{summary.subject || '(no subject)'}</Text>
        <Pressable accessibilityRole="button" onPress={() => setDetails(!details)} style={st.senderRow}>
          <Avatar name={sender} size={40} domain={settings.get().showLogos ? logoDomain(from?.address) : null} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={st.sender}>
              {sender}
            </Text>
            <Text numberOfLines={1} style={st.meta}>
              {summary.date !== null ? full.format(summary.date) : ''}
              {starred ? '  ★' : ''}
            </Text>
          </View>
          <Text style={st.meta}>{details ? 'Hide' : 'Details'}</Text>
        </Pressable>
        {details && (
          <View style={{ gap: 2 }}>
            {from && <Text style={st.meta}>From {who(from)}</Text>}
            {summary.to.length > 0 && <Text style={st.meta}>To {summary.to.map(who).join(', ')}</Text>}
            {summary.cc.length > 0 && <Text style={st.meta}>Cc {summary.cc.map(who).join(', ')}</Text>}
          </View>
        )}
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
        {attachments.length > 0 && (
          <View style={st.chips}>
            {attachments.map(({ a, index }) => (
              <Pressable key={index} accessibilityRole="button" onPress={() => void openAttachment(index)} style={st.chip}>
                <Text numberOfLines={1} style={st.chipText}>
                  {a.filename} · {size(a.size)}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {opened?.truncated && <Note>This message is long, so only the first part was downloaded.</Note>}
      </View>

      <View style={{ flex: 1 }}>
        {opened === null && error === null && <ActivityIndicator color={colors.muted} style={{ marginTop: 24 }} />}
        {error !== null && (
          <View style={{ padding: 16 }}>
            <ErrorText>{error}</ErrorText>
          </View>
        )}
        {page !== null && <MessageHtml doc={page.doc} />}
      </View>

      <Sheet open={more} onClose={() => setMore(false)}>
        <MenuItem label="Reply all" onPress={() => reply('replyAll')} />
        <MenuItem label="Forward" onPress={() => reply('forward')} />
        <MenuItem label="Mark unread" onPress={() => void run('markUnread', true)} />
        <MenuItem label={starred ? 'Remove star' : 'Star'} onPress={() => void run(starred ? 'unstar' : 'star', false)} />
        {summary.messageId && (
          <View>
            <MenuLabel>Snooze until</MenuLabel>
            <MenuItem label="In 3 hours" onPress={() => snooze(Date.now() + 3 * 3_600_000)} />
            <MenuItem label="Tomorrow morning" onPress={() => snooze(at(1, 8))} />
            <MenuItem label="Next week" onPress={() => snooze(at(7, 8))} />
            {snoozed !== null && <MenuItem label="Stop snoozing" onPress={() => snooze(null)} />}
            {labels.all.length > 0 && <MenuLabel>Labels</MenuLabel>}
            {labels.all.map((l) => (
              <MenuItem
                key={l.id}
                label={l.name}
                selected={labels.on.has(l.id)}
                onPress={() => {
                  setLabel(items, account.email, summary.messageId!, l.id, !labels.on.has(l.id))
                  notifyChanged()
                }}
              />
            ))}
          </View>
        )}
        <MenuLabel>Danger</MenuLabel>
        <MenuItem label="Move to junk" onPress={() => void run('junk', true)} />
        <MenuItem
          label="Delete forever"
          danger
          onPress={() => {
            setMore(false)
            Alert.alert('Delete forever?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void run('delete', true) }])
          }}
        />
      </Sheet>
    </Screen>
  )
}

function Action({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[st.action, primary && st.actionPrimary]}>
      <Text style={[st.actionText, primary && { color: colors.onAccent, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  )
}

const st = StyleSheet.create({
  head: { paddingHorizontal: 16, paddingVertical: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  subject: { color: colors.text, fontSize: 20, fontWeight: '600', letterSpacing: -0.2 },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sender: { color: colors.text, fontSize: 15, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 12 },
  warning: { borderLeftWidth: 3, borderLeftColor: colors.warn, backgroundColor: colors.raised, padding: 10, gap: 2 },
  danger: { borderLeftColor: colors.danger },
  warningTitle: { color: colors.text, fontWeight: '600' },
  warningText: { color: colors.soft, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%' },
  chipText: { color: colors.soft, fontSize: 13 },
  bar: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  action: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, borderRadius: radius, borderWidth: 1, borderColor: colors.line },
  actionPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  actionText: { color: colors.soft, fontSize: 14, fontWeight: '500' }
})

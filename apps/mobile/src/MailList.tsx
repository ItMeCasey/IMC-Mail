import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { classify } from '@imc/core'
import { appPrefs, labelsByMessage, listLabels, newMailToNotify, searchSummaries, snoozedNow, type Folder, type Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { items } from './db'
import { actOn, folderKey, lastSynced, refreshFolder, refreshFolders, savedFolders, savedMessages } from './mail'
import { mailAllowed, notifyNewMail } from './notify'
import { describeError, newId, when } from './screens'
import { tell } from './report'
import { Button, colors, ErrorText, Link, Note, radius, s, tapeFor } from './ui'

/** Coming back to a folder within this long of its last update does not ask the server again; pulling down always does. */
const FRESH_MS = 60_000

interface Props {
  accounts: PhoneAccount[]
  selected: { account: string | null; folder: string | null }
  onSelect: (s: { account: string | null; folder: string | null }) => void
  onOpen: (account: PhoneAccount, folder: Folder, m: Summary) => void
  onCompose: (account: PhoneAccount) => void
  onAddAccount: () => void
}

/** The mail tab: an account, a folder, a search, and the messages. Long-press to pick several and act on them together. */
export default function MailList({ accounts, selected, onSelect, onOpen, onCompose, onAddAccount }: Props) {
  const account = accounts.find((a) => a.email === selected.account) ?? accounts[0]
  const changed = useChanged()
  const [folders, setFolders] = useState<Folder[]>([])
  const folder = folders.find((f) => folderKey(f) === selected.folder) ?? folders.find((f) => f.specialUse === 'inbox') ?? folders[0]
  const [list, setList] = useState<Summary[] | null>(null)
  const [query, setQuery] = useState('')
  const [picker, setPicker] = useState<'folder' | 'account' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (account) setFolders(savedFolders(account))
    setChosen(new Set())
  }, [account])

  const load = useCallback(
    async (force: boolean) => {
      if (!account || !folder) return
      setError(null)
      const before = await savedMessages(account, folder)
      setList(before)
      const last = await lastSynced(account, folder)
      setSyncedAt(last)
      if (!force && last !== null && Date.now() - last < FRESH_MS) return
      setRefreshing(true)
      try {
        const known = savedFolders(account)
        if (known.length <= 1 && account.protocol !== 'pop3') setFolders(await refreshFolders(account))
        await refreshFolder(account, folder)
        const after = await savedMessages(account, folder)
        setList(after)
        setSyncedAt(await lastSynced(account, folder))
        if (folder.specialUse === 'inbox') void notifyNewMail(newMailToNotify(last === null ? null : before, after, { now: Date.now(), allowed: mailAllowed() }))
        void tell({ folder: account.provider, count: after.length })
      } catch (e) {
        setError(before.length > 0 ? `Could not update, showing saved mail. ${describeError(e)}` : describeError(e))
      } finally {
        setRefreshing(false)
      }
    },
    [account, folder]
  )

  useEffect(() => void load(false), [load])

  const labels = useMemo(() => {
    void changed
    return account ? { names: new Map(listLabels(items).map((l) => [l.id, l.name])), byMessage: labelsByMessage(items, account.email) } : null
  }, [account, changed, list])

  const shown = useMemo(() => {
    if (!list || !account || !labels) return []
    const snoozed = snoozedNow(items, account.email, Date.now())
    const visible = list.filter((m) => !(m.messageId && snoozed.has(m.messageId)))
    const labelsOf = (m: Summary) => (m.messageId ? (labels.byMessage.get(m.messageId) ?? []) : []).map((id) => labels.names.get(id) ?? '')
    return query.trim() ? searchSummaries(visible, query, { labelsOf }) : visible
  }, [list, query, account, labels])

  const searches = useMemo(() => {
    void changed
    return items.list<{ name: string; query: string }>('savedSearch').map((x) => ({ id: x.id, ...x.data }))
  }, [changed])

  // A colored mark down the edge of a row for the kind of mail (sponsorship, invoice, ...), when streamer features are on.
  const streamer = useMemo(() => {
    void changed
    return appPrefs(items).streamerFeatures
  }, [changed])
  const tape = (m: Summary): string | null => (streamer ? tapeFor(classify({ fromAddr: m.from?.address ?? '', fromName: m.from?.name ?? '', subject: m.subject }).category) : null)

  const toggle = (uid: number) =>
    setChosen((c) => {
      const n = new Set(c)
      if (!n.delete(uid)) n.add(uid)
      return n
    })

  const actOnChosen = async (action: Parameters<typeof actOn>[3]) => {
    if (!account || !folder) return
    const targets = shown.filter((m) => chosen.has(m.uid))
    setChosen(new Set())
    try {
      await actOn(account, folder, targets, action)
    } catch (e) {
      setError(describeError(e))
    }
    setList(await savedMessages(account, folder))
  }

  if (!account) {
    return (
      <View style={[st.empty]}>
        <Text style={s.title}>No accounts yet</Text>
        <Note>Add a mail account to read it on this phone.</Note>
        <Button onPress={onAddAccount}>Add an account</Button>
      </View>
    )
  }

  const selecting = chosen.size > 0
  const saveSearch = () => {
    const q = query.trim()
    if (q) items.put('savedSearch', newId(), { name: q.slice(0, 60), query: q })
    setQuery(q)
    notifyChanged()
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={st.head}>
        <Pressable accessibilityRole="button" onPress={() => setPicker(picker === 'account' ? null : 'account')} style={st.chip}>
          <Text numberOfLines={1} style={st.chipText}>
            {account.email}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setPicker(picker === 'folder' ? null : 'folder')} style={st.chip}>
          <Text numberOfLines={1} style={st.chipText}>
            {folder?.name ?? 'Inbox'}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Write a message" onPress={() => onCompose(account)} style={st.write}>
          <Text style={st.writeText}>Write</Text>
        </Pressable>
      </View>
      {picker === 'account' && (
        <View style={st.panel}>
          {accounts.map((a) => (
            <Link
              key={a.email}
              onPress={() => {
                setPicker(null)
                onSelect({ account: a.email, folder: null })
              }}
            >
              {a.email}
            </Link>
          ))}
          <Link onPress={onAddAccount}>Add an account…</Link>
        </View>
      )}
      {picker === 'folder' && (
        <View style={st.panel}>
          {folders
            .filter((f) => f.selectable)
            .map((f) => (
              <Link
                key={f.path}
                onPress={() => {
                  setPicker(null)
                  onSelect({ account: account.email, folder: folderKey(f) })
                }}
              >
                {f.name}
              </Link>
            ))}
        </View>
      )}
      <View style={st.searchRow}>
        <TextInput value={query} onChangeText={setQuery} placeholder="Search (from:  subject:  is:unread  label:)" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={st.search} />
        {query.trim() !== '' && <Link onPress={saveSearch}>Save</Link>}
      </View>
      {searches.length > 0 && (
        <View style={st.searches}>
          {searches.map((x) => (
            <Pressable key={x.id} accessibilityRole="button" onPress={() => setQuery(x.query)} onLongPress={() => items.remove('savedSearch', x.id)} style={st.saved}>
              <Text style={st.savedText}>{x.name}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {error !== null && <ErrorText>{error}</ErrorText>}
      {list === null && <ActivityIndicator color={colors.muted} style={{ marginTop: 24 }} />}
      <FlatList
        data={shown}
        keyExtractor={(m) => String(m.uid)}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />}
        ListHeaderComponent={!refreshing && syncedAt !== null && error === null ? <Note style={{ paddingHorizontal: 16, paddingBottom: 6 }}>Updated {when(syncedAt)}. Pull down to refresh.</Note> : undefined}
        ListEmptyComponent={list !== null && !refreshing ? <Note style={{ padding: 16 }}>{query ? 'Nothing matches.' : 'Nothing here.'}</Note> : undefined}
        renderItem={({ item: m }) => {
          const unread = !m.flags.includes('\\Seen')
          const on = chosen.has(m.uid)
          const tags = (m.messageId ? (labels?.byMessage.get(m.messageId) ?? []) : []).map((id) => labels?.names.get(id)).filter(Boolean)
          return (
            <Pressable accessibilityRole="button" onPress={() => (selecting ? toggle(m.uid) : folder && onOpen(account, folder, m))} onLongPress={() => toggle(m.uid)} style={[st.row, on && st.rowOn]}>
              <View style={[st.tape, { backgroundColor: tape(m) ?? (unread ? colors.accent : 'transparent') }]} />
              <View style={st.rowBody}>
                <View style={st.rowHead}>
                  <Text numberOfLines={1} style={[st.from, unread && st.unread]}>
                    {m.flags.includes('\\Flagged') ? '★ ' : ''}
                    {m.from?.name || m.from?.address || '(unknown sender)'}
                  </Text>
                  <Text style={st.when}>{when(m.date)}</Text>
                </View>
                <Text numberOfLines={1} style={[st.subject, unread && st.unread]}>
                  {m.subject || '(no subject)'}
                </Text>
                {tags.length > 0 && <Text style={st.tags}>{tags.join(' · ')}</Text>}
              </View>
            </Pressable>
          )
        }}
      />
      {selecting && (
        <View style={st.bar}>
          <Text style={st.barText}>{chosen.size} chosen</Text>
          <Link onPress={() => void actOnChosen('archive')}>Archive</Link>
          <Link onPress={() => void actOnChosen('trash')}>Trash</Link>
          <Link onPress={() => void actOnChosen('markRead')}>Read</Link>
          <Link onPress={() => void actOnChosen('markUnread')}>Unread</Link>
          <Link onPress={() => setChosen(new Set())}>Cancel</Link>
        </View>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  empty: { flex: 1, padding: 16, gap: 12, justifyContent: 'center' },
  head: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10, alignItems: 'center' },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, borderRadius: radius, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 },
  chipText: { color: colors.soft, fontSize: 13, fontWeight: '500' },
  write: { marginLeft: 'auto', backgroundColor: colors.accent, borderRadius: radius, paddingHorizontal: 14, paddingVertical: 7 },
  writeText: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  panel: { marginHorizontal: 16, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginBottom: 6 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  search: { flex: 1, color: colors.text, backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  searches: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, paddingBottom: 8 },
  saved: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius, paddingHorizontal: 8, paddingVertical: 3 },
  savedText: { color: colors.muted, fontSize: 12 },
  row: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowOn: { backgroundColor: colors.selected },
  tape: { width: 3 },
  rowBody: { flex: 1, paddingVertical: 10, paddingHorizontal: 13, gap: 2 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  from: { color: colors.soft, fontSize: 15, flex: 1 },
  subject: { color: colors.muted, fontSize: 14 },
  unread: { color: colors.text, fontWeight: '600' },
  when: { color: colors.faint, fontSize: 12, fontVariant: ['tabular-nums'] },
  tags: { color: colors.warn, fontSize: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 6, backgroundColor: colors.rail, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, flexWrap: 'wrap' },
  barText: { color: colors.text, marginRight: 'auto', fontWeight: '600' }
})

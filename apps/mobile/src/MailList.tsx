import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { classify } from '@imc/core'
import { appPrefs, labelsByMessage, listLabels, logoDomain, newMailToNotify, searchSummaries, snoozedNow, type Folder, type Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { ALL_INBOXES } from './UnifiedList'
import { AppBar, Avatar, CloseIcon, Fab, IconButton, MenuIcon, MenuItem, MenuLabel, SearchIcon, Sheet } from './chrome'
import { items, settings } from './db'
import { stamp } from './perf'
import { actOn, folderKey, lastSynced, prefetchBodies, refreshFolder, refreshFolders, savedFolders, savedMessages, SHOWN_MESSAGES } from './mail'
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

/** Special folders first, in the order people look for them, then the rest by name. */
const ORDER = ['inbox', 'drafts', 'sent', 'archive', 'all', 'flagged', 'junk', 'trash']
const rank = (f: Folder): number => {
  const i = f.specialUse ? ORDER.indexOf(f.specialUse) : -1
  return i === -1 ? ORDER.length : i
}
/** How far to indent a folder: one step for each parent folder that can itself be opened (Gmail's "[Gmail]" is only a heading). */
const depthOf = (f: Folder, openable: Set<string>): number => {
  if (!f.delimiter) return 0
  const parts = f.path.split(f.delimiter)
  let depth = 0
  for (let i = 1; i < parts.length; i++) if (openable.has(parts.slice(0, i).join(f.delimiter))) depth++
  return depth
}

/** The mail tab: a bar with the folder and account, the messages, and a menu (the drawer) for accounts and folders. */
export default function MailList({ accounts, selected, onSelect, onOpen, onCompose, onAddAccount }: Props) {
  const account = accounts.find((a) => a.email === selected.account) ?? accounts[0]
  const changed = useChanged()
  const [folders, setFolders] = useState<Folder[]>([])
  const folder = folders.find((f) => folderKey(f) === selected.folder) ?? folders.find((f) => f.specialUse === 'inbox') ?? folders[0]
  const [list, setList] = useState<Summary[] | null>(null)
  const [limit, setLimit] = useState(SHOWN_MESSAGES)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menu, setMenu] = useState(false)
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
      const t0 = Date.now()
      const before = await savedMessages(account, folder, limit)
      setList(before)
      const t1 = stamp(`list: read ${before.length} saved`, t0)
      const last = await lastSynced(account, folder)
      setSyncedAt(last)
      if (!force && last !== null && Date.now() - last < FRESH_MS) return
      setRefreshing(true)
      try {
        const known = savedFolders(account)
        if (known.length <= 1 && account.protocol !== 'pop3') setFolders(await refreshFolders(account))
        await refreshFolder(account, folder)
        stamp('list: refresh from server', t1)
        const after = await savedMessages(account, folder, limit)
        setList(after)
        setSyncedAt(await lastSynced(account, folder))
        if (folder.specialUse === 'inbox') void notifyNewMail(newMailToNotify(last === null ? null : before, after, { now: Date.now(), allowed: mailAllowed() }), account.email)
        void tell({ folder: account.provider, count: after.length })
        void prefetchBodies(account, folder, after)
      } catch (e) {
        setError(before.length > 0 ? `Could not update, showing saved mail. ${describeError(e)}` : describeError(e))
      } finally {
        setRefreshing(false)
      }
    },
    [account, folder, limit]
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

  // A colored mark for the kind of mail (sponsorship, invoice, ...), when streamer features are on.
  const streamer = useMemo(() => {
    void changed
    return appPrefs(items).streamerFeatures
  }, [changed])
  const tape = (m: Summary): string | null => (streamer ? tapeFor(classify({ fromAddr: m.from?.address ?? '', fromName: m.from?.name ?? '', subject: m.subject }).category) : null)

  const logos = useMemo(() => {
    void changed
    return settings.get().showLogos
  }, [changed])

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
    setList(await savedMessages(account, folder, limit))
  }

  if (!account) {
    return (
      <View style={st.empty}>
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
  const closeSearch = () => {
    setSearching(false)
    setQuery('')
  }
  const sorted = [...folders].filter((f) => f.selectable).sort((a, b) => rank(a) - rank(b))
  const openable = new Set(sorted.map((f) => f.path))

  return (
    <View style={{ flex: 1 }}>
      {selecting ? (
        <AppBar
          left={
            <IconButton label="Cancel selection" onPress={() => setChosen(new Set())}>
              <CloseIcon />
            </IconButton>
          }
          title={`${chosen.size} chosen`}
        />
      ) : (
        <AppBar
          left={
            <IconButton label="Accounts and folders" onPress={() => setMenu(true)}>
              <MenuIcon />
            </IconButton>
          }
          title={folder?.name ?? 'Inbox'}
          subtitle={account.email}
          right={
            <IconButton label="Search" onPress={() => (searching ? closeSearch() : setSearching(true))}>
              {searching ? <CloseIcon /> : <SearchIcon />}
            </IconButton>
          }
        />
      )}

      {(searching || query !== '') && !selecting && (
        <View style={st.searchRow}>
          <TextInput autoFocus={searching && query === ''} value={query} onChangeText={setQuery} placeholder="Search: from:  subject:  is:unread  label:" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={st.search} />
          {query.trim() !== '' && <Link onPress={saveSearch}>Save</Link>}
        </View>
      )}
      {error !== null && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <ErrorText>{error}</ErrorText>
        </View>
      )}
      {list === null && <ActivityIndicator color={colors.muted} style={{ marginTop: 24 }} />}

      <FlatList
        data={shown}
        keyExtractor={(m) => String(m.uid)}
        onEndReached={() => list && list.length >= limit && setLimit((l) => l + SHOWN_MESSAGES)}
        onEndReachedThreshold={1.5}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />}
        ListHeaderComponent={!refreshing && syncedAt !== null && error === null ? <Text style={st.updated}>Updated {when(syncedAt)}</Text> : undefined}
        ListEmptyComponent={list !== null && !refreshing ? <Note style={{ padding: 16 }}>{query ? 'Nothing matches.' : 'Nothing here.'}</Note> : undefined}
        renderItem={({ item: m }) => {
          const unread = !m.flags.includes('\\Seen')
          const on = chosen.has(m.uid)
          const who = m.from?.name || m.from?.address || '(unknown sender)'
          const tags = (m.messageId ? (labels?.byMessage.get(m.messageId) ?? []) : []).map((id) => labels?.names.get(id)).filter(Boolean)
          return (
            <Pressable accessibilityRole="button" onPress={() => (selecting ? toggle(m.uid) : folder && onOpen(account, folder, m))} onLongPress={() => toggle(m.uid)} style={[st.row, on && st.rowOn]}>
              <Avatar name={who} color={tape(m)} domain={logos ? logoDomain(m.from?.address) : null} />
              <View style={st.rowBody}>
                <View style={st.rowHead}>
                  <Text numberOfLines={1} style={[st.from, unread && st.unread]}>
                    {who}
                  </Text>
                  <Text style={[st.when, unread && { color: colors.accent }]}>{when(m.date)}</Text>
                </View>
                <View style={st.rowHead}>
                  <Text numberOfLines={1} style={[st.subject, unread && st.unreadSubject]}>
                    {m.flags.includes('\\Flagged') ? '★ ' : ''}
                    {m.subject || '(no subject)'}
                  </Text>
                  {unread && <View style={st.dot} />}
                </View>
                {tags.length > 0 && <Text style={st.tags}>{tags.join(' · ')}</Text>}
              </View>
            </Pressable>
          )
        }}
      />

      {selecting ? (
        <View style={st.bar}>
          <Link onPress={() => void actOnChosen('archive')}>Archive</Link>
          <Link onPress={() => void actOnChosen('trash')}>Trash</Link>
          <Link onPress={() => void actOnChosen('markRead')}>Read</Link>
          <Link onPress={() => void actOnChosen('markUnread')}>Unread</Link>
        </View>
      ) : (
        <Fab label="Write" onPress={() => onCompose(account)} />
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} side="left">
        {accounts.length > 1 && (
          <MenuItem
            label="All inboxes"
            onPress={() => {
              setMenu(false)
              onSelect({ account: ALL_INBOXES, folder: null })
            }}
          />
        )}
        <MenuLabel>Accounts</MenuLabel>
        {accounts.map((a) => (
          <Pressable
            key={a.email}
            accessibilityRole="button"
            onPress={() => {
              setMenu(false)
              onSelect({ account: a.email, folder: null })
            }}
            style={[st.accountRow, a.email === account.email && { backgroundColor: colors.selected }]}
          >
            <Avatar name={a.name || a.email} size={32} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15 }}>
                {a.name || a.email}
              </Text>
              <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12 }}>
                {a.email}
              </Text>
            </View>
          </Pressable>
        ))}
        <MenuItem
          label="Add an account"
          onPress={() => {
            setMenu(false)
            onAddAccount()
          }}
        />
        <MenuLabel>Folders</MenuLabel>
        <FlatList
          style={{ flex: 1 }}
          data={sorted}
          keyExtractor={(f) => f.path}
          renderItem={({ item: f }) => (
            <MenuItem
              label={f.name}
              indent={depthOf(f, openable)}
              selected={!!folder && f.path === folder.path}
              onPress={() => {
                setMenu(false)
                onSelect({ account: account.email, folder: folderKey(f) })
              }}
            />
          )}
          ListFooterComponent={
            searches.length > 0 ? (
              <View>
                <MenuLabel>Saved searches</MenuLabel>
                {searches.map((x) => (
                  <MenuItem
                    key={x.id}
                    label={x.name}
                    onPress={() => {
                      setMenu(false)
                      setSearching(true)
                      setQuery(x.query)
                    }}
                  />
                ))}
              </View>
            ) : undefined
          }
        />
      </Sheet>
    </View>
  )
}

const st = StyleSheet.create({
  empty: { flex: 1, padding: 16, gap: 12, justifyContent: 'center' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  search: { flex: 1, color: colors.text, backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
  updated: { color: colors.faint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowOn: { backgroundColor: colors.selected },
  rowBody: { flex: 1, gap: 2 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  from: { color: colors.soft, fontSize: 15, flex: 1 },
  subject: { color: colors.muted, fontSize: 14, flex: 1 },
  unread: { color: colors.text, fontWeight: '600' },
  unreadSubject: { color: colors.soft },
  when: { color: colors.faint, fontSize: 12, fontVariant: ['tabular-nums'] },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  tags: { color: colors.warn, fontSize: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 8, backgroundColor: colors.rail, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10 }
})

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { classify } from '@imc/core'
import { appPrefs, labelsByMessage, listLabels, logoDomain, searchSummaries, snoozedNow, type Folder, type Summary } from '@imc/mail'
import type { PhoneAccount } from './auth'
import { useChanged } from './changes'
import { AppBar, Avatar, CloseIcon, Fab, IconButton, MenuIcon, MenuItem, MenuLabel, SearchIcon, Sheet } from './chrome'
import { items, settings } from './db'
import { checkInbox, INBOX } from './inbox-check'
import { actOn, lastSynced, savedFolders, savedMessages } from './mail'
import { notifyNewMail } from './notify'
import { describeError, when } from './screens'
import { colors, ErrorText, Link, Note, radius, tapeFor } from './ui'

/** Coming back within this long of the last update does not ask the servers again; pulling down always does. */
const FRESH_MS = 60_000
/** The most messages shown: the newest across all accounts. */
const MAX_ROWS = 300

export const ALL_INBOXES = '*'

interface Row {
  account: PhoneAccount
  m: Summary
}

const key = (r: Row) => `${r.account.email}:${r.m.uid}`
const inboxOf = (a: PhoneAccount): Folder => savedFolders(a).find((f) => f.specialUse === 'inbox') ?? INBOX

interface Props {
  accounts: PhoneAccount[]
  onSelect: (s: { account: string | null; folder: string | null }) => void
  onOpen: (account: PhoneAccount, folder: Folder, m: Summary) => void
  onCompose: (account: PhoneAccount) => void
  onAddAccount: () => void
}

/** Every account's inbox in one list, newest first, each message marked with the account it came to. */
export default function UnifiedList({ accounts, onSelect, onOpen, onCompose, onAddAccount }: Props) {
  const changed = useChanged()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const tone = (a: PhoneAccount) => colors.tape[Math.max(0, accounts.findIndex((x) => x.email === a.email)) % colors.tape.length]!

  const read = useCallback(async (): Promise<Row[]> => {
    const lists = await Promise.all(accounts.map(async (account) => (await savedMessages(account, inboxOf(account))).map((m): Row => ({ account, m }))))
    return lists.flat()
  }, [accounts])

  const load = useCallback(
    async (force: boolean) => {
      setError(null)
      setRows(await read())
      const stale: PhoneAccount[] = []
      for (const a of accounts) {
        const last = await lastSynced(a, inboxOf(a))
        if (force || last === null || Date.now() - last >= FRESH_MS) stale.push(a)
      }
      if (stale.length === 0) return
      setRefreshing(true)
      const failures: string[] = []
      await Promise.all(
        stale.map(async (a) => {
          try {
            void notifyNewMail(await checkInbox(a), a.email)
          } catch (e) {
            failures.push(`${a.email}: ${describeError(e)}`)
          }
        })
      )
      setRows(await read())
      if (failures.length > 0) setError(`Could not update ${failures.join('; ')}`)
      setRefreshing(false)
    },
    [accounts, read]
  )

  useEffect(() => void load(false), [load])

  const labels = useMemo(() => {
    void changed
    return new Map(listLabels(items).map((l) => [l.id, l.name]))
  }, [changed])

  const shown = useMemo(() => {
    if (!rows) return []
    const out: Row[] = []
    for (const a of accounts) {
      const mine = rows.filter((r) => r.account.email === a.email)
      const snoozed = snoozedNow(items, a.email, Date.now())
      const byMessage = labelsByMessage(items, a.email)
      const visible = mine.filter((r) => !(r.m.messageId && snoozed.has(r.m.messageId)))
      const labelsOf = (m: Summary) => (m.messageId ? (byMessage.get(m.messageId) ?? []) : []).map((id) => labels.get(id) ?? '')
      const found = query.trim() ? new Set(searchSummaries(visible.map((r) => r.m), query, { labelsOf }).map((m) => m.uid)) : null
      for (const r of visible) if (!found || found.has(r.m.uid)) out.push(r)
    }
    return out.sort((x, y) => (y.m.date ?? 0) - (x.m.date ?? 0)).slice(0, MAX_ROWS)
  }, [rows, accounts, query, labels])

  const unread = useMemo(() => (rows ?? []).filter((r) => !r.m.flags.includes('\\Seen')).length, [rows])

  const streamer = useMemo(() => {
    void changed
    return appPrefs(items).streamerFeatures
  }, [changed])
  const tape = (m: Summary): string | null => (streamer ? tapeFor(classify({ fromAddr: m.from?.address ?? '', fromName: m.from?.name ?? '', subject: m.subject }).category) : null)
  const logos = useMemo(() => {
    void changed
    return settings.get().showLogos
  }, [changed])

  const toggle = (k: string) =>
    setChosen((c) => {
      const n = new Set(c)
      if (!n.delete(k)) n.add(k)
      return n
    })

  const actOnChosen = async (action: Parameters<typeof actOn>[3]) => {
    const targets = shown.filter((r) => chosen.has(key(r)))
    setChosen(new Set())
    try {
      for (const a of accounts) {
        const mine = targets.filter((r) => r.account.email === a.email).map((r) => r.m)
        if (mine.length > 0) await actOn(a, inboxOf(a), mine, action)
      }
    } catch (e) {
      setError(describeError(e))
    }
    setRows(await read())
  }

  const selecting = chosen.size > 0
  const several = accounts.length > 1

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
          title="All inboxes"
          subtitle={unread > 0 ? `${unread} unread · ${accounts.length} accounts` : `${accounts.length} accounts`}
          right={
            <IconButton label="Search" onPress={() => (searching ? (setSearching(false), setQuery('')) : setSearching(true))}>
              {searching ? <CloseIcon /> : <SearchIcon />}
            </IconButton>
          }
        />
      )}

      {(searching || query !== '') && !selecting && (
        <View style={st.searchRow}>
          <TextInput autoFocus={searching && query === ''} value={query} onChangeText={setQuery} placeholder="Search: from:  subject:  is:unread  label:" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={st.search} />
        </View>
      )}
      {error !== null && (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <ErrorText>{error}</ErrorText>
        </View>
      )}
      {rows === null && <ActivityIndicator color={colors.muted} style={{ marginTop: 24 }} />}

      <FlatList
        data={shown}
        keyExtractor={key}
        contentContainerStyle={{ paddingBottom: 96 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.muted} colors={[colors.accent]} progressBackgroundColor={colors.raised} />}
        ListEmptyComponent={rows !== null && !refreshing ? <Note style={{ padding: 16 }}>{query ? 'Nothing matches.' : 'Nothing here.'}</Note> : undefined}
        renderItem={({ item: r }) => {
          const m = r.m
          const unreadRow = !m.flags.includes('\\Seen')
          const on = chosen.has(key(r))
          const who = m.from?.name || m.from?.address || '(unknown sender)'
          return (
            <Pressable accessibilityRole="button" onPress={() => (selecting ? toggle(key(r)) : onOpen(r.account, inboxOf(r.account), m))} onLongPress={() => toggle(key(r))} style={[st.row, on && st.rowOn]}>
              <Avatar name={who} color={tape(m)} domain={logos ? logoDomain(m.from?.address) : null} />
              <View style={st.rowBody}>
                <View style={st.rowHead}>
                  <Text numberOfLines={1} style={[st.from, unreadRow && st.unread]}>
                    {who}
                  </Text>
                  <Text style={[st.when, unreadRow && { color: colors.accent }]}>{when(m.date)}</Text>
                </View>
                <View style={st.rowHead}>
                  <Text numberOfLines={1} style={[st.subject, unreadRow && st.unreadSubject]}>
                    {m.flags.includes('\\Flagged') ? '★ ' : ''}
                    {m.subject || '(no subject)'}
                  </Text>
                  {unreadRow && <View style={st.dot} />}
                </View>
                {several && (
                  <Text numberOfLines={1} style={[st.account, { color: tone(r.account) }]}>
                    ● {r.account.email}
                  </Text>
                )}
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
        <Fab label="Write" onPress={() => accounts[0] && onCompose(accounts[0])} />
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} side="left">
        <MenuLabel>Mail</MenuLabel>
        <MenuItem label="All inboxes" selected onPress={() => setMenu(false)} />
        <MenuLabel>Accounts</MenuLabel>
        {accounts.map((a) => (
          <Pressable
            key={a.email}
            accessibilityRole="button"
            onPress={() => {
              setMenu(false)
              onSelect({ account: a.email, folder: null })
            }}
            style={st.accountRow}
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
      </Sheet>
    </View>
  )
}

const st = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  search: { flex: 1, color: colors.text, backgroundColor: colors.raised, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14 },
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
  account: { fontSize: 11 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 8, backgroundColor: colors.rail, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 10 }
})

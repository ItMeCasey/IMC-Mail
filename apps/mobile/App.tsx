import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { navBack, navCanBack, navCanForward, navCurrent, navFilter, navForward, navPush, navStart, type NavHistory } from '@imc/core'
import type { Summary } from '@imc/mail'
import { loadAccounts, removeAccount, signIn, type PhoneAccount } from './src/auth'
import { lastSynced, refreshInbox, savedInbox } from './src/inbox'
import { forgetAccount } from './src/db'
import Diagnostics from './src/Diagnostics'
import MessageView from './src/MessageView'
import { tell } from './src/report'

type Screen = { name: 'home' } | { name: 'inbox'; account: PhoneAccount } | { name: 'message'; account: PhoneAccount; summary: Summary } | { name: 'diagnostics' }

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const when = (ms: number | null): string => {
  if (ms === null) return ''
  const d = new Date(ms)
  const now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** Coming back to the inbox within this long of the last update does not ask the server again; pulling down always does. */
const FRESH_MS = 60_000

export default function App() {
  const [nav, setNav] = useState<NavHistory<Screen>>(() => navStart<Screen>({ name: 'home' }))
  const [accounts, setAccounts] = useState<PhoneAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const screen = navCurrent(nav)

  const go = useCallback((next: Screen) => setNav((h) => navPush(h, next)), [])
  const back = useCallback(() => setNav((h) => navBack(h)), [])
  const forward = useCallback(() => setNav((h) => navForward(h)), [])

  useEffect(() => void loadAccounts().then(setAccounts), [])

  // The phone's back gesture (and back button) goes to the previous screen, and only leaves the app from the first one.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navCanBack(nav)) return false
      back()
      return true
    })
    return () => sub.remove()
  }, [nav, back])

  const add = async (provider: 'gmail' | 'microsoft') => {
    setBusy(provider)
    setError(null)
    try {
      const account = await signIn(provider)
      setAccounts(await loadAccounts())
      void tell({ signedIn: provider })
      go({ name: 'inbox', account })
    } catch (e) {
      setError(describeError(e))
      void tell({ signInFailed: provider, message: describeError(e) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (account: PhoneAccount) => {
    await removeAccount(account.email)
    await forgetAccount(account.email)
    setAccounts(await loadAccounts())
    // Screens of the removed account must not be reachable by Back or Forward.
    setNav((h) => navFilter(h, (sc) => !('account' in sc) || sc.account.email !== account.email, { name: 'home' }))
  }

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {screen.name === 'diagnostics' && <Diagnostics onBack={back} />}
      {screen.name === 'message' && <MessageView key={`${screen.account.email}:${screen.summary.uid}`} account={screen.account} summary={screen.summary} onBack={back} />}
      {screen.name === 'inbox' && <Inbox key={screen.account.email} account={screen.account} onBack={back} onOpen={(summary) => go({ name: 'message', account: screen.account, summary })} onRemove={() => void remove(screen.account)} />}
      {screen.name === 'home' && (
        <ScrollView contentContainerStyle={s.body}>
          <Text style={s.title}>IMC-Mail</Text>
          <Text style={s.note}>Your mail on this phone. Sign-in goes through your provider; this app never sees your password.</Text>
          {accounts.map((a) => (
            <Pressable key={a.email} accessibilityRole="button" onPress={() => go({ name: 'inbox', account: a })} style={s.card}>
              <Text style={s.cardTitle}>{a.email}</Text>
              <Text style={s.cardSub}>{a.provider === 'gmail' ? 'Google' : 'Microsoft'}</Text>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void add('gmail')} style={[s.button, busy !== null && s.disabled]}>
            <Text style={s.buttonText}>{busy === 'gmail' ? 'Waiting for Google…' : 'Add a Google account'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy !== null} onPress={() => void add('microsoft')} style={[s.button, busy !== null && s.disabled]}>
            <Text style={s.buttonText}>{busy === 'microsoft' ? 'Waiting for Microsoft…' : 'Add a Microsoft account'}</Text>
          </Pressable>
          {error !== null && <Text style={s.error}>{error}</Text>}
          <Pressable accessibilityRole="button" onPress={() => go({ name: 'diagnostics' })}>
            <Text style={s.link}>Diagnostics</Text>
          </Pressable>
        </ScrollView>
      )}
      {navCanForward(nav) && (
        <Pressable accessibilityRole="button" accessibilityLabel="Forward" onPress={forward} style={s.forward}>
          <Text style={s.forwardText}>Forward ›</Text>
        </Pressable>
      )}
    </View>
  )
}

function Inbox({ account, onBack, onOpen, onRemove }: { account: PhoneAccount; onBack: () => void; onOpen: (m: Summary) => void; onRemove: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)

  /** Shows the saved inbox at once, then (unless it was just updated, or `force`) brings it up to date from the server. Without a connection the saved copy stays. */
  const load = useCallback(
    async (force: boolean) => {
      setError(null)
      const saved = await savedInbox(account)
      setList(saved)
      const last = await lastSynced(account)
      setSyncedAt(last)
      if (!force && last !== null && Date.now() - last < FRESH_MS) return
      setRefreshing(true)
      try {
        const result = await refreshInbox(account)
        setList(await savedInbox(account))
        setSyncedAt(await lastSynced(account))
        void tell({ inbox: account.provider, ...result })
      } catch (e) {
        setError(saved.length > 0 ? `Could not update, showing saved mail. ${describeError(e)}` : describeError(e))
        void tell({ inboxFailed: account.provider, message: describeError(e) })
      } finally {
        setRefreshing(false)
      }
    },
    [account]
  )

  useEffect(() => void load(false), [load])

  return (
    <ScrollView contentContainerStyle={s.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor="#9aa4b2" colors={['#2b6cb0']} progressBackgroundColor="#1d2733" />}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={s.link}>Back</Text>
      </Pressable>
      <Text style={s.title}>{account.email}</Text>
      {list === null && <ActivityIndicator color="#9aa4b2" />}
      {!refreshing && syncedAt !== null && error === null && <Text style={s.note}>Updated {when(syncedAt)}. Pull down to refresh.</Text>}
      {error !== null && <Text style={s.error}>{error}</Text>}
      {list?.length === 0 && !refreshing && <Text style={s.note}>The inbox is empty.</Text>}
      {list?.map((m) => {
        const unread = !m.flags.includes('\\Seen')
        return (
          <Pressable key={m.uid} accessibilityRole="button" onPress={() => onOpen(m)} style={s.row}>
            <View style={s.rowHead}>
              <Text numberOfLines={1} style={[s.from, unread && s.unread]}>
                {m.from?.name || m.from?.address || '(unknown sender)'}
              </Text>
              <Text style={s.when}>{when(m.date)}</Text>
            </View>
            <Text numberOfLines={1} style={[s.subject, unread && s.unread]}>
              {m.subject || '(no subject)'}
            </Text>
          </Pressable>
        )
      })}
      <Pressable accessibilityRole="button" onPress={onRemove}>
        <Text style={[s.link, s.danger]}>Remove this account from the phone</Text>
      </Pressable>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101418' },
  body: { padding: 20, paddingTop: 56, gap: 12 },
  title: { color: '#f2f4f7', fontSize: 22, fontWeight: '600' },
  note: { color: '#9aa4b2' },
  card: { backgroundColor: '#1d2733', borderRadius: 8, padding: 14, gap: 2 },
  cardTitle: { color: '#f2f4f7', fontSize: 16 },
  cardSub: { color: '#9aa4b2', fontSize: 12 },
  button: { backgroundColor: '#2b6cb0', borderRadius: 8, padding: 14 },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#f2f4f7', fontSize: 16 },
  error: { color: '#f2a3a3' },
  link: { color: '#8ab4f8', paddingVertical: 6 },
  danger: { color: '#f2a3a3' },
  row: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2a3340', paddingVertical: 10, gap: 2 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  from: { color: '#c7d0dc', fontSize: 15, flex: 1 },
  subject: { color: '#9aa4b2', fontSize: 14 },
  unread: { color: '#f2f4f7', fontWeight: '600' },
  when: { color: '#7d8794', fontSize: 12 },
  forward: { position: 'absolute', right: 12, top: 44, backgroundColor: '#1d2733', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  forwardText: { color: '#8ab4f8', fontSize: 13 }
})

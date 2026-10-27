import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import type { Summary } from '@imc/mail'
import { loadAccounts, removeAccount, signIn, type PhoneAccount } from './src/auth'
import { lastSynced, refreshInbox, savedInbox } from './src/inbox'
import { forgetAccount } from './src/db'
import Diagnostics from './src/Diagnostics'
import MessageView from './src/MessageView'
import { tell } from './src/report'

type Screen = { name: 'home' } | { name: 'inbox'; account: PhoneAccount } | { name: 'diagnostics' }

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const when = (ms: number | null): string => {
  if (ms === null) return ''
  const d = new Date(ms)
  const now = new Date()
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [accounts, setAccounts] = useState<PhoneAccount[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => void loadAccounts().then(setAccounts), [])

  const add = async (provider: 'gmail' | 'microsoft') => {
    setBusy(provider)
    setError(null)
    try {
      const account = await signIn(provider)
      setAccounts(await loadAccounts())
      void tell({ signedIn: provider })
      setScreen({ name: 'inbox', account })
    } catch (e) {
      setError(describeError(e))
      void tell({ signInFailed: provider, message: describeError(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {screen.name === 'diagnostics' && <Diagnostics onBack={() => setScreen({ name: 'home' })} />}
      {screen.name === 'inbox' && (
        <Inbox
          account={screen.account}
          onBack={() => setScreen({ name: 'home' })}
          onRemove={async () => {
            await removeAccount(screen.account.email)
            await forgetAccount(screen.account.email)
            setAccounts(await loadAccounts())
            setScreen({ name: 'home' })
          }}
        />
      )}
      {screen.name === 'home' && (
        <ScrollView contentContainerStyle={s.body}>
          <Text style={s.title}>IMC-Mail</Text>
          <Text style={s.note}>Your mail on this phone. Sign-in goes through your provider; this app never sees your password.</Text>
          {accounts.map((a) => (
            <Pressable key={a.email} accessibilityRole="button" onPress={() => setScreen({ name: 'inbox', account: a })} style={s.card}>
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
          <Pressable accessibilityRole="button" onPress={() => setScreen({ name: 'diagnostics' })}>
            <Text style={s.link}>Diagnostics</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  )
}

function Inbox({ account, onBack, onRemove }: { account: PhoneAccount; onBack: () => void; onRemove: () => void }) {
  const [list, setList] = useState<Summary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Summary | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)

  /** Shows the saved inbox at once, then brings it up to date from the server. Without a connection the saved copy stays. */
  const load = useCallback(async () => {
    setError(null)
    const saved = await savedInbox(account)
    setList(saved)
    setSyncedAt(await lastSynced(account))
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
  }, [account])

  useEffect(() => void load(), [load])

  if (open) {
    return (
      <MessageView
        account={account}
        summary={open}
        onBack={() => {
          // Opening a message marked it read; the saved copy has it, so show the list from there.
          setOpen(null)
          void savedInbox(account).then(setList)
        }}
      />
    )
  }

  return (
    <ScrollView contentContainerStyle={s.body}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={s.link}>Back</Text>
      </Pressable>
      <Text style={s.title}>{account.email}</Text>
      {(list === null || refreshing) && <ActivityIndicator color="#9aa4b2" />}
      {!refreshing && syncedAt !== null && error === null && <Text style={s.note}>Updated {when(syncedAt)}</Text>}
      {error !== null && <Text style={s.error}>{error}</Text>}
      {list?.length === 0 && !refreshing && <Text style={s.note}>The inbox is empty.</Text>}
      {list?.map((m) => {
        const unread = !m.flags.includes('\\Seen')
        return (
          <Pressable key={m.uid} accessibilityRole="button" onPress={() => setOpen(m)} style={s.row}>
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
      <Pressable accessibilityRole="button" onPress={() => void load()}>
        <Text style={s.link}>Refresh</Text>
      </Pressable>
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
  when: { color: '#7d8794', fontSize: 12 }
})

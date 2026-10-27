import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import type { Summary } from '@imc/mail'
import { loadAccounts, removeAccount, signIn, type PhoneAccount } from './src/auth'
import { newestInbox } from './src/inbox'
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

  const load = useCallback(async () => {
    setList(null)
    setError(null)
    try {
      const got = await newestInbox(account)
      setList(got)
      void tell({ inbox: account.provider, count: got.length })
    } catch (e) {
      setError(describeError(e))
      void tell({ inboxFailed: account.provider, message: describeError(e) })
    }
  }, [account])

  useEffect(() => void load(), [load])

  if (open) {
    return (
      <MessageView
        account={account}
        summary={open}
        onBack={() => {
          // Opening a message marked it read, so show it that way in the list.
          setList((l) => l?.map((x) => (x.uid === open.uid && !x.flags.includes('\\Seen') ? { ...x, flags: [...x.flags, '\\Seen'] } : x)) ?? null)
          setOpen(null)
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
      {list === null && error === null && <ActivityIndicator color="#9aa4b2" />}
      {error !== null && <Text style={s.error}>{error}</Text>}
      {list?.length === 0 && <Text style={s.note}>The inbox is empty.</Text>}
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

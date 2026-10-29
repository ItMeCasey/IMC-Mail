import { useCallback, useEffect, useState } from 'react'
import { AppState, BackHandler, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Notifications from 'expo-notifications'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { parseMailto, type MailtoDraft, navBack, navCanBack, navCurrent, navFilter, navPush, navStart, type NavHistory } from '@imc/core'
import AddAccount from './src/AddAccount'
import Calendar from './src/Calendar'
import { loadAccounts, type PhoneAccount } from './src/auth'
import { scheduleBackgroundCheck } from './src/background'
import Compose from './src/Compose'
import Deals from './src/Deals'
import Devices from './src/Devices'
import Diagnostics from './src/Diagnostics'
import MailList from './src/MailList'
import UnifiedList, { ALL_INBOXES } from './src/UnifiedList'
import MessageView from './src/MessageView'
import { INBOX } from './src/inbox-check'
import { flushOutbox, savedFolders, savedMessages, warmConnection } from './src/mail'
import { rescheduleReminders, setUpNotifications } from './src/notify'
import { resumeLive } from './src/live'
import { startSyncLoop, syncNow } from './src/phonesync'
import { applyPrivacy } from './src/privacy'
import type { Screen as ScreenName, Tab } from './src/screens'
import SettingsScreen from './src/SettingsScreen'
import { colors, isLight, Screen, TabBar } from './src/ui'

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  )
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'deals', label: 'Deals' },
  { id: 'settings', label: 'Settings' }
]

function Shell() {
  const [nav, setNav] = useState<NavHistory<ScreenName>>(() => navStart<ScreenName>({ name: 'tab', tab: 'mail' }))
  const [accounts, setAccounts] = useState<PhoneAccount[]>([])
  const [mailSel, setMailSel] = useState<{ account: string | null; folder: string | null }>({ account: null, folder: null })
  const screen = navCurrent(nav)
  const insets = useSafeAreaInsets()

  const go = useCallback((next: ScreenName) => setNav((h) => navPush(h, next)), [])
  const back = useCallback(() => setNav((h) => navBack(h)), [])
  const reload = useCallback(() => loadAccounts().then(setAccounts), [])

  useEffect(() => {
    void reload()
    applyPrivacy()
    void setUpNotifications().then(() => rescheduleReminders())
    void scheduleBackgroundCheck()
    void resumeLive()
    const stop = startSyncLoop()
    // Coming back to the app: sync, send anything waiting, and refresh reminders.
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return
      void syncNow()
      void loadAccounts().then(flushOutbox)
      void rescheduleReminders()
    })
    return () => {
      sub.remove()
      stop()
    }
  }, [reload])

  // The phone's back gesture (and back button) goes to the previous screen, and only leaves the app from the first one.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navCanBack(nav)) return false
      back()
      return true
    })
    return () => sub.remove()
  }, [nav, back])

  const tab = (t: Tab) => go({ name: 'tab', tab: t })

  // IMC-Mail is a mail app Android can pick for mail links: clicking one opens a new message with the fields filled in.
  const [incoming, setIncoming] = useState<MailtoDraft | null>(null)
  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const draft = url ? parseMailto(url) : null
      if (draft) setIncoming(draft)
    }
    void Linking.getInitialURL().then(open)
    const sub = Linking.addEventListener('url', (e) => open(e.url))
    return () => sub.remove()
  }, [])
  useEffect(() => {
    // Wait for the accounts to load; with none, there is nothing to send from.
    if (!incoming || accounts.length === 0) return
    const account = accounts.find((a) => a.email === mailSel.account) ?? accounts[0]!
    setIncoming(null)
    go({ name: 'compose', account, start: { to: incoming.to.join(', '), cc: incoming.cc.join(', '), bcc: incoming.bcc.join(', '), subject: incoming.subject, text: incoming.body, inReplyTo: null, references: [] } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, accounts])

  // Tapping a notification opens what it is about: the new message, or that account's inbox when there were several.
  const [tapped, setTapped] = useState<{ account: string; uid: number | null } | null>(null)
  const lastTap = Notifications.useLastNotificationResponse()
  useEffect(() => {
    if (!lastTap) return
    const d = lastTap.notification.request.content.data as { kind?: string; account?: string; uid?: number | null }
    if (d.kind === 'mail' && d.account) setTapped({ account: d.account, uid: d.uid ?? null })
    else if (d.kind === 'meeting' || d.kind === 'holiday') go({ name: 'tab', tab: 'calendar' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTap])
  useEffect(() => {
    if (!tapped || accounts.length === 0) return
    const account = accounts.find((a) => a.email === tapped.account)
    setTapped(null)
    if (!account) return
    void (async () => {
      const folder = savedFolders(account).find((f) => f.specialUse === 'inbox') ?? INBOX
      const summary = tapped.uid === null ? undefined : (await savedMessages(account, folder)).find((x) => x.uid === tapped.uid)
      if (summary) go({ name: 'message', account, folder, summary })
      else {
        setMailSel({ account: account.email, folder: null })
        go({ name: 'tab', tab: 'mail' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapped, accounts])

  const added = async (a: PhoneAccount) => {
    await reload()
    setMailSel({ account: a.email, folder: null })
    setNav((h) => navPush(navBack(h), { name: 'tab', tab: 'mail' }))
  }

  // After the last step of a flow (sending, adding), return to where it was started.
  const finish = useCallback(() => setNav((h) => navBack(h)), [])

  useEffect(() => {
    for (const a of accounts) warmConnection(a)
  }, [accounts])

  // Screens of an account that was removed must not be reachable by Back or Forward.
  useEffect(() => {
    setNav((h) => navFilter(h, (sc) => !('account' in sc) || accounts.length === 0 || accounts.some((a) => a.email === sc.account.email), { name: 'tab', tab: 'mail' }))
  }, [accounts])

  return (
    <View style={st.root}>
      <StatusBar style={isLight ? 'dark' : 'light'} />
      {screen.name === 'tab' && (
        <Screen footer={<TabBar tabs={TABS} current={screen.tab} onSelect={(id) => tab(id as Tab)} />}>
          {screen.tab === 'mail' && (mailSel.account === ALL_INBOXES || (mailSel.account === null && accounts.length > 1)) && (
            <UnifiedList
              accounts={accounts}
              onSelect={setMailSel}
              onOpen={(account, folder, summary) => go({ name: 'message', account, folder, summary })}
              onCompose={(account) => go({ name: 'compose', account })}
              onAddAccount={() => go({ name: 'addAccount' })}
            />
          )}
          {screen.tab === 'mail' && !(mailSel.account === ALL_INBOXES || (mailSel.account === null && accounts.length > 1)) && (
            <MailList
              accounts={accounts}
              selected={mailSel}
              onSelect={setMailSel}
              onOpen={(account, folder, summary) => go({ name: 'message', account, folder, summary })}
              onCompose={(account) => go({ name: 'compose', account })}
              onAddAccount={() => go({ name: 'addAccount' })}
            />
          )}
          {screen.tab === 'calendar' && <Calendar />}
          {screen.tab === 'deals' && <Deals />}
          {screen.tab === 'settings' && <SettingsScreen accounts={accounts} onAccountsChanged={() => void reload()} onAddAccount={() => go({ name: 'addAccount' })} onDevices={() => go({ name: 'devices' })} onDiagnostics={() => go({ name: 'diagnostics' })} />}
        </Screen>
      )}
      {screen.name === 'message' && <MessageView key={`${screen.account.email}:${screen.summary.uid}`} account={screen.account} folder={screen.folder} summary={screen.summary} onBack={back} onCompose={(start) => go({ name: 'compose', account: screen.account, start })} />}
      {screen.name === 'compose' && <Compose key={nav.index} account={screen.account} accounts={accounts} {...(screen.start ? { start: screen.start } : {})} onDone={finish} />}
      {screen.name === 'addAccount' && <AddAccount onAdded={(a) => void added(a)} onBack={back} />}
      {screen.name === 'devices' && <Devices onBack={back} />}
      {screen.name === 'diagnostics' && (
        <Screen>
          <Diagnostics onBack={back} />
        </Screen>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg }
})

import { useCallback, useEffect, useState } from 'react'
import { AppState, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import { navBack, navCanBack, navCanForward, navCurrent, navFilter, navForward, navPush, navStart, type NavHistory } from '@imc/core'
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
import { flushOutbox } from './src/mail'
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
  const forward = useCallback(() => setNav((h) => navForward(h)), [])
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

  const added = async (a: PhoneAccount) => {
    await reload()
    setMailSel({ account: a.email, folder: null })
    setNav((h) => navPush(navBack(h), { name: 'tab', tab: 'mail' }))
  }

  // After the last step of a flow (sending, adding), return to where it was started.
  const finish = useCallback(() => setNav((h) => navBack(h)), [])

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
      {screen.name === 'compose' && <Compose key={nav.index} account={screen.account} {...(screen.start ? { start: screen.start } : {})} onDone={finish} />}
      {screen.name === 'addAccount' && <AddAccount onAdded={(a) => void added(a)} onBack={back} />}
      {screen.name === 'devices' && <Devices onBack={back} />}
      {screen.name === 'diagnostics' && (
        <Screen>
          <Diagnostics onBack={back} />
        </Screen>
      )}
      {navCanForward(nav) && (
        <Pressable accessibilityRole="button" accessibilityLabel="Forward" onPress={forward} style={[st.forward, { bottom: insets.bottom + 76, left: Math.max(insets.left, 0) + 12 }]}>
          <Text style={st.forwardText}>Forward ›</Text>
        </Pressable>
      )}
    </View>
  )
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  forward: { position: 'absolute', backgroundColor: colors.raised, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, paddingHorizontal: 10, paddingVertical: 5 },
  forwardText: { color: colors.link, fontSize: 13 }
})

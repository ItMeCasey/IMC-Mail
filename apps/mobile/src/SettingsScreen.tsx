import { useEffect, useState } from 'react'
import { Alert, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { appPrefs, notificationPrefs, setAppPrefs } from '@imc/mail'
import { holidayCountries } from '@imc/mail/holidays'
import { removeAccount, type PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { forgetAccount, items, queue, settings } from './db'
import { flushOutbox } from './mail'
import { rescheduleReminders, setUpNotifications } from './notify'
import { applyPrivacy } from './privacy'
import { sync, syncNow } from './phonesync'
import { Body, Card, colors, Link, Note, Title } from './ui'

const LEADS = [5, 10, 15, 30, 60]

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={st.toggle}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: colors.muted, fontSize: 12 }}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.line }} thumbColor={colors.text} accessibilityLabel={label} />
    </View>
  )
}

interface Props {
  accounts: PhoneAccount[]
  onAccountsChanged: () => void
  onAddAccount: () => void
  onDevices: () => void
  onDiagnostics: () => void
}

/** Settings: accounts, privacy, notifications and the choices that sync with your other devices. */
export default function SettingsScreen({ accounts, onAccountsChanged, onAddAccount, onDevices, onDiagnostics }: Props) {
  const changed = useChanged()
  const [local, setLocal] = useState(settings.get())
  const [outbox, setOutbox] = useState(queue.list().length)
  const [note, setNote] = useState<string | null>(null)
  const [country, setCountry] = useState('')
  void changed
  const prefs = appPrefs(items)
  const notify = notificationPrefs(items)
  const status = sync.status()

  useEffect(() => setCountry(prefs.holidayCountry), [prefs.holidayCountry])

  const change = (patch: Partial<typeof local>) => {
    settings.set(patch)
    setLocal(settings.get())
    applyPrivacy()
  }
  const pref = (patch: Parameters<typeof setAppPrefs>[1]) => {
    setAppPrefs(items, patch)
    notifyChanged()
    void rescheduleReminders()
    void syncNow()
  }
  const setNotify = (patch: Partial<typeof notify>) => {
    items.put('pref', 'notifications', { ...notify, ...patch })
    notifyChanged()
    void syncNow()
  }

  const remove = (a: PhoneAccount) =>
    Alert.alert(`Remove ${a.email}?`, 'Its saved mail is deleted from this phone. The mail stays on the server.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            await removeAccount(a.email)
            forgetAccount(a.email)
            onAccountsChanged()
          })()
      }
    ])

  const saveCountry = (text: string) => {
    const code = text.trim().toUpperCase()
    setCountry(code)
    if (holidayCountries().some((c) => c.code === code)) pref({ holidayCountry: code })
  }

  return (
    <Body>
      <Title>Settings</Title>

      <Text style={st.section}>Accounts</Text>
      {accounts.map((a) => (
        <Card key={a.email}>
          <Text style={{ color: colors.text }}>{a.email}</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>{a.provider === 'gmail' ? 'Google' : a.provider === 'microsoft' ? 'Microsoft' : (a.protocol ?? 'imap').toUpperCase()}</Text>
          <Link danger onPress={() => remove(a)}>
            Remove from this phone
          </Link>
        </Card>
      ))}
      <Link onPress={onAddAccount}>Add an account</Link>

      <Text style={st.section}>Syncing</Text>
      <Link onPress={onDevices}>{status.paired ? 'Devices (syncing)' : 'Devices — pair with the desktop app'}</Link>

      <Text style={st.section}>Privacy</Text>
      <Toggle label="Hide this app in recent apps" hint="Also blocks screenshots and screen recording" value={local.privacyScreen} onChange={(v) => change({ privacyScreen: v })} />
      <Toggle label="Hide message details in notifications" hint="Shows only “New message”" value={local.hideNotificationDetails} onChange={(v) => change({ hideNotificationDetails: v })} />

      <Text style={st.section}>Notifications</Text>
      <Toggle label="Notifications" value={notify.enabled} onChange={(v) => setNotify({ enabled: v })} />
      <Toggle label="Check for new mail in the background" hint="About every 15 minutes or more, when Android allows" value={local.checkMailInBackground} onChange={(v) => change({ checkMailInBackground: v })} />
      <Toggle label="Quiet hours" hint={`${notify.quietHours.start} to ${notify.quietHours.end}`} value={notify.quietHours.enabled} onChange={(v) => setNotify({ quietHours: { ...notify.quietHours, enabled: v } })} />
      <Toggle label="Meeting reminders" value={prefs.meetingReminders} onChange={(v) => pref({ meetingReminders: v })} />
      <View style={st.leads}>
        <Text style={{ color: colors.muted }}>Remind me</Text>
        {LEADS.map((m) => (
          <Link key={m} onPress={() => pref({ reminderLeadMinutes: m })}>
            {prefs.reminderLeadMinutes === m ? `● ${m}` : `${m}`}
          </Link>
        ))}
        <Text style={{ color: colors.muted }}>min before</Text>
      </View>
      <Link
        onPress={() =>
          void setUpNotifications().then((ok) => {
            setNote(ok ? 'Notifications are allowed.' : 'Notifications are blocked. Turn them on in Android settings for IMC-Mail.')
            void rescheduleReminders()
          })
        }
      >
        Allow notifications
      </Link>

      <Text style={st.section}>Calendar</Text>
      <Toggle label="Show holidays" value={prefs.showHolidays} onChange={(v) => pref({ showHolidays: v })} />
      <Toggle label="Holiday reminders" value={prefs.holidayReminders} onChange={(v) => pref({ holidayReminders: v })} />
      <View style={st.leads}>
        <Text style={{ color: colors.muted }}>Country code</Text>
        <TextInput value={country} onChangeText={saveCountry} maxLength={2} autoCapitalize="characters" autoCorrect={false} style={st.country} />
      </View>

      <Text style={st.section}>Outbox</Text>
      <Note>{outbox === 0 ? 'Nothing waiting to send.' : `${outbox} message${outbox === 1 ? '' : 's'} waiting for a connection.`}</Note>
      {outbox > 0 && (
        <Link
          onPress={() =>
            void flushOutbox(accounts).then((n) => {
              setOutbox(queue.list().length)
              setNote(n > 0 ? `Sent ${n}.` : 'Could not send yet.')
            })
          }
        >
          Send now
        </Link>
      )}

      {note !== null && <Note>{note}</Note>}
      <Link onPress={onDiagnostics}>Diagnostics</Link>
    </Body>
  )
}

const st = StyleSheet.create({
  section: { color: colors.soft, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', marginTop: 10 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  leads: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  country: { color: colors.text, backgroundColor: colors.raised, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, width: 60, textAlign: 'center' }
})

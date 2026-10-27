import { useEffect, useState } from 'react'
import { Alert, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { appPrefs, notificationPrefs, setAppPrefs } from '@imc/mail'
import { holidayCountries } from '@imc/mail/holidays'
import { removeAccount, type PhoneAccount } from './auth'
import { notifyChanged, useChanged } from './changes'
import { AppBar, Avatar, Group, SettingRow } from './chrome'
import { forgetAccount, items, queue, settings } from './db'
import { flushOutbox } from './mail'
import { rescheduleReminders, setUpNotifications } from './notify'
import { applyPrivacy } from './privacy'
import { sync, syncNow } from './phonesync'
import { Body, colors, Note, radius } from './ui'

const LEADS = [5, 10, 15, 30, 60]

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.accent, false: colors.line }} thumbColor={value ? colors.text : colors.faint} accessibilityLabel={label} />
}

interface Props {
  accounts: PhoneAccount[]
  onAccountsChanged: () => void
  onAddAccount: () => void
  onDevices: () => void
  onDiagnostics: () => void
}

/** Settings: accounts, syncing, privacy, notifications and the choices that sync with your other devices. */
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
    notifyChanged()
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
    <View style={{ flex: 1 }}>
      <AppBar title="Settings" />
      <Body gap={0}>
        <Group title="Accounts">
          {accounts.map((a) => (
            <SettingRow
              key={a.email}
              label={a.name || a.email}
              hint={`${a.email} · ${a.provider === 'gmail' ? 'Google' : a.provider === 'microsoft' ? 'Microsoft' : (a.protocol ?? 'imap').toUpperCase()}`}
              onPress={() => remove(a)}
              right={<Avatar name={a.name || a.email} size={32} />}
            />
          ))}
          <SettingRow label="Add an account" onPress={onAddAccount} />
        </Group>
        <Note style={st.tip}>Tap an account to remove it from this phone.</Note>

        <Group title="Syncing">
          <SettingRow label="Devices" hint={status.paired ? `Syncing as ${status.deviceName}` : 'Pair with the desktop app'} onPress={onDevices} />
        </Group>

        <Group title="Appearance">
          <SettingRow label="Show company logos" hint="Gets each sender's icon from Google's favicon service, which sees the sender's domain" right={<Toggle label="Show company logos" value={local.showLogos} onChange={(v) => change({ showLogos: v })} />} />
        </Group>

        <Group title="Privacy">
          <SettingRow label="Hide in recent apps" hint="Also blocks screenshots and screen recording" right={<Toggle label="Hide in recent apps" value={local.privacyScreen} onChange={(v) => change({ privacyScreen: v })} />} />
          <SettingRow label="Hide message details in notifications" hint="Shows only “New message”" right={<Toggle label="Hide details" value={local.hideNotificationDetails} onChange={(v) => change({ hideNotificationDetails: v })} />} />
        </Group>

        <Group title="Notifications">
          <SettingRow label="Notifications" right={<Toggle label="Notifications" value={notify.enabled} onChange={(v) => setNotify({ enabled: v })} />} />
          <SettingRow label="Check mail in the background" hint="About every 15 minutes, when Android allows" right={<Toggle label="Background check" value={local.checkMailInBackground} onChange={(v) => change({ checkMailInBackground: v })} />} />
          <SettingRow label="Quiet hours" hint={`${notify.quietHours.start} to ${notify.quietHours.end}`} right={<Toggle label="Quiet hours" value={notify.quietHours.enabled} onChange={(v) => setNotify({ quietHours: { ...notify.quietHours, enabled: v } })} />} />
          <SettingRow label="Meeting reminders" right={<Toggle label="Meeting reminders" value={prefs.meetingReminders} onChange={(v) => pref({ meetingReminders: v })} />} />
          <SettingRow
            label="Remind me before"
            right={
              <View style={st.leads}>
                {LEADS.map((m) => (
                  <Text key={m} accessibilityRole="button" onPress={() => pref({ reminderLeadMinutes: m })} style={[st.lead, prefs.reminderLeadMinutes === m && st.leadOn]}>
                    {m}
                  </Text>
                ))}
              </View>
            }
          />
          <SettingRow
            label="Allow notifications"
            hint="Ask Android for permission"
            onPress={() =>
              void setUpNotifications().then((ok) => {
                setNote(ok ? 'Notifications are allowed.' : 'Notifications are blocked. Turn them on in Android settings for IMC-Mail.')
                void rescheduleReminders()
              })
            }
          />
        </Group>

        <Group title="Calendar">
          <SettingRow label="Show holidays" right={<Toggle label="Show holidays" value={prefs.showHolidays} onChange={(v) => pref({ showHolidays: v })} />} />
          <SettingRow label="Holiday reminders" right={<Toggle label="Holiday reminders" value={prefs.holidayReminders} onChange={(v) => pref({ holidayReminders: v })} />} />
          <SettingRow label="Country code" right={<TextInput value={country} onChangeText={saveCountry} maxLength={2} autoCapitalize="characters" autoCorrect={false} style={st.country} />} />
        </Group>

        <Group title="Outbox">
          <SettingRow
            label={outbox === 0 ? 'Nothing waiting to send' : `${outbox} message${outbox === 1 ? '' : 's'} waiting`}
            hint={outbox === 0 ? undefined : 'Tap to try sending now'}
            onPress={
              outbox === 0
                ? undefined
                : () =>
                    void flushOutbox(accounts).then((n) => {
                      setOutbox(queue.list().length)
                      setNote(n > 0 ? `Sent ${n}.` : 'Could not send yet.')
                    })
            }
          />
        </Group>

        <Group title="About">
          <SettingRow label="Diagnostics" onPress={onDiagnostics} />
        </Group>
        {note !== null && <Note style={st.tip}>{note}</Note>}
        <View style={{ height: 24 }} />
      </Body>
    </View>
  )
}

const st = StyleSheet.create({
  tip: { fontSize: 12, paddingTop: 8 },
  leads: { flexDirection: 'row', gap: 4 },
  lead: { color: colors.muted, fontSize: 14, paddingHorizontal: 9, paddingVertical: 6, borderRadius: radius, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  leadOn: { color: colors.onAccent, backgroundColor: colors.accent, borderColor: colors.accent, fontWeight: '600' },
  country: { color: colors.text, backgroundColor: colors.bg, borderRadius: radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 6, width: 64, textAlign: 'center' }
})

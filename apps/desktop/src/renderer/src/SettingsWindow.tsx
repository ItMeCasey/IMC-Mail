import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Bug, CalendarDays, Download, HardDrive, ListFilter, Mail, Minus, Palette, Plus, ShieldCheck, SlidersHorizontal, Smartphone, Trash2, Upload, Users, X, type LucideIcon } from 'lucide-react'
import type { Account } from '@imc/core'
import StreamSafeControl from './StreamSafeControl'
import ThemeSwitch from './ThemeSwitch'
import { useStreamSafe } from './streamsafe'
import { ResizeGrips } from './WindowFrame'

const ctl = 'grid h-10 w-11 place-items-center text-ink-2 transition-colors duration-(--dur-fast) hover:bg-hover hover:text-ink focus-visible:-outline-offset-2'
const row =
  'flex h-9 w-full items-center gap-2 rounded-md border border-line-strong px-3 text-left text-ink transition-colors duration-(--dur-fast) hover:bg-hover'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium text-ink-2">{title}</h3>
      {children}
    </section>
  )
}

/** One account: rename it, or remove it. Names are saved when you leave the field. */
function AccountRow({
  account,
  onRename,
  onRemove
}: {
  account: Account
  onRename: (id: string, name: string) => void
  onRemove: (account: Account) => void
}) {
  const [name, setName] = useState(account.displayName)
  useEffect(() => setName(account.displayName), [account.displayName])
  const commit = () => {
    if (name.trim() !== account.displayName) onRename(account.id, name.trim())
  }
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <input
          aria-label={`Name for ${account.email}`}
          value={name}
          maxLength={80}
          placeholder={account.email}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="h-8 w-full rounded-md border border-line-strong bg-sheet px-2 text-ink"
        />
        <span className="block truncate px-0.5 text-xs text-ink-3">{account.email}</span>
      </span>
      <button
        className="grid size-8 shrink-0 place-items-center self-start rounded-md text-ink-2 hover:bg-hover hover:text-alert"
        aria-label={`Remove ${account.email}`}
        title="Remove account"
        onClick={() => onRemove(account)}
      >
        <Trash2 size={15} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  )
}

const when = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Google and Microsoft accounts can show their own calendar here; this allows it and reads it again on request. */
function CalendarSources({ hide }: { hide: boolean }) {
  const qc = useQueryClient()
  const sources = useQuery({ queryKey: ['calendar', 'sources'], queryFn: () => window.imc.invoke('calendar:sources') })
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ id: string; text: string } | null>(null)
  const list = sources.data ?? []
  if (list.length === 0) return null

  const run = async (id: string, job: () => Promise<string | null>) => {
    setBusy(id)
    setNote(null)
    try {
      const text = await job()
      if (text) setNote({ id, text })
    } catch (e) {
      setNote({ id, text: (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['calendar'] })
    }
  }
  const connect = (id: string) =>
    run(id, async () => {
      const r = await window.imc.invoke('calendar:connect', { accountId: id })
      return r.ok ? null : (r.message ?? 'The calendar could not be read.')
    })
  const syncNow = (id: string) => run(id, () => window.imc.invoke('calendar:syncNow', { accountId: id }).then(() => null))

  return (
    <Section title="Calendars">
      {hide ? (
        <p className="text-sm text-ink-3">Account names are hidden while stream-safe mode is on.</p>
      ) : (
        <ul className="space-y-3">
          {list.map((s) => (
            <li key={s.accountId} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{s.email}</span>
                  <span className={`block text-xs ${s.error ? 'text-alert' : 'text-ink-3'}`}>
                    {s.error ??
                      (s.connected
                        ? `Showing your ${s.provider === 'gmail' ? 'Google' : 'Microsoft'} calendar${s.syncedAt ? `, updated ${when.format(s.syncedAt)}` : ''}`
                        : 'Not showing its calendar yet')}
                  </span>
                </span>
                <button
                  className="h-8 shrink-0 rounded-md border border-line-strong px-3 text-sm text-ink hover:bg-hover disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void (s.connected && !s.error ? syncNow(s.accountId) : connect(s.accountId))}
                >
                  {busy === s.accountId ? 'Working…' : s.connected && !s.error ? 'Update now' : 'Allow calendar'}
                </button>
              </div>
              {note?.id === s.accountId && <p role="alert" className="text-xs text-alert">{note.text}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-3">
        Opens your browser to let IMC-Mail read your calendar. It can only read, never change it. Meetings show in the calendar next to the ones from email.
      </p>
    </Section>
  )
}

type TabId = 'general' | 'appearance' | 'streamsafe' | 'mail' | 'calendar' | 'accounts' | 'devices' | 'data'

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'streamsafe', label: 'Stream-safe', icon: ShieldCheck },
  { id: 'mail', label: 'Mail', icon: Mail },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'devices', label: 'Devices', icon: Smartphone },
  { id: 'data', label: 'Updates and backup', icon: HardDrive }
]

/** Public holidays in the calendar: on or off, and whose. */
/** Whether to show each sender's company logo in the message list. */
function Appearance() {
  const qc = useQueryClient()
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => window.imc.invoke('app:prefs') })
  const on = prefs.data?.showLogos ?? false
  return (
    <Section title="Message list">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          onChange={(e) => void window.imc.invoke('app:setPrefs', { showLogos: e.target.checked }).then(() => qc.invalidateQueries({ queryKey: ['prefs'] }))}
        />
        <span>
          Show company logos
          <span className="block text-xs text-ink-3">Shows the sender's logo beside each message. The logos come from Google's favicon service, which sees the sender's domain. They are kept on this computer.</span>
        </span>
      </label>
    </Section>
  )
}

function Holidays() {
  const qc = useQueryClient()
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => window.imc.invoke('app:prefs') })
  const countries = useQuery({
    queryKey: ['calendar', 'holidayCountries'],
    queryFn: () => window.imc.invoke('calendar:holidayCountries'),
    staleTime: Infinity
  })
  const on = prefs.data?.showHolidays ?? false
  const save = (p: { showHolidays?: boolean; holidayCountry?: string }) =>
    void window.imc.invoke('app:setPrefs', p).then(() => Promise.all([qc.invalidateQueries({ queryKey: ['prefs'] }), qc.invalidateQueries({ queryKey: ['calendar'] })]))

  return (
    <Section title="Holidays">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={on} onChange={(e) => save({ showHolidays: e.target.checked })} />
        <span>
          Show holidays
          <span className="block text-xs text-ink-3">Marks public holidays on the days they fall in the agenda and the month view.</span>
        </span>
      </label>
      <label className="block text-sm text-ink-2">
        Country
        <select
          disabled={!on}
          value={prefs.data?.holidayCountry ?? 'US'}
          onChange={(e) => save({ holidayCountry: e.target.value })}
          className="mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink disabled:opacity-50"
        >
          {(countries.data ?? [{ code: prefs.data?.holidayCountry ?? 'US', name: prefs.data?.holidayCountry ?? 'US' }]).map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </Section>
  )
}

const LEADS = [5, 10, 15, 30, 60]

/** Windows notifications before meetings and on holidays. They follow the quiet hours and stream-safe choices in Notifications. */
function Reminders() {
  const qc = useQueryClient()
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => window.imc.invoke('app:prefs') })
  const p = prefs.data
  const save = (patch: { meetingReminders?: boolean; reminderLeadMinutes?: number; holidayReminders?: boolean }) =>
    void window.imc.invoke('app:setPrefs', patch).then(() => qc.invalidateQueries({ queryKey: ['prefs'] }))
  const lead = p?.reminderLeadMinutes ?? 10
  const leads = LEADS.includes(lead) ? LEADS : [...LEADS, lead].sort((a, b) => a - b)

  return (
    <Section title="Reminders">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={p?.meetingReminders ?? true} onChange={(e) => save({ meetingReminders: e.target.checked })} />
        <span>
          Remind me before meetings
          <span className="block text-xs text-ink-3">A Windows notification, even while IMC-Mail is in the tray. Click it to open the calendar.</span>
        </span>
      </label>
      <label className="block text-sm text-ink-2">
        How long before
        <select
          disabled={!(p?.meetingReminders ?? true)}
          value={lead}
          onChange={(e) => save({ reminderLeadMinutes: Number(e.target.value) })}
          className="mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink disabled:opacity-50"
        >
          {leads.map((m) => (
            <option key={m} value={m}>
              {m === 60 ? '1 hour' : `${m} minutes`}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={p?.holidayReminders ?? false} onChange={(e) => save({ holidayReminders: e.target.checked })} />
        <span>
          Remind me on holidays
          <span className="block text-xs text-ink-3">One notification on the day, for the country chosen above.</span>
        </span>
      </label>
      <p className="text-xs text-ink-3">Reminders stay quiet during quiet hours, and follow the stream-safe choice, set under Mail &gt; Notifications.</p>
    </Section>
  )
}

const syncTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Keeping settings the same on this computer and your phone: turn it on, pair a device with a QR code, see and remove devices. */
function Devices({ hidden }: { hidden: boolean }) {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['sync', 'status'], queryFn: () => window.imc.invoke('sync:status'), refetchInterval: 4000 })
  const s = status.data
  const active = !!s?.paired && !s.revoked
  const devices = useQuery({ queryKey: ['sync', 'devices'], queryFn: () => window.imc.invoke('sync:devices'), enabled: active, retry: false })
  const [pairing, setPairing] = useState<{ code: string; qr: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [confirmOff, setConfirmOff] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false)
  const others = (devices.data ?? []).filter((d) => !d.current)
  const [copied, setCopied] = useState(false)

  // The code holds the key: never keep it on screen while stream-safe mode is on.
  useEffect(() => {
    if (hidden) setPairing(null)
  }, [hidden])

  const run = async (name: string, job: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    try {
      await job()
    } catch (e) {
      setError(errMessage(e))
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['sync'] })
    }
  }

  const copy = async () => {
    if (!pairing) return
    try {
      await navigator.clipboard.writeText(pairing.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy. Select the code and copy it by hand.')
    }
  }

  return (
    <>
      <Section title="Sync with your other devices">
        <p className="text-sm text-ink-2">
          Keeps your labels, rules, saved searches, reply templates, sponsorship deals, snoozes, follow-up reminders, meetings and these settings the same on this computer and your phone. Your mail is never copied: each device reads it
          from your mail provider itself. Settings are encrypted here before they leave, so the sync server cannot read them.
        </p>

        {!s?.paired && (
          <>
            <button className={row} disabled={busy !== null || hidden} onClick={() => void run('enable', async () => setPairing(await window.imc.invoke('sync:enable', {})))}>
              <Smartphone size={16} strokeWidth={1.75} aria-hidden />
              {busy === 'enable' ? 'Turning on…' : 'Turn on sync and add a phone'}
            </button>
            {hidden && <p className="text-xs text-ink-3">Hidden while stream-safe mode is on, because the pairing code holds your key.</p>}
            <div className="space-y-1.5 pt-2">
              <label className="block text-sm text-ink-2" htmlFor="join-code">
                Already syncing on another device? Paste its pairing code
              </label>
              <div className="flex gap-2">
                <input
                  id="join-code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="imcsync1:…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-sheet px-2.5 text-ink"
                />
                <button
                  className="h-9 shrink-0 rounded-md border border-line-strong px-4 text-ink hover:bg-hover disabled:opacity-50"
                  disabled={busy !== null || !joinCode.trim()}
                  onClick={() =>
                    void run('join', async () => {
                      const r = await window.imc.invoke('sync:join', { code: joinCode })
                      if (r.paired) setJoinCode('')
                    })
                  }
                >
                  {busy === 'join' ? 'Joining…' : 'Join'}
                </button>
              </div>
            </div>
          </>
        )}

        {s?.paired && (
          <div className="space-y-1 text-sm">
            <p className="text-ink">
              This computer: <span className="font-medium">{s.deviceName}</span>
            </p>
            <p role="status" className={s.error || s.revoked ? 'text-alert' : 'text-ink-3'}>
              {s.revoked
                ? 'Sync was reset or another device removed this one. Turn sync off here, then join with the new code from the device that reset it.'
                : (s.error ?? (s.syncing ? 'Syncing…' : s.lastSyncAt ? `Last synced ${syncTime.format(s.lastSyncAt)}` : 'Waiting for the first sync'))}
            </p>
            {!s.revoked && (
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  className="h-8 rounded-md border border-line-strong px-3 text-ink hover:bg-hover disabled:opacity-50"
                  disabled={busy !== null || s.syncing}
                  onClick={() => void run('now', async () => void (await window.imc.invoke('sync:now')))}
                >
                  {busy === 'now' ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  className="h-8 rounded-md border border-line-strong px-3 text-ink hover:bg-hover disabled:opacity-50"
                  disabled={busy !== null || hidden}
                  onClick={() => void run('pair', async () => setPairing(await window.imc.invoke('sync:pairing')))}
                >
                  Add a device
                </button>
              </div>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        {pairing && !hidden && (
          <div className="space-y-3 rounded-md border border-line-strong p-4">
            <p className="text-sm text-ink">On your phone, open IMC-Mail, then Settings, Devices, and scan this code.</p>
            <img src={pairing.qr} alt="QR code that pairs a device" width={220} height={220} className="mx-auto rounded-md bg-white" />
            <label className="block text-xs text-ink-3">
              Or type this code on the other device
              <textarea readOnly value={pairing.code} rows={3} className="mt-1 block w-full resize-none rounded-md border border-line-strong bg-sheet p-2 font-mono text-xs break-all text-ink" onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="flex items-center gap-2">
              <button className="h-8 rounded-md border border-line-strong px-3 text-ink hover:bg-hover" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy code'}
              </button>
              <button className="h-8 rounded-md px-3 text-ink-2 hover:bg-hover" onClick={() => setPairing(null)}>
                Hide
              </button>
            </div>
            <p className="text-xs text-ink-3">Anyone with this code can read and change your synced settings. It is not stored on the server. Hide it when you are done.</p>
          </div>
        )}
      </Section>

      {s?.paired && !s.revoked && (
        <Section title="Devices">
          {devices.isPending && <p className="text-sm text-ink-3">Loading…</p>}
          {devices.isError && <p className="text-sm text-ink-3">The list could not be loaded. {errMessage(devices.error)}</p>}
          <ul className="space-y-2">
            {(devices.data ?? []).map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {d.name || 'Unnamed device'}
                    {d.current && <span className="ml-2 rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2">This computer</span>}
                  </span>
                  <span className="block text-xs text-ink-3">Last seen {syncTime.format(d.lastSeen)}</span>
                </span>
                {!d.current && (
                  <button
                    className="grid size-8 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-alert disabled:opacity-50"
                    aria-label={`Remove ${d.name || 'this device'}`}
                    title="Remove this device from sync"
                    disabled={busy !== null}
                    onClick={() => void run('remove', () => window.imc.invoke('sync:removeDevice', { id: d.id }))}
                  >
                    <Trash2 size={15} strokeWidth={1.75} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">A removed device stops syncing at once, but it keeps the settings it already has and still holds the old key. To cut it off for good, replace the key.</p>
          {confirmRotate ? (
            <div className="space-y-2">
              <p className="text-sm text-ink-3">This ends the sync group on the server and starts a new one with a new key. Your other devices stop syncing until you add them again with the new code. Nothing is lost: every device keeps its settings.</p>
              <div className="flex gap-2">
                <button
                  className="h-9 rounded-md border border-alert px-4 text-alert hover:bg-hover disabled:opacity-50"
                  disabled={busy !== null || hidden}
                  onClick={() =>
                    void run('rotate', async () => {
                      setPairing(await window.imc.invoke('sync:rotate'))
                      setConfirmRotate(false)
                    })
                  }
                >
                  {busy === 'rotate' ? 'Replacing…' : 'Yes, replace the key'}
                </button>
                <button className="h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover" onClick={() => setConfirmRotate(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className={row} disabled={busy !== null} onClick={() => setConfirmRotate(true)}>
              Replace the key…
            </button>
          )}
        </Section>
      )}

      {s?.paired && !s.revoked && (
        <Section title="Remove all devices">
          <p className="text-sm text-ink-3">
            Removes every other device from sync at once ({others.length === 0 ? 'there are none right now' : others.length === 1 ? '1 device' : `${others.length} devices`}). This computer stays. A removed device stops syncing, but it keeps the settings it already has and still holds the old key, so to cut it off for good, replace the key as well.
          </p>
          {confirmRemoveAll ? (
            <div className="flex gap-2">
              <button
                className="h-9 rounded-md border border-alert px-4 text-alert hover:bg-hover disabled:opacity-50"
                disabled={busy !== null || others.length === 0}
                onClick={() =>
                  void run('removeAll', async () => {
                    for (const d of others) await window.imc.invoke('sync:removeDevice', { id: d.id })
                    setConfirmRemoveAll(false)
                  })
                }
              >
                {busy === 'removeAll' ? 'Removing…' : others.length === 1 ? 'Yes, remove the device' : `Yes, remove all ${others.length} devices`}
              </button>
              <button className="h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover" onClick={() => setConfirmRemoveAll(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className={row} disabled={busy !== null || others.length === 0} onClick={() => setConfirmRemoveAll(true)}>
              Remove all other devices…
            </button>
          )}
        </Section>
      )}

      {s?.paired && (
        <Section title="Turn off">
          <p className="text-sm text-ink-3">Stops syncing on this computer and forgets its keys. The settings already here stay, and your other devices keep syncing with each other.</p>
          {confirmOff ? (
            <div className="flex gap-2">
              <button
                className="h-9 rounded-md border border-alert px-4 text-alert hover:bg-hover disabled:opacity-50"
                disabled={busy !== null}
                onClick={() =>
                  void run('off', async () => {
                    await window.imc.invoke('sync:disable')
                    setPairing(null)
                    setConfirmOff(false)
                  })
                }
              >
                Yes, turn sync off
              </button>
              <button className="h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover" onClick={() => setConfirmOff(false)}>
                Keep syncing
              </button>
            </div>
          ) : (
            <button className={row} onClick={() => setConfirmOff(true)}>
              Turn off sync on this computer
            </button>
          )}
        </Section>
      )}
    </>
  )
}

/** Everything that is a setting rather than mail, in one window of its own. */
export default function SettingsWindow() {
  const streamSafe = useStreamSafe()
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => window.imc.invoke('accounts:list') }).data ?? []
  const qc = useQueryClient()
  const [backupNote, setBackupNote] = useState<string | null>(null)
  const info = useQuery({ queryKey: ['appinfo'], queryFn: () => window.imc.invoke('app:info') })
  const update = useQuery({ queryKey: ['update'], queryFn: () => window.imc.invoke('update:status') })
  useEffect(() => window.imc.on('update:changed', (st) => qc.setQueryData(['update'], st)), [qc])
  const u = update.data
  const updateText =
    !u || u.state === 'idle'
      ? 'Checked automatically while the app runs.'
      : u.state === 'unsupported'
        ? u.message
        : u.state === 'checking'
          ? 'Checking…'
          : u.state === 'none'
            ? 'You have the latest version.'
            : u.state === 'available'
              ? `Version ${u.version} is downloading.`
              : u.state === 'downloaded'
                ? `Version ${u.version} is ready. It also installs when you quit.`
                : `Could not check: ${u.message}`
  /** Runs an export or import and shows what happened, or why it could not. */
  const run = async (fn: () => Promise<string | null>) => {
    setBackupNote(null)
    try {
      setBackupNote(await fn())
      void qc.invalidateQueries()
    } catch (e) {
      setBackupNote((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  const prefs = useQuery({ queryKey: ['prefs'], queryFn: () => window.imc.invoke('app:prefs') })
  const streamer = prefs.data?.streamerFeatures ?? true
  const qcAll = qc
  // The other window changes things too (an account removed, a rule added): look again when this one is used.
  useEffect(() => {
    const again = () => void qcAll.invalidateQueries()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [qcAll])
  useEffect(() => window.imc.on('sync:applied', () => void qc.invalidateQueries()), [qc])
  const control = (action: 'minimize' | 'close') => void window.imc.invoke('settings:control', { action })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') control('close')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  /** These dialogs live in the main window: ask it to open one. */
  const ask = (kind: 'rules' | 'notifications' | 'report' | 'addAccount') => () => void window.imc.invoke('settings:action', { kind })
  const onRename = (id: string, displayName: string) =>
    void window.imc.invoke('accounts:rename', { id, displayName }).then(() => qc.invalidateQueries({ queryKey: ['accounts'] }))
  const onRemove = (a: Account) => void window.imc.invoke('settings:action', { kind: 'removeAccount', accountId: a.id })

  const [tab, setTab] = useState<TabId>('general')
  const tabs = TABS.filter((t) => t.id !== 'streamsafe' || streamer)
  const current = tabs.some((t) => t.id === tab) ? tab : 'general'
  /** Up and Down move through the rail, as a vertical tab list does. */
  const railKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = tabs.findIndex((t) => t.id === current)
    const next = tabs[(i + (e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length]!
    setTab(next.id)
    document.getElementById(`settings-tab-${next.id}`)?.focus()
  }

  return (
    <div role="dialog" aria-labelledby="settings-title" className="relative flex h-full flex-col overflow-hidden rounded-(--win-radius) bg-raised text-ink">
      <header className="flex h-10 shrink-0 items-center border-b border-line bg-rail" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <h2 id="settings-title" className="flex-1 px-4 text-sm font-medium text-ink-2 select-none">
          Settings
        </h2>
        <div className="flex" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button className={ctl} aria-label="Minimize" title="Minimize" onClick={() => control('minimize')}>
            <Minus size={14} strokeWidth={1.75} aria-hidden />
          </button>
          <button className={`${ctl} hover:text-alert`} aria-label="Close settings" title="Close" onClick={() => control('close')}>
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings categories" className="w-48 shrink-0 overflow-y-auto border-r border-line bg-rail p-2">
          <div role="tablist" aria-orientation="vertical" className="space-y-0.5" onKeyDown={railKey}>
            {tabs.map((t) => (
              <button
                key={t.id}
                id={`settings-tab-${t.id}`}
                role="tab"
                aria-selected={current === t.id}
                aria-controls="settings-panel"
                tabIndex={current === t.id ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors duration-(--dur-fast) ${
                  current === t.id ? 'bg-selected font-medium text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
                }`}
              >
                <t.icon size={16} strokeWidth={1.75} aria-hidden />
                {t.label}
              </button>
            ))}
          </div>
        </nav>

        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${current}`} className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6">
          {current === 'general' && (
            <>
              <Section title="Streamer features">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={streamer}
                    onChange={(e) =>
                      void window.imc.invoke('app:setPrefs', { streamerFeatures: e.target.checked }).then(() => {
                        void qc.invalidateQueries({ queryKey: ['prefs'] })
                        void qc.invalidateQueries({ queryKey: ['streamsafe'] })
                      })
                    }
                  />
                  <span>
                    Show tools for streamers and creators
                    <span className="block text-xs text-ink-3">
                      Stream-safe mode, the sponsorship board, mail categories and the media kit. Turn this off to use IMC-Mail as an ordinary mail client.
                    </span>
                  </span>
                </label>
              </Section>

              <Section title="Window">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={prefs.data?.closeToTray ?? false}
                    onChange={(e) =>
                      void window.imc.invoke('app:setPrefs', { closeToTray: e.target.checked }).then(() => qc.invalidateQueries({ queryKey: ['prefs'] }))
                    }
                  />
                  <span>
                    Keep running in the system tray when I close the window
                    <span className="block text-xs text-ink-3">Mail keeps syncing and notifications keep coming. Quit from the tray icon.</span>
                  </span>
                </label>
              </Section>
            </>
          )}

          {current === 'appearance' && (
            <Section title="Theme">
              <ThemeSwitch />
            </Section>
          )}

          {current === 'streamsafe' && (
            <Section title="Stream-safe mode">
              <StreamSafeControl state={streamSafe} inline />
            </Section>
          )}

          {current === 'mail' && (
            <Section title="Mail">
              <button className={row} onClick={ask('notifications')}>
                <Bell size={16} strokeWidth={1.75} aria-hidden />
                Notifications
              </button>
              <button className={row} onClick={ask('rules')}>
                <ListFilter size={16} strokeWidth={1.75} aria-hidden />
                Rules
              </button>
            </Section>
          )}

          {current === 'calendar' && (
            <>
              <Appearance />
              <Holidays />
              <Reminders />
              <CalendarSources hide={streamSafe.active} />
            </>
          )}

          {current === 'accounts' && (
            <Section title="Manage accounts">
              {accounts.length === 0 && <p className="text-sm text-ink-3">No accounts yet.</p>}
              {streamSafe.active ? (
                accounts.length > 0 && <p className="text-sm text-ink-3">Account names and addresses are hidden while stream-safe mode is on.</p>
              ) : (
                <ul className="space-y-3">
                  {accounts.map((a) => (
                    <AccountRow key={a.id} account={a} onRename={onRename} onRemove={onRemove} />
                  ))}
                </ul>
              )}
              <p className="text-xs text-ink-3">The name shows in the sidebar and as the sender name on mail you send.</p>
              <button className={row} onClick={ask('addAccount')}>
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                Add account
              </button>
            </Section>
          )}

          {current === 'devices' && <Devices hidden={streamSafe.active} />}

          {current === 'data' && (
            <>
              <Section title="Updates">
                <p className="text-sm text-ink-2">
                  Version <span className="num">{info.data?.version ?? ''}</span>. {updateText}
                </p>
                <div className="flex gap-2">
                  {update.data?.state === 'downloaded' ? (
                    <button className={row} onClick={() => void window.imc.invoke('update:install')}>
                      Restart to update
                    </button>
                  ) : (
                    <button
                      className={row}
                      disabled={update.data?.state === 'unsupported' || update.data?.state === 'checking'}
                      onClick={() => void window.imc.invoke('update:check')}
                    >
                      Check for updates
                    </button>
                  )}
                </div>
              </Section>

              <Section title="Back up settings">
                <p className="text-sm text-ink-3">Labels, rules, saved searches, reply templates and notification choices. No accounts, passwords or mail.</p>
                <div className="flex gap-2">
                  <button className={row} onClick={() => void run(() => window.imc.invoke('settings:export').then((x) => (x.saved ? `Saved to ${x.saved}` : null)))}>
                    <Download size={16} strokeWidth={1.75} aria-hidden />
                    Export
                  </button>
                  <button
                    className={row}
                    onClick={() =>
                      void run(async () => {
                        const x = await window.imc.invoke('settings:import')
                        if (!x) return null
                        const a = x.added
                        const n = a.labels + a.rules + a.savedSearches + a.templates
                        return `Added ${a.labels} labels, ${a.rules} rules, ${a.savedSearches} saved searches, ${a.templates} templates${x.settingsApplied ? ', and applied the settings in the file' : ''}.${x.skipped > 0 ? ` ${x.skipped} you already had were left alone.` : ''}${n === 0 && !x.settingsApplied ? ' Nothing new in that file.' : ''}`
                      })
                    }
                  >
                    <Upload size={16} strokeWidth={1.75} aria-hidden />
                    Import
                  </button>
                </div>
                {backupNote && (
                  <p role="status" className="text-sm break-words text-ink-2">
                    {backupNote}
                  </p>
                )}
              </Section>

              <Section title="Help">
                <button className={row} onClick={ask('report')}>
                  <Bug size={16} strokeWidth={1.75} aria-hidden />
                  Report a problem
                </button>
              </Section>
            </>
          )}
        </div>
      </div>
      <ResizeGrips minW={640} minH={440} />
    </div>
  )
}

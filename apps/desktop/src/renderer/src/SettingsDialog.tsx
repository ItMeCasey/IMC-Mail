import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Bug, CalendarDays, Download, HardDrive, ListFilter, Mail, Palette, Plus, ShieldCheck, SlidersHorizontal, Trash2, Upload, Users, X, type LucideIcon } from 'lucide-react'
import type { Account, StreamSafeState } from '@imc/core'
import StreamSafeControl from './StreamSafeControl'
import ThemeSwitch from './ThemeSwitch'

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

type TabId = 'general' | 'appearance' | 'streamsafe' | 'mail' | 'calendar' | 'accounts' | 'data'

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'streamsafe', label: 'Stream-safe', icon: ShieldCheck },
  { id: 'mail', label: 'Mail', icon: Mail },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'accounts', label: 'Accounts', icon: Users },
  { id: 'data', label: 'Updates and backup', icon: HardDrive }
]

/** Public holidays in the calendar: on or off, and whose. */
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

/** Everything that is a setting rather than mail, in one place. */
export default function SettingsDialog({
  streamSafe,
  accounts,
  onRename,
  onRemove,
  onAddAccount,
  onRules,
  onNotifications,
  onReport,
  onClose
}: {
  streamSafe: StreamSafeState
  accounts: Account[]
  onRename: (id: string, name: string) => void
  onRemove: (account: Account) => void
  onAddAccount: () => void
  onRules: () => void
  onNotifications: () => void
  onReport: () => void
  onClose: () => void
}) {
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
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  /** Closes this panel, then opens the dialog for the chosen setting. */
  const go = (open: () => void) => () => {
    dialog.current?.close()
    open()
  }

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
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="settings-title"
      className="m-auto h-[min(40rem,calc(100vh-4rem))] w-[min(52rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-md border border-line-strong bg-raised p-0 text-ink open:flex"
    >
      <header className="flex h-12 shrink-0 items-center border-b border-line px-4">
        <h2 id="settings-title" className="flex-1 text-md font-semibold">
          Settings
        </h2>
        <button
          className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
          aria-label="Close settings"
          title="Close"
          onClick={() => dialog.current?.close()}
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </button>
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
              <button className={row} onClick={go(onNotifications)}>
                <Bell size={16} strokeWidth={1.75} aria-hidden />
                Notifications
              </button>
              <button className={row} onClick={go(onRules)}>
                <ListFilter size={16} strokeWidth={1.75} aria-hidden />
                Rules
              </button>
            </Section>
          )}

          {current === 'calendar' && (
            <>
              <Holidays />
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
              <button className={row} onClick={go(onAddAccount)}>
                <Plus size={16} strokeWidth={1.75} aria-hidden />
                Add account
              </button>
            </Section>
          )}

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
                <button className={row} onClick={go(onReport)}>
                  <Bug size={16} strokeWidth={1.75} aria-hidden />
                  Report a problem
                </button>
              </Section>
            </>
          )}
        </div>
      </div>
    </dialog>
  )
}

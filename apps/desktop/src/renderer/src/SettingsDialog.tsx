import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Bug, Download, ListFilter, Plus, Trash2, Upload, X } from 'lucide-react'
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
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  /** Closes this panel, then opens the dialog for the chosen setting. */
  const go = (open: () => void) => () => {
    dialog.current?.close()
    open()
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="settings-title"
      className="m-auto w-md max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto p-6">
        <div className="flex items-center">
          <h2 id="settings-title" className="flex-1 text-lg font-semibold">
            Settings
          </h2>
          <button
            className="grid size-8 place-items-center rounded-md text-ink-2 hover:bg-hover"
            aria-label="Close settings"
            onClick={() => dialog.current?.close()}
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        <Section title="Stream-safe mode">
          <StreamSafeControl state={streamSafe} inline />
        </Section>

        <Section title="Appearance">
          <ThemeSwitch />
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

        <Section title="Help">
          <button className={row} onClick={go(onReport)}>
            <Bug size={16} strokeWidth={1.75} aria-hidden />
            Report a problem
          </button>
        </Section>

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
      </div>
    </dialog>
  )
}

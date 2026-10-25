import { useEffect, useRef, useState } from 'react'
import { Bell, ListFilter, Plus, Trash2, X } from 'lucide-react'
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
  onClose
}: {
  streamSafe: StreamSafeState
  accounts: Account[]
  onRename: (id: string, name: string) => void
  onRemove: (account: Account) => void
  onAddAccount: () => void
  onRules: () => void
  onNotifications: () => void
  onClose: () => void
}) {
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

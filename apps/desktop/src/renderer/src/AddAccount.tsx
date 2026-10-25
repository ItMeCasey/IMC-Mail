import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { guessServers, type ImapAccountInput, type ServerConfig } from '@imc/core'

const input =
  'h-9 w-full rounded-md border border-line-strong bg-sheet px-3 text-ink focus-visible:border-accent focus-visible:outline-offset-0'
const label = 'mb-1 block text-sm text-ink-2'
const secondary =
  'h-9 rounded-md border border-line-strong px-4 text-ink transition-colors duration-(--dur-fast) hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'
const primary =
  'h-9 rounded-md bg-accent px-4 font-medium text-on-accent transition-colors duration-(--dur-fast) hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60'

function ServerFields({
  title,
  value,
  onChange
}: {
  title: string
  value: ServerConfig
  onChange: (v: ServerConfig) => void
}) {
  return (
    <fieldset className="grid grid-cols-[1fr_5rem_8rem] gap-2">
      <legend className={label}>{title}</legend>
      <input
        className={input}
        aria-label={`${title} host`}
        value={value.host}
        onChange={(e) => onChange({ ...value, host: e.target.value })}
      />
      <input
        className={`${input} num`}
        aria-label={`${title} port`}
        inputMode="numeric"
        value={value.port}
        onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
      />
      <select
        className={input}
        aria-label={`${title} security`}
        value={value.security}
        onChange={(e) =>
          onChange({ ...value, security: e.target.value as ServerConfig['security'] })
        }
      >
        <option value="tls">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
        <option value="none">None (unsafe)</option>
      </select>
    </fieldset>
  )
}

const blank: ServerConfig = { host: '', port: 993, security: 'tls' }
const clean = (msg: string) => msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export default function AddAccount({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [imap, setImap] = useState<ServerConfig>(blank)
  const [smtp, setSmtp] = useState<ServerConfig>({ ...blank, port: 465 })
  const [note, setNote] = useState<string | undefined>()
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [waiting, setWaiting] = useState<'gmail' | 'microsoft' | null>(null)

  const oauth = useQuery({
    queryKey: ['oauth-status'],
    queryFn: () => window.imc.invoke('oauth:status')
  })

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const autofill = () => {
    const g = guessServers(email)
    if (!g) return
    setImap(g.imap)
    setSmtp(g.smtp)
    setNote(g.note)
    if (!username) setUsername(email)
  }

  const signInWith = async (provider: 'gmail' | 'microsoft') => {
    setWaiting(provider)
    setError(null)
    try {
      await window.imc.invoke('accounts:addOAuth', { provider })
      await qc.invalidateQueries()
      onClose()
    } catch (err) {
      const msg = clean(err instanceof Error ? err.message : String(err))
      if (!/cancelled/i.test(msg)) setError(msg)
    } finally {
      setWaiting(null)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body: ImapAccountInput = {
        email,
        displayName: displayName || undefined,
        username: username || email,
        password,
        imap,
        smtp
      }
      const test = await window.imc.invoke('accounts:test', body)
      if (!test.ok) {
        setError(test.error)
        setAdvanced(true)
        return
      }
      await window.imc.invoke('accounts:add', body)
      await qc.invalidateQueries()
      onClose()
    } catch (err) {
      setError(clean(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const unconfigured = oauth.data && (!oauth.data.gmail || !oauth.data.microsoft)

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="add-account-title"
      className="m-auto w-md max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <form onSubmit={submit} className="space-y-4 p-6">
        <h2 id="add-account-title" className="text-lg font-semibold">
          Add account
        </h2>

        {waiting ? (
          <div className="space-y-3 border border-line p-4 text-center">
            <p className="text-ink-2">Finish signing in in your browser.</p>
            <button
              type="button"
              onClick={() => void window.imc.invoke('oauth:cancel')}
              className={secondary}
            >
              Cancel sign-in
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {(['gmail', 'microsoft'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!oauth.data?.[p]}
                  onClick={() => void signInWith(p)}
                  className={secondary}
                >
                  Continue with {p === 'gmail' ? 'Google' : 'Microsoft'}
                </button>
              ))}
            </div>
            {unconfigured && (
              <p className="text-sm text-ink-3">
                A greyed-out button needs a client ID. See docs/oauth-setup.md.
              </p>
            )}
          </div>
        )}

        <p className="text-sm text-ink-3">Or add any account with a password.</p>

        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="acc-email">
              Email address
            </label>
            <input
              id="acc-email"
              className={input}
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={autofill}
            />
          </div>
          <div>
            <label className={label} htmlFor="acc-password">
              Password or app password
            </label>
            <input
              id="acc-password"
              className={input}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="acc-name">
              Display name <span className="text-ink-3">(optional)</span>
            </label>
            <input
              id="acc-name"
              className={input}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>

        {note && <p className="text-sm leading-snug text-ink-2">{note}</p>}

        <button
          type="button"
          aria-expanded={advanced}
          className="text-sm text-accent underline underline-offset-2 hover:text-accent-hover"
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? 'Hide server settings' : 'Server settings'}
        </button>
        {advanced && (
          <div className="space-y-3">
            <div>
              <label className={label} htmlFor="acc-user">
                Username <span className="text-ink-3">(defaults to email)</span>
              </label>
              <input
                id="acc-user"
                className={input}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <ServerFields title="Incoming (IMAP)" value={imap} onChange={setImap} />
            <ServerFields title="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md border border-alert px-3 py-2 leading-snug text-alert"
          >
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={() => dialog.current?.close()} className={secondary}>
            Cancel
          </button>
          <button type="submit" disabled={busy} className={primary}>
            {busy ? 'Connecting' : 'Connect'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CATEGORY_LABELS, categorySchema, ruleHasConditions, type Category, type Rule } from '@imc/core'
import { useLabels } from './hooks'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const field = 'mt-1 block h-9 w-full rounded-md border border-line-strong bg-sheet px-2.5 text-ink'
const btn = 'h-9 rounded-md border border-line-strong px-4 text-ink hover:bg-hover disabled:opacity-50'

type Draft = Omit<Rule, 'id'> & { id?: string }
const blank = (): Draft => ({
  name: '',
  enabled: true,
  match: { from: '', to: '', subject: '', contains: '' },
  actions: { labelId: null, category: null, markRead: false, star: false, archive: false }
})

const describe = (r: Rule, labels: { id: string; name: string }[]): string => {
  const when = Object.entries({ from: r.match.from, to: r.match.to, subject: r.match.subject, text: r.match.contains })
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k} has "${v}"`)
    .join(' and ')
  const does = [
    r.actions.labelId ? `label ${labels.find((l) => l.id === r.actions.labelId)?.name ?? '?'}` : '',
    r.actions.category ? `file as ${CATEGORY_LABELS[r.actions.category as Category]}` : '',
    r.actions.markRead ? 'mark read' : '',
    r.actions.star ? 'star' : '',
    r.actions.archive ? 'archive' : ''
  ].filter(Boolean)
  return `When ${when || 'nothing is set'}: ${does.join(', ') || 'no action'}`
}

/** Rules that sort new inbox mail as it arrives. They run on this computer. */
export default function RulesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => window.imc.invoke('rules:list') })
  const labels = useLabels()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const refresh = () => qc.invalidateQueries()
  const save = async () => {
    if (!draft) return
    if (!draft.name.trim()) return setError('Give the rule a name.')
    if (!ruleHasConditions(draft.match)) return setError('Set at least one condition, or it would match nothing.')
    const a = draft.actions
    if (!a.labelId && !a.category && !a.markRead && !a.star && !a.archive) {
      return setError('Pick at least one thing for the rule to do.')
    }
    try {
      await window.imc.invoke('rules:save', draft)
      setDraft(null)
      setError(null)
      await refresh()
    } catch (e) {
      setError(errText(e))
    }
  }
  const setMatch = (k: keyof Draft['match'], v: string) =>
    setDraft((d) => d && { ...d, match: { ...d.match, [k]: v } })
  const setAction = <K extends keyof Draft['actions']>(k: K, v: Draft['actions'][K]) =>
    setDraft((d) => d && { ...d, actions: { ...d.actions, [k]: v } })

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="rules-title"
      className="m-auto w-xl max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="max-h-[calc(100vh-4rem)] overflow-y-auto p-6">
        <h2 id="rules-title" className="mb-1 text-lg font-semibold">
          Rules
        </h2>
        <p className="mb-4 text-sm text-ink-3">
          Sort new inbox mail automatically. Rules run on this computer while the app is open.
        </p>

        {draft ? (
          <div className="space-y-3">
            <label className="block text-sm text-ink-2">
              Name
              <input
                autoFocus
                value={draft.name}
                maxLength={60}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className={field}
              />
            </label>
            <fieldset className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm text-ink-2">When a message has</legend>
              {(
                [
                  ['from', 'From contains'],
                  ['to', 'To contains'],
                  ['subject', 'Subject contains'],
                  ['contains', 'Subject or first lines contain']
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="block text-sm text-ink-2">
                  {label}
                  <input value={draft.match[k]} onChange={(e) => setMatch(k, e.target.value)} className={field} />
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2 rounded-md border border-line p-3">
              <legend className="px-1 text-sm text-ink-2">Then</legend>
              <label className="block text-sm text-ink-2">
                Add label
                <select
                  value={draft.actions.labelId ?? ''}
                  onChange={(e) => setAction('labelId', e.target.value || null)}
                  className={field}
                >
                  <option value="">None</option>
                  {(labels.data ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm text-ink-2">
                File under category
                <select
                  value={draft.actions.category ?? ''}
                  onChange={(e) => setAction('category', (e.target.value || null) as Category | null)}
                  className={field}
                >
                  <option value="">Leave to the automatic one</option>
                  {categorySchema.options.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ['markRead', 'Mark as read'],
                  ['star', 'Star it'],
                  ['archive', 'Archive it (moves it out of the inbox)']
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={draft.actions[k]} onChange={(e) => setAction(k, e.target.checked)} />
                  {label}
                </label>
              ))}
            </fieldset>
            {error && (
              <p role="alert" className="text-alert">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                className={btn}
                onClick={() => {
                  setDraft(null)
                  setError(null)
                }}
              >
                Cancel
              </button>
              <button
                className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
                onClick={() => void save()}
              >
                Save rule
              </button>
            </div>
          </div>
        ) : (
          <>
            {(rules.data ?? []).length === 0 && <p className="text-ink-2">No rules yet.</p>}
            <ul className="border-t border-line">
              {(rules.data ?? []).map((r) => (
                <li key={r.id} className="flex items-start gap-3 border-b border-line py-2.5">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`${r.name} is on`}
                    checked={r.enabled}
                    onChange={(e) => void window.imc.invoke('rules:save', { ...r, enabled: e.target.checked }).then(refresh)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.name}</span>
                    <span className="block text-sm break-words text-ink-3">{describe(r, labels.data ?? [])}</span>
                  </span>
                  <button
                    className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-hover"
                    title="Apply this rule to the newest 500 messages in your inboxes"
                    onClick={() =>
                      void window.imc
                        .invoke('rules:run', { id: r.id })
                        .then((x) => {
                          setNote(`"${r.name}" matched ${x.matched} ${x.matched === 1 ? 'message' : 'messages'}.`)
                          return refresh()
                        })
                        .catch((e) => setError(errText(e)))
                    }
                  >
                    Run now
                  </button>
                  <button className="h-8 rounded-md border border-line-strong px-3 text-sm hover:bg-hover" onClick={() => setDraft(r)}>
                    Edit
                  </button>
                  <button
                    className="h-8 rounded-md border border-line-strong px-3 text-sm text-alert hover:bg-hover"
                    onClick={() => void window.imc.invoke('rules:delete', { id: r.id }).then(refresh)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            {note && (
              <p role="status" className="mt-3 text-sm text-ink-2">
                {note}
              </p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-between">
              <button className={btn} onClick={() => setDraft(blank())}>
                New rule
              </button>
              <button className={btn} onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
  )
}

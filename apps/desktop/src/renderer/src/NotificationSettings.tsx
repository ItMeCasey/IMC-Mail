import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CATEGORY_LABELS, categorySchema, type Category, type NotificationSettings } from '@imc/core'
import { useStreamerFeatures } from './hooks'

const time =
  'h-8 rounded-md border border-line-strong bg-sheet px-2 text-ink num focus-visible:border-accent focus-visible:outline-offset-0 disabled:opacity-50'

export default function NotificationSettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const streamer = useStreamerFeatures()
  const dialog = useRef<HTMLDialogElement>(null)
  const [test, setTest] = useState<string | null>(null)
  const settings = useQuery({
    queryKey: ['notifications'],
    queryFn: () => window.imc.invoke('notifications:get')
  })
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const s = settings.data
  const save = (patch: Partial<NotificationSettings>) =>
    void window.imc
      .invoke('notifications:set', patch)
      .then((next) => qc.setQueryData(['notifications'], next))

  const toggleCategory = (c: Category) => {
    if (!s) return
    save({
      categories: s.categories.includes(c) ? s.categories.filter((x) => x !== c) : [...s.categories, c]
    })
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="notif-title"
      className="m-auto w-md max-w-[calc(100vw-2rem)] rounded-md border border-line-strong bg-raised p-0 text-ink"
    >
      <div className="space-y-5 p-6">
        <h2 id="notif-title" className="text-lg font-semibold">
          Notifications
        </h2>

        {!s ? (
          <p className="text-ink-2">Loading…</p>
        ) : (
          <>
            <label className="flex cursor-default items-center gap-3">
              <input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
              <span className="font-medium">Notify me about new mail</span>
            </label>

            {streamer && (
            <fieldset disabled={!s.enabled} className="space-y-2 disabled:opacity-50">
              <legend className="mb-1 text-sm text-ink-2">Only for these kinds of mail</legend>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {categorySchema.options.map((c) => (
                  <label key={c} className="flex cursor-default items-center gap-2">
                    <input type="checkbox" checked={s.categories.includes(c)} onChange={() => toggleCategory(c)} />
                    {c === 'other' ? 'Everything else' : CATEGORY_LABELS[c]}
                  </label>
                ))}
              </div>
              <p className="text-xs text-ink-3">Likely scams never notify.</p>
            </fieldset>
            )}

            <fieldset disabled={!s.enabled} className="space-y-2 disabled:opacity-50">
              <legend className="mb-1 text-sm text-ink-2">Quiet hours</legend>
              <label className="flex cursor-default items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.quietHours.enabled}
                  onChange={(e) => save({ quietHours: { ...s.quietHours, enabled: e.target.checked } })}
                />
                <span className="whitespace-nowrap">Stay silent between</span>
                <input
                  type="time"
                  aria-label="Quiet hours start"
                  className={time}
                  value={s.quietHours.start}
                  disabled={!s.quietHours.enabled}
                  onChange={(e) => e.target.value && save({ quietHours: { ...s.quietHours, start: e.target.value } })}
                />
                and
                <input
                  type="time"
                  aria-label="Quiet hours end"
                  className={time}
                  value={s.quietHours.end}
                  disabled={!s.quietHours.enabled}
                  onChange={(e) => e.target.value && save({ quietHours: { ...s.quietHours, end: e.target.value } })}
                />
              </label>
            </fieldset>

            {streamer && (
            <fieldset disabled={!s.enabled} className="space-y-1 disabled:opacity-50">
              <legend className="mb-1 text-sm text-ink-2">While stream-safe mode is on</legend>
              {(
                [
                  ['silent', 'Show nothing', 'Notifications appear on screen and in captures, so none are shown.'],
                  ['generic', 'Show "New message" only', 'No sender or subject. Others can still see that mail arrived.']
                ] as const
              ).map(([id, label, hint]) => (
                <label key={id} className="flex cursor-default items-start gap-2 rounded-md px-1 py-1 hover:bg-hover">
                  <input
                    type="radio"
                    name="stream"
                    className="mt-1"
                    checked={s.whenStreamSafe === id}
                    onChange={() => save({ whenStreamSafe: id })}
                  />
                  <span>
                    {label}
                    <span className="block text-xs text-ink-3">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            )}

            <div className="flex items-center gap-3">
              <button
                className="h-9 rounded-md border border-line-strong px-4 hover:bg-hover"
                onClick={() =>
                  void window.imc.invoke('notifications:test').then((r) => setTest(r.shown ? 'Sent. Look for it near the clock.' : (r.reason ?? 'Not shown')))
                }
              >
                Send a test
              </button>
              {test && (
                <span role="status" className="text-sm text-ink-2">
                  {test}
                </span>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end pt-1">
          <button className="h-9 rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}

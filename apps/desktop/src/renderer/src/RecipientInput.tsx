import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Contact } from '@imc/core'

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

/** "Name <a@b.co>" -> "a@b.co" for validation. */
const addressOf = (entry: string): string => {
  const m = entry.match(/<([^>]+)>\s*$/)
  return (m ? m[1]! : entry).trim()
}
export const isValidRecipient = (entry: string): boolean => EMAIL.test(addressOf(entry))

/**
 * A recipients field: addresses become removable chips on Enter, comma, semicolon, space or
 * blur; pasted lists split; suggestions come from people you already have mail with.
 */
export default function RecipientInput({
  label,
  value,
  onChange,
  autoFocus
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
  autoFocus?: boolean
}) {
  const id = useId()
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<Contact[]>([])
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) {
      setSuggestions([])
      return
    }
    let stale = false
    const t = setTimeout(() => {
      void window.imc.invoke('contacts:search', { q }).then((r) => {
        if (!stale) {
          setSuggestions(r.filter((c) => !value.some((v) => addressOf(v).toLowerCase() === c.address.toLowerCase())))
          setActive(0)
        }
      })
    }, 120)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [text, value])

  const add = (raw: string) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setText('')
    setSuggestions([])
  }

  const pick = (c: Contact) => add(c.name ? `${c.name.replace(/["<>]/g, '')} <${c.address}>` : c.address)

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (suggestions[active] && e.key === 'Enter') {
        e.preventDefault()
        pick(suggestions[active]!)
      } else if (text.trim()) {
        e.preventDefault()
        add(text)
      }
    } else if (e.key === ' ' && EMAIL.test(text.trim())) {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape' && suggestions.length > 0) {
      e.stopPropagation()
      setSuggestions([])
    }
  }

  return (
    <div className="relative flex min-h-9 items-start gap-3 border-b border-line px-4 py-1.5">
      <label htmlFor={id} className="w-10 shrink-0 pt-1 text-sm text-ink-3">
        {label}
      </label>
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
        onClick={() => input.current?.focus()}
      >
        {value.map((v) => {
          const ok = isValidRecipient(v)
          return (
            <span
              key={v}
              className={`flex h-6 max-w-full items-center gap-1 rounded-sm border px-2 text-sm ${
                ok ? 'border-line-strong text-ink' : 'border-alert text-alert'
              }`}
              title={ok ? undefined : 'This does not look like an email address'}
            >
              <span className="truncate">{v}</span>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="grid size-4 place-items-center rounded-sm text-ink-3 hover:text-ink"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(value.filter((x) => x !== v))
                }}
              >
                <X size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </span>
          )
        })}
        <input
          id={id}
          ref={input}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => text.trim() && add(text)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault()
              add(pasted)
            }
          }}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          className="h-6 min-w-40 flex-1 bg-transparent text-ink outline-none focus-visible:outline-none"
        />
      </div>
      {suggestions.length > 0 && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute top-full left-14 z-20 max-h-56 w-96 max-w-[calc(100%-4rem)] overflow-y-auto rounded-md border border-line-strong bg-raised"
        >
          {suggestions.map((c, i) => (
            <li
              key={c.address}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
              className={`flex cursor-default items-baseline gap-2 px-3 py-1.5 ${i === active ? 'bg-selected' : 'hover:bg-hover'}`}
            >
              <span className="truncate">{c.name || c.address}</span>
              {c.name && <span className="truncate text-sm text-ink-3">{c.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

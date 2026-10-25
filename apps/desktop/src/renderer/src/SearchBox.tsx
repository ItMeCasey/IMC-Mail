import { useState } from 'react'
import { Search, X } from 'lucide-react'

const EXAMPLES: [string, string][] = [
  ['from:nova', 'Sender contains "nova"'],
  ['to:pat subject:invoice', 'Combine fields'],
  ['"exact phrase"', 'Words in this order'],
  ['-spam', 'Leave out a word'],
  ['is:unread  is:starred', 'Unread or starred'],
  ['has:attachment', 'Has a real attachment'],
  ['account:work  in:sent', 'One account or folder'],
  ['after:2026-10-01 before:2026-11-01', 'A date range']
]

export default function SearchBox({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [focused, setFocused] = useState(false)

  return (
    <div className="relative ml-auto w-72 max-w-[45%]">
      <Search
        size={14}
        strokeWidth={1.75}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
      />
      <input
        id="search-input"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) onChange('')
            else (e.target as HTMLInputElement).blur()
            e.stopPropagation()
          }
        }}
        placeholder="Search mail  ( / )"
        aria-label="Search mail"
        className="h-8 w-full rounded-md border border-line-strong bg-sheet pr-8 pl-8 text-ink [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange('')}
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-ink-3 hover:text-ink"
        >
          <X size={12} strokeWidth={1.75} aria-hidden />
        </button>
      )}
      {focused && !value && (
        <div
          role="note"
          className="absolute top-full right-0 z-20 mt-1 w-80 rounded-md border border-line-strong bg-raised p-3"
        >
          <p className="mb-2 text-sm text-ink-2">Search the mail on this computer</p>
          <dl className="space-y-1.5">
            {EXAMPLES.map(([q, what]) => (
              <div key={q} className="flex items-baseline justify-between gap-3">
                <dt className="num text-sm text-ink">{q}</dt>
                <dd className="text-right text-xs text-ink-3">{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

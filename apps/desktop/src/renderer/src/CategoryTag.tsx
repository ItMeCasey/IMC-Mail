import { CATEGORY_LABELS, type Category } from '@imc/core'
import { Private } from './streamsafe'

/**
 * A flat outlined label, so the kind of mail reads as text and never depends on color. Plain
 * mail ("other") gets no tag at all: a list where everything is tagged says nothing.
 */
export default function CategoryTag({
  category,
  hide = false
}: {
  category: Category
  hide?: boolean
}) {
  if (category === 'other') return null
  return (
    <span className="shrink-0 rounded-sm border border-line-strong px-1.5 text-xs leading-4 text-ink-2">
      {hide ? <Private active>{CATEGORY_LABELS[category]}</Private> : CATEGORY_LABELS[category]}
    </span>
  )
}

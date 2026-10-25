import { nextDeadline } from '@imc/core'

/** Plain text of a cached body: the text part, or the HTML with tags and style blocks stripped. */
export function bodyText(body: { text: string; html: string | null } | undefined): string {
  if (!body) return ''
  if (body.text.trim()) return body.text
  return (body.html ?? '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * A deadline mentioned in the email a deal starts from, with a note saying where it came from,
 * so the due date is filled in but never silently trusted.
 */
export function dealDeadlineFromEmail(
  subject: string,
  body: { text: string; html: string | null } | undefined,
  now = new Date()
): { dueDate: number; note: string } | null {
  const found = nextDeadline(`${subject}\n${bodyText(body)}`, now)
  return found ? { dueDate: found.date, note: `Due date taken from the email: "${found.phrase}".` } : null
}

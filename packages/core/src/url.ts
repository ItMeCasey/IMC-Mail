/**
 * A web address that is safe to put in a link or an outgoing invite: http(s) only, one line, and
 * none of the characters that could end an HTML attribute or a calendar line. Anything else is null.
 */
export function safeWebUrl(value: string | null | undefined): string | null {
  const s = (value ?? '').trim()
  if (!s || s.length > 2000 || !/^https?:\/\//i.test(s)) return null
  if (/[\s"'<>`\\\u0000-\u001f\u007f]/.test(s)) return null
  try {
    return new URL(s).hostname ? s : null
  } catch {
    return null
  }
}

/** Escapes text for HTML, including the quotes that end an attribute value. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

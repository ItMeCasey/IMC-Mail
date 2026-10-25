/** Roles whose folders the mail server or the app depends on; these cannot be deleted. */
export const PROTECTED_ROLES = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all', 'starred'] as const

/**
 * A folder name you may create: not empty, no path separators or control characters (they would
 * make a different folder than you meant), and not so long a server refuses it.
 * Returns the cleaned name, or the reason it is not allowed.
 */
export function cleanFolderName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name) return { ok: false, error: 'Give the folder a name.' }
  if (name.length > 100) return { ok: false, error: 'Use 100 characters or fewer.' }
  if (/[/\\]/.test(name)) return { ok: false, error: 'A folder name cannot contain / or \\.' }
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'That name has characters a folder cannot have.' }
  if (name.startsWith('.') || name.endsWith('.')) return { ok: false, error: 'A folder name cannot start or end with a dot.' }
  if (name.toLowerCase() === 'inbox') return { ok: false, error: 'There is already an Inbox.' }
  return { ok: true, name }
}

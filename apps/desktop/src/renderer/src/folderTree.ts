import type { Folder } from '@imc/core'

export interface FolderRow {
  folder: Folder
  /** How many levels deep it sits under its parent folders, for indenting. */
  depth: number
}

/** The part of a folder's path before its own name, e.g. "Inbox/" for "Inbox/Rent". */
const prefixOf = (f: Folder): string => (f.path.length > f.name.length && f.path.endsWith(f.name) ? f.path.slice(0, -f.name.length) : '')

/**
 * One account's folders in tree order: each folder's children follow it, indented by how many
 * levels deep it is. A folder whose parent is not a folder of its own (Gmail's "[Gmail]" group)
 * is still indented but has nothing above it. Within a level the original order is kept.
 */
export function folderRows(folders: Folder[]): FolderRow[] {
  const byPath = new Map(folders.map((f) => [f.path.toLowerCase(), f]))
  const parentOf = (f: Folder): Folder | undefined => {
    const prefix = prefixOf(f)
    if (!prefix) return undefined
    const p = byPath.get(prefix.slice(0, -1).toLowerCase())
    return p && p.id !== f.id ? p : undefined
  }
  const children = new Map<string, Folder[]>()
  const roots: Folder[] = []
  for (const f of folders) {
    const p = parentOf(f)
    if (p) children.set(p.id, [...(children.get(p.id) ?? []), f])
    else roots.push(f)
  }
  const out: FolderRow[] = []
  const seen = new Set<string>()
  const walk = (f: Folder) => {
    if (seen.has(f.id)) return
    seen.add(f.id)
    out.push({ folder: f, depth: prefixOf(f).split(/[/.\\]/).filter(Boolean).length })
    for (const c of children.get(f.id) ?? []) walk(c)
  }
  roots.forEach(walk)
  return out
}

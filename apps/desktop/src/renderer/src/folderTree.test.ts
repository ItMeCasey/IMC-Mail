import { describe, expect, it } from 'vitest'
import type { Folder } from '@imc/core'
import { folderRows } from './folderTree'

const f = (path: string, name: string, role: Folder['role'] = null): Folder => ({ id: path, accountId: 'a', path, name, role, unread: 0, total: 0 })
const view = (list: Folder[]) => folderRows(list).map((r) => `${' '.repeat(r.depth)}${r.folder.name}`)

describe('folderRows', () => {
  it('puts subfolders under their parent, indented, whatever order they arrive in', () => {
    expect(
      view([
        f('INBOX', 'Inbox', 'inbox'),
        f('Sent', 'Sent', 'sent'),
        f('Archive', 'Archive', 'archive'),
        f('Inbox/Rent', 'Rent'),
        f('Inbox/Electric', 'Electric'),
        f('Sync Issues', 'Sync Issues'),
        f('Sync Issues/Conflicts', 'Conflicts')
      ])
    ).toEqual(['Inbox', ' Rent', ' Electric', 'Sent', 'Archive', 'Sync Issues', ' Conflicts'])
  })

  it('matches the parent without caring about case, and handles dot delimiters and deeper levels', () => {
    expect(view([f('INBOX', 'Inbox', 'inbox'), f('INBOX.Work', 'Work'), f('INBOX.Work.Brands', 'Brands')])).toEqual(['Inbox', ' Work', '  Brands'])
  })

  it('indents a folder whose parent group is not a folder itself, and keeps a folder named with dots whole', () => {
    expect(view([f('[Gmail]/Sent Mail', 'Sent Mail', 'sent'), f('v1.2 notes', 'v1.2 notes')])).toEqual([' Sent Mail', 'v1.2 notes'])
  })

  it('lists every folder exactly once', () => {
    const list = [f('A', 'A'), f('A/B', 'B'), f('A/B/C', 'C')]
    expect(folderRows(list).map((r) => r.folder.id)).toEqual(['A', 'A/B', 'A/B/C'])
  })
})

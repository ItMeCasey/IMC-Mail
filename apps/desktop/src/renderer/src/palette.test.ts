import { describe, expect, it } from 'vitest'
import { filterCommands, type Command } from './CommandPalette'

const c = (id: string, label: string, group: string): Command => ({ id, label, group, run: () => {} })
const all = [c('1', 'Compose a new message', 'Action'), c('2', 'Needs reply', 'Go to'), c('3', 'Casey · Sent', 'Folder')]

describe('filterCommands', () => {
  it('returns everything for an empty query', () => expect(filterCommands(all, '  ')).toHaveLength(3))
  it('needs every word, in any order, in the label or group', () => {
    expect(filterCommands(all, 'new msg').map((x) => x.id)).toEqual([])
    expect(filterCommands(all, 'message compose').map((x) => x.id)).toEqual(['1'])
    expect(filterCommands(all, 'go reply').map((x) => x.id)).toEqual(['2'])
    expect(filterCommands(all, 'SENT').map((x) => x.id)).toEqual(['3'])
  })
})

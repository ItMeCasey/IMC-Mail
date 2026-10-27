import { describe, expect, it } from 'vitest'
import { formatHlc, type SyncRecord } from '@imc/core'
import { SyncStore } from './store'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 27)

const record = (id: string, ageDays: number, deleted: boolean): SyncRecord => ({ type: 'label', id, hlc: formatHlc({ wall: NOW - ageDays * DAY, counter: 0, device: 'abcd' }), deleted, payload: deleted ? '' : 'x' })

function groupWith(records: SyncRecord[]) {
  const store = new SyncStore(':memory:')
  store.createGroup('g1', 'h', { id: 'd1', publicKey: 'k', name: 'one' }, NOW)
  store.push('g1', records)
  return store
}

describe('pruning deletion records', () => {
  it('drops old deletions and keeps recent ones and every live item', () => {
    const store = groupWith([record('old-gone', 200, true), record('new-gone', 10, true), record('old-live', 200, false)])
    expect(store.pruneDeleted(NOW, 180 * DAY)).toBe(1)
    expect(store.recordCount('g1')).toBe(2)
  })

  it('does nothing when there is nothing old to drop', () => {
    const store = groupWith([record('a', 5, true), record('b', 5, false)])
    expect(store.pruneDeleted(NOW, 180 * DAY)).toBe(0)
    expect(store.recordCount('g1')).toBe(2)
  })
})

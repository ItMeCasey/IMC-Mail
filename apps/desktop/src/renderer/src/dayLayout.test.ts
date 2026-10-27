import { describe, expect, it } from 'vitest'
import { placeDay } from './dayLayout'

const DAY = 24 * 60 * 60_000
const at = (h: number, m = 0) => (h * 60 + m) * 60_000
const meet = (id: string, from: number, to: number) => ({ id, start: from, end: to })

describe('placeDay', () => {
  it('puts meetings that do not overlap each in a full-width lane', () => {
    const r = placeDay([meet('a', at(9), at(10)), meet('b', at(10), at(11))], 0, DAY)
    expect(r.map((p) => [p.o.id, p.lane, p.lanes])).toEqual([['a', 0, 1], ['b', 0, 1]])
    expect(r[0]).toMatchObject({ from: 540, to: 600 })
  })

  it('puts overlapping meetings side by side', () => {
    const r = placeDay([meet('a', at(9), at(11)), meet('b', at(10), at(12)), meet('c', at(11), at(12))], 0, DAY)
    const by = Object.fromEntries(r.map((p) => [p.o.id, p]))
    expect([by.a!.lane, by.b!.lane]).toEqual([0, 1])
    expect(by.a!.lanes).toBe(2)
    // c starts as a ends, so it reuses lane 0 beside b
    expect(by.c!.lane).toBe(0)
    expect(by.c!.lanes).toBe(2)
  })

  it('starts a new group of lanes after a gap', () => {
    const r = placeDay([meet('a', at(9), at(10)), meet('b', at(9), at(10)), meet('c', at(14), at(15))], 0, DAY)
    expect(r.find((p) => p.o.id === 'c')!.lanes).toBe(1)
    expect(r.find((p) => p.o.id === 'a')!.lanes).toBe(2)
  })

  it('clips a meeting to the day and gives a zero-length one a half hour', () => {
    const r = placeDay([meet('late', at(23), DAY + at(2)), meet('zero', at(8), at(8))], 0, DAY)
    expect(r.find((p) => p.o.id === 'late')).toMatchObject({ from: 23 * 60, to: 24 * 60 })
    expect(r.find((p) => p.o.id === 'zero')).toMatchObject({ from: 8 * 60, to: 8 * 60 + 30 })
  })

  it('leaves out meetings that are not on the day', () => {
    expect(placeDay([meet('next', DAY + at(9), DAY + at(10))], 0, DAY)).toEqual([])
  })

  it('gives a very short meeting room for its minimum height, so the next one does not sit on it', () => {
    const r = placeDay([meet('a', at(9), at(9, 5)), meet('b', at(9, 10), at(10))], 0, DAY, 25)
    expect(r.map((p) => p.lane)).toEqual([0, 1])
  })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCalVer, nextVersion } from './next-version.mjs'

const oct = new Date(2026, 9, 25)

test('the first release of a month is .1', () => {
  assert.equal(nextVersion([], oct), '2026.10.1')
  assert.equal(nextVersion(['v2026.9.4', 'v2026.9.5'], oct), '2026.10.1')
})

test('later releases in the same month count up', () => {
  assert.equal(nextVersion(['v2026.10.1'], oct), '2026.10.2')
  assert.equal(nextVersion(['v2026.10.1', 'v2026.10.2', 'v2026.10.3'], oct), '2026.10.4')
})

test('compares the counter as a number, not as text', () => {
  assert.equal(nextVersion(['v2026.10.2', 'v2026.10.9', 'v2026.10.10'], oct), '2026.10.11')
})

test('the month has no leading zero, and January starts a new year', () => {
  assert.equal(nextVersion([], new Date(2026, 0, 3)), '2026.1.1')
  assert.equal(nextVersion(['v2026.12.7'], new Date(2027, 0, 1)), '2027.1.1')
  assert.equal(nextVersion(['v2026.1.3'], new Date(2026, 0, 31)), '2026.1.4')
})

test('ignores tags that are not releases of this month', () => {
  assert.equal(nextVersion(['v2026.1.9', 'v2025.10.8', 'v2026.10.2-beta', 'vnext', 'junk', 'v2026.100.5'], oct), '2026.10.1')
})

test('isCalVer accepts this scheme and nothing else', () => {
  for (const ok of ['2026.10.1', '2026.1.12', '2027.12.100']) assert.equal(isCalVer(ok), true, ok)
  for (const bad of ['0.0.0', '2026.01.1', '2026.13.1', '2026.10.0', '2026.10', 'v2026.10.1', '26.10.1']) assert.equal(isCalVer(bad), false, bad)
})

test('the versions sort the way releases happen, as semantic versions', () => {
  const order = ['2026.9.3', '2026.10.1', '2026.10.2', '2026.11.1', '2027.1.1']
  const key = (v) => v.split('.').map(Number)
  const sorted = [...order].sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  assert.deepEqual(sorted, order)
})

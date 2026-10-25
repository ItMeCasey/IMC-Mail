import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileReport, handle, Limiter, scrub, validate } from './relay.mjs'

const repo = 'ItMeCasey/IMC-Mail'
/** A fake GitHub: records calls, answers searches from `open`. */
function fakeGithub(open = []) {
  const calls = []
  const github = async (method, path, json) => {
    calls.push({ method, path, json })
    if (path.startsWith('/search/issues')) return { items: open }
    if (path.endsWith('/comments')) return {}
    return { html_url: 'https://github.com/ItMeCasey/IMC-Mail/issues/7', number: 7 }
  }
  return { github, calls }
}
const post = (body, ip = '1.2.3.4') => ({ method: 'POST', path: '/report', ip, bodyText: JSON.stringify(body) })
const good = { title: 'Problem: boom', body: '**What happened**\nIt broke', version: '1.0.0', platform: 'win32' }

test('scrub removes addresses, user names and tokens', () => {
  assert.equal(scrub('mail pat@nova.example'), 'mail <email>')
  assert.equal(scrub('C:\\Users\\casey\\a.js'), 'C:\\Users\\<user>\\a.js')
  assert.match(scrub('key ' + 'a'.repeat(40)), /<token>/)
})

test('validate accepts a good report and cleans it', () => {
  const v = validate({ ...good, title: '  Problem   from me@x.example ' })
  assert.equal(v.report.title, 'Problem from <email>')
})

test('validate refuses missing, wrong-typed and oversized input', () => {
  for (const bad of [null, 'x', {}, { title: 'a' }, { title: '', body: 'b' }, { title: 'a', body: 'b'.repeat(20_001) }, { title: 'a', body: 'b', version: 5 }]) {
    assert.ok(validate(bad).error, JSON.stringify(bad).slice(0, 40))
  }
})

test('a new report opens an issue labelled bug and from-app', async () => {
  const { github, calls } = fakeGithub()
  const out = await handle(post(good), { limiter: new Limiter(), github, repo })
  assert.equal(out.status, 200)
  assert.deepEqual(out.json, { ok: true, url: 'https://github.com/ItMeCasey/IMC-Mail/issues/7', number: 7, duplicate: false })
  const created = calls.find((c) => c.method === 'POST' && c.path === `/repos/${repo}/issues`)
  assert.deepEqual(created.json.labels, ['bug', 'from-app'])
  assert.equal(created.json.title, 'Problem: boom')
})

test('a repeat of an open issue becomes a comment, not a second issue', async () => {
  const { github, calls } = fakeGithub([{ title: 'Problem: boom', number: 3, html_url: 'https://github.com/x/y/issues/3' }])
  const r = await fileReport(validate(good).report, { github, repo })
  assert.deepEqual(r, { url: 'https://github.com/x/y/issues/3', number: 3, duplicate: true })
  assert.ok(calls.some((c) => c.path === `/repos/${repo}/issues/3/comments`))
  assert.ok(!calls.some((c) => c.path === `/repos/${repo}/issues` && c.method === 'POST'))
})

test('private details are removed again on the server, even if the app missed them', async () => {
  const { github, calls } = fakeGithub()
  await handle(post({ ...good, body: 'failed for pat@nova.example in C:\\Users\\casey\\x' }), { limiter: new Limiter(), github, repo })
  const body = calls.find((c) => c.path === `/repos/${repo}/issues`).json.body
  assert.ok(!body.includes('pat@') && !body.includes('casey'))
})

test('limits: a sixth report from one address in an hour is refused, other addresses are fine', async () => {
  const { github } = fakeGithub()
  const limiter = new Limiter({ perIpPerHour: 5 })
  const statuses = []
  for (let i = 0; i < 6; i++) statuses.push((await handle(post(good), { limiter, github, repo })).status)
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
  assert.equal((await handle(post(good, '9.9.9.9'), { limiter, github, repo })).status, 200)
})

test('the limit resets after an hour, and the daily ceiling holds for everyone', () => {
  let t = 0
  const l = new Limiter({ perIpPerHour: 1, perDay: 2, now: () => t })
  assert.equal(l.take('a'), true)
  assert.equal(l.take('a'), false)
  t = 3_600_001
  assert.equal(l.take('a'), true)
  assert.equal(l.take('b'), false) // two in the day already
})

test('wrong path, wrong method, bad JSON and oversized bodies get the right status', async () => {
  const { github } = fakeGithub()
  const deps = { limiter: new Limiter(), github, repo }
  assert.equal((await handle({ ...post(good), path: '/other' }, deps)).status, 404)
  assert.equal((await handle({ ...post(good), method: 'GET' }, deps)).status, 405)
  assert.equal((await handle({ method: 'POST', path: '/report', ip: '1', bodyText: '{nope' }, deps)).status, 400)
  assert.equal((await handle({ method: 'POST', path: '/report', ip: '1', bodyText: 'x'.repeat(30_000) }, deps)).status, 413)
})

test('a GitHub failure gives a plain 502 that says nothing about the token', async () => {
  const github = async () => {
    throw new Error('GitHub POST /repos/x/issues -> 401 token ghp_secret')
  }
  const out = await handle(post(good), { limiter: new Limiter(), github, repo })
  assert.equal(out.status, 502)
  assert.ok(!JSON.stringify(out.json).includes('ghp_'))
})

// The logic of the problem-report relay, kept apart from the HTTP server so it can be tested.
//
// The app posts a report here; this turns it into a GitHub issue using a token that lives only on
// the server. Anyone on the internet can reach the endpoint, so it validates and limits what it
// accepts, removes private details again, and files repeats as comments on the first issue.

const MAX_BODY_BYTES = 24_000
const MAX_TITLE = 120
const MAX_TEXT = 20_000

/** Same rules as the app: addresses, user names in paths, and long token-like strings. */
export function scrub(text) {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/([A-Za-z]:\\+Users\\+)[^\\/\s'"]+/g, '$1<user>')
    .replace(/(\/(?:Users|home)\/)[^/\s'"]+/g, '$1<user>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
}

/** Allows a few reports per address per hour, and a ceiling for the whole service per day. */
export class Limiter {
  constructor({ perIpPerHour = 5, perDay = 200, now = Date.now } = {}) {
    this.perIpPerHour = perIpPerHour
    this.perDay = perDay
    this.now = now
    this.byIp = new Map()
    this.day = []
  }

  /** True if this request may go ahead (and counts it). */
  take(ip) {
    const t = this.now()
    this.day = this.day.filter((x) => t - x < 86_400_000)
    const hits = (this.byIp.get(ip) ?? []).filter((x) => t - x < 3_600_000)
    if (hits.length >= this.perIpPerHour || this.day.length >= this.perDay) {
      this.byIp.set(ip, hits)
      return false
    }
    hits.push(t)
    this.byIp.set(ip, hits)
    this.day.push(t)
    // Forget addresses that have gone quiet, so the map cannot grow without end.
    if (this.byIp.size > 5000) for (const [k, v] of this.byIp) if (!v.some((x) => t - x < 3_600_000)) this.byIp.delete(k)
    return true
  }
}

/** Checks the shape of a report; returns the cleaned report or an error message. */
export function validate(input) {
  if (!input || typeof input !== 'object') return { error: 'Send a JSON object.' }
  const { title, body, version, platform } = input
  if (typeof title !== 'string' || !title.trim()) return { error: 'A title is required.' }
  if (typeof body !== 'string' || !body.trim()) return { error: 'A body is required.' }
  if (body.length > MAX_TEXT) return { error: 'The report is too long.' }
  if (version !== undefined && (typeof version !== 'string' || version.length > 40)) return { error: 'Bad version.' }
  if (platform !== undefined && (typeof platform !== 'string' || platform.length > 40)) return { error: 'Bad platform.' }
  return {
    report: {
      title: scrub(title.trim().replace(/\s+/g, ' ')).slice(0, MAX_TITLE),
      body: scrub(body.trim()),
      version: version ? scrub(version) : '',
      platform: platform ? scrub(platform) : ''
    }
  }
}

/**
 * Files a report. If an open issue with the same title exists, adds a comment to it instead of
 * opening another. `github(method, path, json)` returns the parsed JSON response.
 */
export async function fileReport(report, { github, repo, labels = ['bug', 'from-app'] }) {
  const q = encodeURIComponent(`repo:${repo} is:issue is:open in:title "${report.title.replace(/"/g, '')}"`)
  const found = await github('GET', `/search/issues?q=${q}&per_page=5`)
  const same = (found.items ?? []).find((i) => i.title === report.title)
  if (same) {
    await github('POST', `/repos/${repo}/issues/${same.number}/comments`, { body: `Another report of this${report.version ? ` (version ${report.version})` : ''}:\n\n${report.body}` })
    return { url: same.html_url, number: same.number, duplicate: true }
  }
  const made = await github('POST', `/repos/${repo}/issues`, { title: report.title, body: report.body, labels })
  return { url: made.html_url, number: made.number, duplicate: false }
}

/** The whole request: limit, parse, validate, file. Returns { status, json } for the server to send. */
export async function handle({ method, path, ip, bodyText }, { limiter, github, repo }) {
  if (path !== '/report') return { status: 404, json: { ok: false, error: 'Not found.' } }
  if (method !== 'POST') return { status: 405, json: { ok: false, error: 'Use POST.' } }
  if (Buffer.byteLength(bodyText ?? '') > MAX_BODY_BYTES) return { status: 413, json: { ok: false, error: 'Too large.' } }
  if (!limiter.take(ip)) return { status: 429, json: { ok: false, error: 'Too many reports. Try again later.' } }
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { status: 400, json: { ok: false, error: 'That was not JSON.' } }
  }
  const v = validate(parsed)
  if (v.error) return { status: 400, json: { ok: false, error: v.error } }
  try {
    const r = await fileReport(v.report, { github, repo })
    return { status: 200, json: { ok: true, url: r.url, number: r.number, duplicate: r.duplicate } }
  } catch (e) {
    // Never pass GitHub's error text (or anything about the token) back to the caller.
    console.error('[relay] GitHub call failed:', e instanceof Error ? e.message : e)
    return { status: 502, json: { ok: false, error: 'Could not reach the issue tracker. Try again later.' } }
  }
}

/** A GitHub REST caller bound to one token. */
export function githubClient(token, fetchFn = fetch) {
  return async (method, path, json) => {
    const res = await fetchFn(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'imc-mail-report-relay',
        ...(json ? { 'Content-Type': 'application/json' } : {})
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} -> ${res.status}`)
    return res.json()
  }
}

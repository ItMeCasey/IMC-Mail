// IMC-Mail versions are YYYY.M.N: the year, the month (no leading zero), and a counter that starts
// at 1 each month and goes up with every release in that month. Examples: 2026.10.1, 2026.10.2,
// 2026.11.1. These are valid semantic versions, so the updater orders them correctly (2026.10.x
// comes after 2026.9.x because the month is compared as a number).
//
//   node scripts/next-version.mjs            prints the next version
//   node scripts/next-version.mjs --write    also sets it in apps/desktop/package.json
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The next version after the given release tags, for the month of `date`. Tags look like "v2026.10.3". */
export function nextVersion(tags, date = new Date()) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const prefix = `v${year}.${month}.`
  let highest = 0
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue
    const rest = tag.slice(prefix.length)
    if (/^\d+$/.test(rest)) highest = Math.max(highest, Number(rest))
  }
  return `${year}.${month}.${highest + 1}`
}

/** True for a version in this scheme. */
export const isCalVer = (v) => /^(20\d\d)\.([1-9]|1[0-2])\.([1-9]\d*)$/.test(v)

function main() {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
  const version = nextVersion(tags)
  console.log(version)
  if (process.argv.includes('--write')) {
    const file = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    pkg.version = version
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

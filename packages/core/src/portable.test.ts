import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The mobile apps will import this package, so it may only use what a phone's JavaScript
// runtime has: no Node built-ins, no Electron, no Buffer or process.
const dir = import.meta.dirname
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

describe('@imc/core stays portable', () => {
  it.each(sources)('%s uses no Node or Electron APIs', (file) => {
    const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    expect(code).not.toMatch(/from\s+['"](node:|electron|fs|path|os|crypto|zlib|child_process|buffer|net|tls|http)/)
    expect(code).not.toMatch(/\brequire\(|\bBuffer\b|\bprocess\.|__dirname|__filename/)
  })

  it('depends on nothing but zod', () => {
    const pkg = JSON.parse(readFileSync(join(dir, '../package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(pkg.dependencies)).toEqual(['zod'])
  })
})

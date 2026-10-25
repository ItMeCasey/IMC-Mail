import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from './db'
import { MailStore } from './store'
import { TemplateService } from './templates'

describe('TemplateService', () => {
  let svc: TemplateService
  let dir: string
  let scratch: string
  let clock = 1000

  beforeEach(() => {
    const db = new Database(':memory:')
    migrate(db)
    dir = mkdtempSync(join(tmpdir(), 'imc-tpl-'))
    scratch = mkdtempSync(join(tmpdir(), 'imc-src-'))
    svc = new TemplateService(new MailStore(db), dir, () => ++clock)
  })

  const file = (name: string, body = 'x') => {
    const p = join(scratch, name)
    writeFileSync(p, body)
    return { id: name, filename: name, size: body.length, path: p }
  }

  it('saves, lists alphabetically, updates in place, and deletes', async () => {
    const b = await svc.save({ name: 'Rates', subject: 'Our rates', html: '<p>Hi {{first_name}}</p>', attachments: [] })
    const a = await svc.save({ name: 'Decline', subject: '', html: '<p>Thanks, but no.</p>', attachments: [] })
    expect(svc.list().map((t) => t.name)).toEqual(['Decline', 'Rates'])

    const edited = await svc.save({ id: b.id, name: 'Rate card', subject: 'Rates', html: b.html, attachments: [] })
    expect(edited.id).toBe(b.id)
    expect(svc.list().map((t) => t.name)).toEqual(['Decline', 'Rate card'])
    expect(edited.updatedAt).toBeGreaterThan(b.updatedAt)

    await svc.delete(a.id)
    expect(svc.list()).toHaveLength(1)
  })

  it('copies attached files into app data so the template outlives the original', async () => {
    const t = await svc.save({ name: 'Media kit', subject: 'Media kit', html: '<p>Attached.</p>', attachments: [file('kit.pdf', 'PDFDATA')] })
    expect(t.attachments).toHaveLength(1)
    const stored = t.attachments[0]!
    expect(stored.path.startsWith(dir)).toBe(true)
    expect(stored.path).not.toContain(scratch)
    expect(stored.filename).toBe('kit.pdf')
    expect(existsSync(stored.path)).toBe(true)
  })

  it('keeps its own files when edited, drops removed ones, and does not copy twice', async () => {
    const t = await svc.save({ name: 'Kit', subject: '', html: '', attachments: [file('a.pdf'), file('b.pdf')] })
    expect(readdirSync(join(dir, t.id))).toHaveLength(2)

    const again = await svc.save({ id: t.id, name: 'Kit', subject: '', html: '', attachments: [t.attachments[0]!] })
    expect(again.attachments[0]!.path).toBe(t.attachments[0]!.path)
    expect(readdirSync(join(dir, t.id))).toHaveLength(1)
    expect(existsSync(t.attachments[1]!.path)).toBe(false)
  })

  it('does not trust an outside path that merely claims to be one of its own', async () => {
    const t = await svc.save({ name: 'Kit', subject: '', html: '', attachments: [] })
    const sneaky = file('secret.txt', 'private')
    // Same folder name appears in the path, but the file is elsewhere: it must be copied, not kept.
    const out = await svc.save({ id: t.id, name: 'Kit', subject: '', html: '', attachments: [{ ...sneaky, path: sneaky.path }] })
    expect(out.attachments[0]!.path.startsWith(join(dir, t.id))).toBe(true)
  })

  it('rejects directories and deletes the template folder', async () => {
    await expect(svc.save({ name: 'Bad', subject: '', html: '', attachments: [{ id: 'd', filename: 'd', size: 0, path: scratch }] })).rejects.toThrow(/not a file/)
    const t = await svc.save({ name: 'Kit', subject: '', html: '', attachments: [file('a.pdf')] })
    await svc.delete(t.id)
    expect(existsSync(join(dir, t.id))).toBe(false)
  })
})

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { DraftAttachment, Template, TemplateInput } from '@imc/core'
import { MAX_ATTACHMENT_BYTES } from './compose'
import type { MailStore } from './store'

/** Saved replies. Attached files are copied into app data so a template survives the original moving. */
export class TemplateService {
  constructor(
    private store: MailStore,
    private dir: string,
    private now: () => number = Date.now
  ) {}

  list(): Template[] {
    return this.store.listTemplates()
  }

  /** True when a path is inside the given folder (and not the folder itself). */
  private isInside(p: string, folder: string): boolean {
    const rel = relative(resolve(folder), resolve(p))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  async save(input: TemplateInput): Promise<Template> {
    const id = input.id ?? randomUUID()
    const folder = join(this.dir, id)
    await mkdir(folder, { recursive: true })

    const kept: DraftAttachment[] = []
    for (const a of input.attachments) {
      if (this.isInside(a.path, folder)) {
        kept.push(a) // already one of this template's own files
        continue
      }
      const s = await stat(a.path)
      if (!s.isFile()) throw new Error(`${basename(a.path)} is not a file`)
      if (s.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(a.path)} is larger than 25 MB`)
      const dest = join(folder, `${randomUUID().slice(0, 8)}-${basename(a.path)}`)
      await copyFile(a.path, dest)
      kept.push({ id: randomUUID(), filename: basename(a.path), size: s.size, path: dest })
    }

    // Forget files the template no longer lists.
    const keep = new Set(kept.map((k) => resolve(k.path)))
    for (const f of await readdir(folder)) {
      if (!keep.has(resolve(join(folder, f)))) await rm(join(folder, f), { force: true })
    }

    const t: Template = {
      id,
      name: input.name,
      subject: input.subject,
      html: input.html,
      attachments: kept,
      updatedAt: this.now()
    }
    this.store.putTemplate(t)
    return t
  }

  async delete(id: string): Promise<void> {
    this.store.deleteTemplate(id)
    await rm(join(this.dir, id), { recursive: true, force: true })
  }
}

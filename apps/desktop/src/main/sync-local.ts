import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appPrefsSchema, dealData, labelData, meetingData, notificationSettingsSchema, ruleInputSchema, searchData, splitSyncKey as split, syncKey as key, templateData, type AppPrefs, type NotificationSettings, type SyncAdapter, type SyncItem, type SyncStorage, type SyncType } from '@imc/core'
export { appPrefsSchema, type AppPrefs } from '@imc/core'
import type { Db } from './db'
import type { MailStore } from './store'

/** The sync bookkeeping of this device, kept in the local database. Keys and tokens are not here: they live in the OS-protected secret store. */
export function sqliteSyncStorage(db: Db): SyncStorage {
  const row = (r: { type: string; id: string; hash: string; hlc: string; deleted: number }): SyncItem => ({
    type: r.type as SyncType,
    id: r.id,
    hash: r.hash,
    hlc: r.hlc,
    deleted: r.deleted === 1
  })
  return {
    get: (key) => (db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => void db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value),
    remove: (key) => void db.prepare('DELETE FROM sync_state WHERE key = ?').run(key),
    item: (type, id) => {
      const r = db.prepare('SELECT type, id, hash, hlc, deleted FROM sync_item WHERE type = ? AND id = ?').get(type, id) as Parameters<typeof row>[0] | undefined
      return r ? row(r) : null
    },
    items: (type) => (db.prepare('SELECT type, id, hash, hlc, deleted FROM sync_item WHERE type = ?').all(type) as Parameters<typeof row>[0][]).map(row),
    putItem: (i) =>
      void db
        .prepare(
          'INSERT INTO sync_item (type, id, hash, hlc, deleted) VALUES (?, ?, ?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET hash = excluded.hash, hlc = excluded.hlc, deleted = excluded.deleted'
        )
        .run(i.type, i.id, i.hash, i.hlc, i.deleted ? 1 : 0),
    clear: () => {
      db.exec('DELETE FROM sync_state; DELETE FROM sync_item;')
    }
  }
}

export interface PrefsAccess {
  getApp(): AppPrefs
  setApp(p: AppPrefs): void
  getNotifications(): NotificationSettings
  setNotifications(s: NotificationSettings): void
}

/** Account address by local account id, in lower case, which is how another device names the account. */
const accountEmails = (store: MailStore): Map<string, string> => new Map(store.listAccounts().map((a) => [a.id, a.email.toLowerCase()]))

/** The local message an id like `address␟message-id` points at. Null when the account or the message is not here (yet). */
function messageFor(store: MailStore, id: string): string | null {
  const [email, rfcId] = split(id)
  const accountId = email ? store.accountIdForEmail(email) : undefined
  return (accountId && rfcId ? store.messageIdForRfc(accountId, rfcId) : undefined) ?? null
}

/**
 * How each kind of synced data is read from and written to this app's stores. Things that belong to an
 * account or a message are labelData by the account's address and the Message-ID header, because local ids
 * differ from device to device; if the account or message is not on this device yet, the item waits. Templates leave out
 * their attached files, which are paths on this computer. Everything that comes from another device
 * is checked before it is stored.
 */
export function syncAdapters(store: MailStore, prefs: PrefsAccess): SyncAdapter[] {
  const checked = (schema: z.ZodType) => (data: unknown) => {
    const r = schema.safeParse(data)
    return r.success ? r.data : null
  }
  return [
    {
      type: 'label',
      list: () => store.listLabels().map((l) => ({ id: l.id, data: { name: l.name } })),
      parse: checked(labelData),
      upsert: (id, d) => store.putLabel(id, (d as { name: string }).name),
      remove: (id) => store.deleteLabel(id)
    },
    {
      type: 'rule',
      list: () => store.listRules().map(({ id, ...rest }) => ({ id, data: rest })),
      parse: checked(ruleInputSchema),
      upsert: (id, d) => {
        store.saveRule({ ...(d as z.output<typeof ruleInputSchema>), id })
        return true
      },
      remove: (id) => store.deleteRule(id)
    },
    {
      type: 'savedSearch',
      list: () => store.listSavedSearches().map((s) => ({ id: s.id, data: { name: s.name, query: s.query } })),
      parse: checked(searchData),
      upsert: (id, d) => {
        const s = d as z.output<typeof searchData>
        store.putSavedSearch(id, s.name, s.query)
        return true
      },
      remove: (id) => store.deleteSavedSearch(id)
    },
    {
      type: 'template',
      list: () => store.listTemplates().map((t) => ({ id: t.id, data: { name: t.name, subject: t.subject, html: t.html } })),
      parse: checked(templateData),
      upsert: (id, d) => {
        const t = d as z.output<typeof templateData>
        const have = store.listTemplates().find((x) => x.id === id)
        store.putTemplate({ id, ...t, attachments: have?.attachments ?? [], updatedAt: Date.now() })
        return true
      },
      remove: (id) => store.deleteTemplate(id)
    },
    {
      type: 'deal',
      list: () => {
        const emails = accountEmails(store)
        return store.listDeals().flatMap((d) => {
          const account = emails.get(d.accountId)
          if (!account) return []
          const rfcId = d.messageId ? (store.rfcIdOfMessage(d.messageId) ?? null) : null
          const { id, accountId: _a, messageId: _m, ...rest } = d
          return [{ id, data: { account, rfcId, ...rest } }]
        })
      },
      parse: checked(dealData),
      upsert: (id, d) => {
        const { account, rfcId, ...rest } = d as z.output<typeof dealData>
        const accountId = store.accountIdForEmail(account)
        if (!accountId) return 'later'
        // The message a deal started from may not have been downloaded here; keep a link that is already there.
        const messageId = (rfcId ? store.messageIdForRfc(accountId, rfcId) : undefined) ?? store.getDeal(id)?.messageId ?? null
        store.putDeal({ id, accountId, messageId, ...rest })
        return true
      },
      remove: (id) => store.deleteDeal(id)
    },
    {
      type: 'messageLabel',
      list: () =>
        store.messageLabelRows().flatMap((r) => {
          const id = key(r.email, r.rfcId, r.labelId)
          return id ? [{ id, data: { on: true } }] : []
        }),
      parse: (d) => (d && typeof d === 'object' ? d : null),
      upsert: (id) => {
        const [email, rfcId, labelId] = split(id)
        const accountId = email ? store.accountIdForEmail(email) : undefined
        if (!accountId || !rfcId || !labelId) return 'later'
        // The label itself syncs first; if it is not here yet, this waits for it.
        return store.putMessageLabel(accountId, rfcId, labelId) ? true : 'later'
      },
      remove: (id) => {
        const [email, rfcId, labelId] = split(id)
        const accountId = email ? store.accountIdForEmail(email) : undefined
        if (accountId && rfcId && labelId) store.removeMessageLabel(accountId, rfcId, labelId)
      }
    },
    {
      type: 'snooze',
      list: () =>
        store.snoozeRows().flatMap((r) => {
          const id = key(r.email, r.rfcId)
          return id ? [{ id, data: { until: r.until } }] : []
        }),
      parse: checked(z.object({ until: z.number() })),
      upsert: (id, d) => {
        const message = messageFor(store, id)
        if (message === null) return 'later'
        store.snooze(message, (d as { until: number }).until)
        return true
      },
      remove: (id) => {
        const message = messageFor(store, id)
        if (message) store.unsnooze(message)
      }
    },
    {
      type: 'followUp',
      list: () =>
        store.followUpRows().flatMap((r) => {
          const id = key(r.email, r.rfcId)
          return id ? [{ id, data: { due: r.due, fired: r.fired } }] : []
        }),
      parse: checked(z.object({ due: z.number(), fired: z.boolean() })),
      upsert: (id, d) => {
        const message = messageFor(store, id)
        if (message === null) return 'later'
        const f = d as { due: number; fired: boolean }
        store.putFollowUp(message, f.due, f.fired)
        return true
      },
      remove: (id) => {
        const message = messageFor(store, id)
        if (message) store.clearFollowUp(message)
      }
    },
    {
      type: 'meeting',
      list: () => {
        const emails = accountEmails(store)
        return store.allEvents().flatMap((e) => {
          const account = emails.get(e.accountId)
          const id = account ? key(account, e.uid, e.recurrenceId === null ? '' : String(e.recurrenceId)) : null
          if (!id) return []
          return [
            {
              id,
              data: {
                sequence: e.sequence,
                summary: e.summary,
                description: e.description,
                location: e.location,
                start: e.start,
                end: e.end,
                allDay: e.allDay,
                rrule: e.rrule,
                exdates: e.exdates,
                organizer: e.organizer,
                attendees: e.attendees,
                status: e.status,
                onlineUrl: e.onlineUrl,
                free: e.free,
                myResponse: e.myResponse,
                mine: e.mine
              }
            }
          ]
        })
      },
      parse: checked(meetingData),
      upsert: (id, d) => {
        const [email, uid, rec] = split(id)
        const accountId = email ? store.accountIdForEmail(email) : undefined
        if (!accountId || !uid) return 'later'
        const recurrenceId = rec ? Number(rec) : null
        const have = store.eventsByUid(accountId, uid).find((e) => e.recurrenceId === recurrenceId)
        const m = d as z.output<typeof meetingData>
        // A newer version of this meeting arrived here by email: it stands, and goes out to the others instead.
        if (have && have.sequence > m.sequence) return false
        store.putEvent({ ...m, id: have?.id ?? randomUUID(), accountId, uid, recurrenceId, repeats: have?.repeats ?? null, messageId: null, updatedAt: Date.now() })
        return true
      },
      remove: (id) => {
        const [email, uid, rec] = split(id)
        const accountId = email ? store.accountIdForEmail(email) : undefined
        if (!accountId || !uid) return
        const recurrenceId = rec ? Number(rec) : null
        const have = store.eventsByUid(accountId, uid).find((e) => e.recurrenceId === recurrenceId)
        if (have) store.deleteEvent(have.id)
      }
    },
    {
      type: 'pref',
      list: () => [
        { id: 'app', data: prefs.getApp() },
        { id: 'notifications', data: prefs.getNotifications() }
      ],
      parse: (d) => (d && typeof d === 'object' ? d : null),
      upsert: (id, d) => {
        if (id === 'app') {
          const r = appPrefsSchema.safeParse(d)
          if (r.success) prefs.setApp(r.data)
          return r.success
        }
        if (id === 'notifications') {
          const r = notificationSettingsSchema.safeParse(d)
          if (r.success) prefs.setNotifications(r.data)
          return r.success
        }
        return false
      },
      // Choices are never deleted, only changed.
      remove: () => {}
    }
  ]
}

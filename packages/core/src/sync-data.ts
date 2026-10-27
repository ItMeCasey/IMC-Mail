import { z } from 'zod'
import { calendarEventSchema, dealStageSchema, notificationSettingsSchema, ruleInputSchema } from './schemas'
import type { SyncType } from './sync-merge'

// What each kind of synced item holds, and how to check it. The desktop and the phone both use these, so an item
// that one accepts is one the other can read.

/** Separates the parts of a synced id. It cannot appear in an address, a Message-ID or a uid. */
export const SYNC_SEP = '\u001f'
/** A synced id must fit the protocol's limit; the rare longer one is simply not synced. */
const MAX_ID = 190

/** An id built from an account's address and what the item belongs to, or null if it is too long to sync. */
export const syncKey = (...parts: string[]): string | null => {
  const id = parts.join(SYNC_SEP)
  return id.length <= MAX_ID ? id : null
}
export const splitSyncKey = (id: string): string[] => id.split(SYNC_SEP)

/** The app choices that follow you to other devices. Window and tray behavior stay per computer. */
export const appPrefsSchema = z.object({
  streamerFeatures: z.boolean(),
  showHolidays: z.boolean(),
  holidayCountry: z.string().regex(/^[A-Z]{2}$/),
  meetingReminders: z.boolean(),
  reminderLeadMinutes: z.number().int().min(1).max(120),
  holidayReminders: z.boolean()
})
export type AppPrefs = z.infer<typeof appPrefsSchema>

export const dealData = z.object({
  account: z.string().min(3).max(320),
  rfcId: z.string().max(998).nullable(),
  brand: z.string().trim().min(1).max(120),
  stage: dealStageSchema,
  rate: z.number().nullable(),
  currency: z.string().length(3),
  deliverables: z.string().max(2000),
  dueDate: z.number().nullable(),
  notes: z.string().max(5000),
  createdAt: z.number(),
  updatedAt: z.number(),
  paidAt: z.number().nullable()
})
export type DealData = z.infer<typeof dealData>

export const meetingData = calendarEventSchema
  .pick({ sequence: true, summary: true, description: true, location: true, start: true, end: true, allDay: true, rrule: true, organizer: true, attendees: true, status: true, onlineUrl: true, myResponse: true, mine: true })
  .extend({ exdates: z.array(z.number()).max(1000), free: z.boolean() })
export type MeetingData = z.infer<typeof meetingData>

export const labelData = z.object({ name: z.string().trim().min(1).max(200) })
export const searchData = z.object({ name: z.string().trim().min(1).max(200), query: z.string().trim().min(1).max(500) })
export const templateData = z.object({ name: z.string().max(200), subject: z.string().max(1000), html: z.string().max(60_000) })
export const snoozeData = z.object({ until: z.number() })
export const followUpData = z.object({ due: z.number(), fired: z.boolean() })
/** A label on a message carries nothing but the fact that it is there. */
export const messageLabelData = z.object({}).passthrough()

/**
 * Checks what came from another device for this kind of item and id. Returns what to keep, or null if it cannot be used.
 * Preferences are the one kind that is not a list: they have two items, "app" and "notifications".
 */
export function parseSyncData(type: SyncType, id: string, data: unknown): unknown | null {
  const schema = (() => {
    switch (type) {
      case 'label':
        return labelData
      case 'rule':
        return ruleInputSchema
      case 'savedSearch':
        return searchData
      case 'template':
        return templateData
      case 'deal':
        return dealData
      case 'messageLabel':
        return messageLabelData
      case 'snooze':
        return snoozeData
      case 'followUp':
        return followUpData
      case 'meeting':
        return meetingData
      case 'pref':
        return id === 'app' ? appPrefsSchema : id === 'notifications' ? notificationSettingsSchema : null
      default:
        return null
    }
  })()
  if (!schema) return null
  const r = schema.safeParse(data)
  return r.success ? r.data : null
}

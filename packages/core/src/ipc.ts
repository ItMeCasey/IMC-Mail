import { z } from 'zod'
import {
  accountSchema,
  calendarEventSchema,
  calendarOccurrenceSchema,
  calendarResponseSchema,
  meetingInputSchema,
  categorySchema,
  dealPatchSchema,
  dealSchema,
  attachmentPreviewSchema,
  labelSchema,
  undoMoveSchema,
  viewCountsSchema,
  contactSchema,
  draftAttachmentSchema,
  draftSchema,
  draftSummarySchema,
  folderSchema,
  imapAccountInputSchema,
  messageQuerySchema,
  messageActionSchema,
  messageDetailSchema,
  messageSummarySchema,
  oauthProviderIdSchema,
  outboxItemSchema,
  replyContextSchema,
  replyModeSchema,
  notificationSettingsSchema,
  streamSafeModeSchema,
  templateInputSchema,
  templateSchema,
  streamSafeStateSchema,
  threadSchema
} from './schemas'

/**
 * Single source of truth for renderer <-> main calls.
 * Each entry is validated with zod on both sides of the bridge.
 */
export const ipcContract = {
  'app:info': {
    input: z.undefined(),
    output: z.object({
      version: z.string(),
      platform: z.string(),
      schemaVersion: z.number().int()
    })
  },
  'app:ping': {
    input: z.object({ message: z.string().max(200) }),
    output: z.object({ reply: z.string(), at: z.number() })
  },
  'accounts:list': {
    input: z.undefined(),
    output: z.array(accountSchema)
  },
  /** Connects and logs in without saving anything. */
  'accounts:test': {
    input: imapAccountInputSchema,
    output: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), folders: z.number().int() }),
      z.object({ ok: z.literal(false), error: z.string() })
    ])
  },
  'accounts:add': {
    input: imapAccountInputSchema,
    output: accountSchema
  },
  /** Which OAuth providers have a client ID configured on this machine. */
  'oauth:status': {
    input: z.undefined(),
    output: z.object({ gmail: z.boolean(), microsoft: z.boolean() })
  },
  /** Opens the system browser, waits for sign-in, then adds the account. */
  'accounts:addOAuth': {
    input: z.object({ provider: oauthProviderIdSchema }),
    output: accountSchema
  },
  'oauth:cancel': {
    input: z.undefined(),
    output: z.undefined()
  },
  'accounts:remove': {
    input: z.object({ id: z.string() }),
    output: z.undefined()
  },
  'accounts:resync': {
    input: z.object({ id: z.string() }),
    output: z.undefined()
  },
  'folders:list': {
    input: z.undefined(),
    output: z.array(folderSchema)
  },
  'messages:list': {
    input: messageQuerySchema,
    output: z.array(messageSummarySchema)
  },
  /** Hides a message until the given time (epoch ms), when it returns as unread. null brings it back now. */
  'messages:snooze': {
    input: z.object({ id: z.string(), until: z.number().int().nullable() }),
    output: z.undefined()
  },
  /** Reminds you at the given time (epoch ms) if nobody has replied to a message you sent. null clears it. */
  'messages:followUp': {
    input: z.object({ id: z.string(), at: z.number().int().nullable() }),
    output: z.undefined()
  },
  /** Tells the scam shield a message is fine (or undoes that). */
  'messages:markSafe': {
    input: z.object({ id: z.string(), safe: z.boolean() }),
    output: z.undefined()
  },
  'messages:setCategory': {
    input: z.object({ id: z.string(), category: categorySchema.nullable() }),
    output: z.undefined()
  },
  /** Counts for the sidebar's smart views. */
  'views:counts': {
    input: z.undefined(),
    output: viewCountsSchema
  },
  /** Asks where to save, then writes every deal as a CSV file for a spreadsheet or an accountant. */
  'deals:exportCsv': {
    input: z.undefined(),
    output: z.object({ saved: z.string().nullable() })
  },
  'deals:list': {
    input: z.undefined(),
    output: z.array(dealSchema)
  },
  /** Starts a deal, prefilled from a message (brand from the sender, due date left empty). */
  'deals:create': {
    input: z.object({ messageId: z.string().optional(), accountId: z.string().optional(), patch: dealPatchSchema.optional() }),
    output: dealSchema
  },
  'deals:update': {
    input: z.object({ id: z.string(), patch: dealPatchSchema }),
    output: dealSchema
  },
  'deals:delete': {
    input: z.object({ id: z.string() }),
    output: z.undefined()
  },
  /** Searches the local cache. See apps/desktop/src/main/search.ts for the query language. */
  'messages:search': {
    input: z.object({ q: z.string().max(300) }),
    output: z.array(messageSummarySchema)
  },
  /** The conversation containing this message; downloads the selected message's body if needed. */
  'messages:open': {
    input: z.object({ id: z.string() }),
    output: threadSchema
  },
  /** Downloads and caches one message body (used when expanding older messages in a thread). */
  'messages:loadBody': {
    input: z.object({ id: z.string() }),
    output: messageDetailSchema
  },
  'messages:setFlags': {
    input: z.object({
      id: z.string(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional()
    }),
    output: z.undefined()
  },
  /**
   * Moves a message out of its folder: archive, trash, junk, or into a chosen folder of the same
   * account. deleteForever erases it from the server for good.
   */
  'messages:act': {
    input: z.object({
      id: z.string(),
      action: messageActionSchema,
      /** Required for action 'move': a folder of the message's own account. */
      folderId: z.string().optional()
    }),
    /** How to undo it; null for deleting forever, which cannot be undone. */
    output: z.object({ undo: undoMoveSchema.nullable() })
  },
  /** Puts a message moved by 'messages:act' back where it was. */
  'messages:undoMove': {
    input: undoMoveSchema,
    output: z.undefined()
  },
  /** Remember to always load remote images for this sender. */
  'senders:allowImages': {
    input: z.object({ address: z.string().min(3).max(320) }),
    output: z.undefined()
  },
  'accounts:setSignature': {
    input: z.object({ id: z.string(), signature: z.string().max(2000) }),
    output: z.undefined()
  },
  /** Quoted context for replying to or forwarding a message. */
  'compose:replyContext': {
    input: z.object({ messageId: z.string(), mode: replyModeSchema }),
    output: replyContextSchema
  },
  /** Vets files and returns them as attachments; with no paths, shows a file picker. */
  'compose:attach': {
    input: z.object({ paths: z.array(z.string()).max(50).optional() }),
    output: z.array(draftAttachmentSchema)
  },
  /** Queues the message. It goes out after the undo window unless compose:undo is called. */
  'compose:send': {
    input: draftSchema.extend({
      /** Epoch ms to send at; omit to send after the undo window. */
      sendAt: z.number().int().optional()
    }),
    output: z.object({ outboxId: z.string(), sendAt: z.number() })
  },
  /** Cancels a queued or failed send and returns the draft so it can be edited again. */
  'compose:undo': {
    input: z.object({ outboxId: z.string() }),
    output: draftSchema.nullable()
  },
  'compose:saveDraft': {
    input: draftSchema,
    output: z.object({ id: z.string() })
  },
  'compose:drafts': {
    input: z.undefined(),
    output: z.array(draftSummarySchema)
  },
  'compose:loadDraft': {
    input: z.object({ id: z.string() }),
    output: draftSchema.nullable()
  },
  'compose:discardDraft': {
    input: z.object({ id: z.string() }),
    output: z.undefined()
  },
  'contacts:search': {
    input: z.object({ q: z.string().max(100) }),
    output: z.array(contactSchema)
  },
  'outbox:list': {
    input: z.undefined(),
    output: z.array(outboxItemSchema)
  },
  /** Accept, tentatively accept, or decline the meeting invitation on a message. */
  'calendar:respond': {
    input: z.object({ messageId: z.string(), response: calendarResponseSchema, comment: z.string().max(1000).optional() }),
    output: calendarEventSchema
  },
  /** Meetings in a time range, repeating ones expanded. Declined and cancelled meetings are left out. */
  'calendar:list': {
    input: z.object({ from: z.number(), to: z.number() }),
    output: z.array(calendarOccurrenceSchema)
  },
  /** Creates a meeting and emails the invitation to the attendees. */
  'calendar:schedule': {
    input: meetingInputSchema,
    output: calendarEventSchema
  },
  /** Changes a meeting you organize and emails the update. */
  'calendar:update': {
    input: z.object({ id: z.string(), patch: meetingInputSchema.partial().omit({ accountId: true }) }),
    output: calendarEventSchema
  },
  /** Cancels a meeting you organize and emails the cancellation. */
  'calendar:cancel': {
    input: z.object({ id: z.string() }),
    output: calendarEventSchema
  },
  /** Asks where to save, then writes the meeting as an .ics file Outlook and others can open. */
  'calendar:exportIcs': {
    input: z.object({ id: z.string() }),
    output: z.object({ saved: z.string().nullable() })
  },
  'templates:list': {
    input: z.undefined(),
    output: z.array(templateSchema)
  },
  'templates:save': {
    input: templateInputSchema,
    output: templateSchema
  },
  'templates:delete': {
    input: z.object({ id: z.string() }),
    output: z.undefined()
  },
  'notifications:get': {
    input: z.undefined(),
    output: notificationSettingsSchema
  },
  'notifications:set': {
    input: notificationSettingsSchema.partial(),
    output: notificationSettingsSchema
  },
  /** Shows a sample notification so you can see what one looks like right now. */
  'notifications:test': {
    input: z.undefined(),
    output: z.object({ shown: z.boolean(), reason: z.string().nullable() })
  },
  'streamsafe:get': {
    input: z.undefined(),
    output: streamSafeStateSchema
  },
  'streamsafe:set': {
    input: z.object({
      mode: streamSafeModeSchema.optional(),
      hideFromCapture: z.boolean().optional(),
      watch: z.array(z.string().trim().toLowerCase().min(1).max(100)).max(50).optional()
    }),
    output: streamSafeStateSchema
  },
  /** Flips stream-safe mode for now (what the global hotkey does). */
  'streamsafe:toggle': {
    input: z.undefined(),
    output: streamSafeStateSchema
  },
  /** Asks where to save, then writes the attachment. `saved` is the path, or null if cancelled. */
  /** An image or text attachment shown in the app. Other kinds come back as { kind: 'none' }. */
  'attachments:preview': {
    input: z.object({ messageId: z.string(), attachmentId: z.string() }),
    output: attachmentPreviewSchema
  },
  /** Downloads the next batch of older messages in a folder (headers only; bodies load when opened). */
  'folders:loadOlder': {
    input: z.object({ folderId: z.string() }),
    output: z.object({ loaded: z.number().int(), more: z.boolean() })
  },
  /** Your labels, with how many messages carry each. Labels live on this computer only. */
  'labels:list': { input: z.undefined(), output: z.array(labelSchema) },
  'labels:create': {
    input: z.object({ name: z.string().trim().min(1).max(40) }),
    output: labelSchema
  },
  'labels:delete': { input: z.object({ id: z.string() }), output: z.undefined() },
  /** Replaces the labels on a message. They follow it when it moves between folders. */
  'messages:setLabels': {
    input: z.object({ id: z.string(), labelIds: z.array(z.string()).max(50) }),
    output: z.undefined()
  },
  'attachments:save': {
    input: z.object({ messageId: z.string(), attachmentId: z.string() }),
    output: z.object({ saved: z.string().nullable() })
  }
} as const

/** Main -> renderer pushes. */
export const ipcEvents = {
  /** Something in the local cache changed for this account. */
  'sync:changed': z.object({ accountId: z.string() }),
  /** The outbox changed: a message was queued, sent, failed, or undone. */
  'outbox:changed': z.object({}),
  'streamsafe:changed': streamSafeStateSchema,
  /** A notification was clicked: open this message. */
  'notification:open': z.object({ messageId: z.string() })
} as const

export type IpcContract = typeof ipcContract
export type IpcChannel = keyof IpcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>

export type IpcEvents = typeof ipcEvents
export type IpcEvent = keyof IpcEvents
export type IpcEventPayload<E extends IpcEvent> = z.output<IpcEvents[E]>

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[]
export const ipcEventNames = Object.keys(ipcEvents) as IpcEvent[]

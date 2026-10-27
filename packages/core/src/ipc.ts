import { z } from 'zod'
import {
  accountSchema,
  calendarEventSchema,
  calendarOccurrenceSchema,
  calendarSourceSchema,
  calendarResponseSchema,
  meetingInputSchema,
  categorySchema,
  dealPatchSchema,
  dealSchema,
  attachmentPreviewSchema,
  labelSchema,
  savedSearchSchema,
  updateStatusSchema,
  mediaKitSchema,
  ruleInputSchema,
  ruleSchema,
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
export const syncStatusSchema = z.object({
  paired: z.boolean(),
  server: z.string(),
  deviceName: z.string(),
  lastSyncAt: z.number().nullable(),
  error: z.string().nullable(),
  syncing: z.boolean(),
  revoked: z.boolean()
})

/** What to show to pair a device: the code to type or paste, and the same code as a QR image. */
const pairingViewSchema = z.object({ code: z.string(), qr: z.string() })

/** Things the settings window hands to the main window: dialogs that live there. */
const settingsActionSchema = z.object({
  kind: z.enum(['rules', 'notifications', 'report', 'addAccount', 'removeAccount']),
  accountId: z.string().optional()
})

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
  /** Creates a folder on the mail server. With parentId it goes inside that folder. */
  'folders:create': {
    input: z.object({ accountId: z.string(), parentId: z.string().optional(), name: z.string().max(200) }),
    output: z.object({ folderId: z.string() })
  },
  /** Renames a folder on the mail server, keeping it inside the same parent. Standard folders are refused. */
  'folders:rename': {
    input: z.object({ folderId: z.string(), name: z.string().max(200) }),
    output: z.undefined()
  },
  /** Deletes a folder from the mail server, and the messages in it. Standard folders and folders with subfolders are refused. */
  'folders:delete': {
    input: z.object({ folderId: z.string() }),
    output: z.undefined()
  },
  /** Marks every message in the account's Inbox read or unread, on the server and here. */
  'accounts:markAll': {
    input: z.object({ id: z.string(), seen: z.boolean() }),
    output: z.object({ changed: z.number().int() })
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
  /** Changes how an account is named in the sidebar and as the sender name on mail you send. */
  'accounts:rename': {
    input: z.object({ id: z.string(), displayName: z.string().trim().max(80) }),
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
  /** Which accounts can show their own calendar here, and how that is going. */
  'calendar:sources': { input: z.undefined(), output: z.array(calendarSourceSchema) },
  /** Opens the provider's page to allow calendar access, then reads the calendar. Resolves when that is done. */
  'calendar:connect': {
    input: z.object({ accountId: z.string() }),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() })
  },
  /** Reads the calendar again now (every connected account when no id is given). */
  'calendar:syncNow': { input: z.object({ accountId: z.string().optional() }), output: z.undefined() },
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
  /** Searches you saved, in the order you made them. */
  'searches:list': { input: z.undefined(), output: z.array(savedSearchSchema) },
  'searches:save': {
    input: z.object({ name: z.string().trim().min(1).max(60), query: z.string().trim().min(1).max(500) }),
    output: savedSearchSchema
  },
  'searches:delete': { input: z.object({ id: z.string() }), output: z.undefined() },
  /** Rules that sort new inbox mail: label, categorize, mark read, star or archive. */
  'rules:list': { input: z.undefined(), output: z.array(ruleSchema) },
  'rules:save': { input: ruleInputSchema, output: ruleSchema },
  'rules:delete': { input: z.object({ id: z.string() }), output: z.undefined() },
  /** Applies one rule to the newest 500 inbox messages. Returns how many matched. */
  'rules:run': { input: z.object({ id: z.string() }), output: z.object({ matched: z.number().int() }) },
  /** The media kit or rate card you attach to replies; null if none is set or the file is gone. */
  'mediaKit:get': { input: z.undefined(), output: mediaKitSchema.nullable() },
  /** Asks you to pick the file. null if you cancel. */
  'mediaKit:choose': { input: z.undefined(), output: mediaKitSchema.nullable() },
  'mediaKit:clear': { input: z.undefined(), output: z.undefined() },
  /** Minimize, maximize, restore or close the window (it has no frame of its own). */
  'window:control': {
    input: z.object({ action: z.enum(['minimize', 'maximize', 'restore', 'close']) }),
    output: z.undefined()
  },
  'window:bounds': {
    input: z.undefined(),
    output: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), maximized: z.boolean() })
  },
  /** Moves or resizes the window (used by the drag handles on its edges). */
  'window:setBounds': {
    input: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    output: z.undefined()
  },
  /** Saves your labels, rules, saved searches, reply templates and notification choices to a file. No accounts or mail. */
  'settings:export': { input: z.undefined(), output: z.object({ saved: z.string().nullable() }) },
  /** Adds what a settings file has that you do not. null if you cancel. Importing twice changes nothing. */
  'settings:import': {
    input: z.undefined(),
    output: z
      .object({
        added: z.object({ labels: z.number().int(), rules: z.number().int(), savedSearches: z.number().int(), templates: z.number().int() }),
        skipped: z.number().int(),
        settingsApplied: z.boolean()
      })
      .nullable()
  },
  /** Recent errors kept on this computer, and whether any are new since you were last asked about them. */
  'report:summary': {
    input: z.undefined(),
    output: z.object({ errors: z.number().int(), hasNew: z.boolean(), relay: z.boolean() })
  },
  /** The exact title and text of the GitHub issue that would be opened. */
  'report:preview': {
    input: z.object({ note: z.string().max(5000), includeErrors: z.boolean() }),
    output: z.object({ title: z.string(), body: z.string() })
  },
  /** Posts the report to the project's relay, which files it as a GitHub issue. Throws with a plain reason if it cannot. */
  'report:send': {
    input: z.object({ note: z.string().max(5000), includeErrors: z.boolean() }),
    output: z.object({ url: z.string(), duplicate: z.boolean() })
  },
  /** Opens the pre-filled GitHub issue in your browser. You review and submit it there. */
  'report:open': {
    input: z.object({ note: z.string().max(5000), includeErrors: z.boolean() }),
    output: z.undefined()
  },
  /** "Not now": stop asking about the errors seen so far. */
  'report:dismiss': { input: z.undefined(), output: z.undefined() },
  /** Where the update check stands. Updates come from the project's GitHub Releases. */
  'update:status': { input: z.undefined(), output: updateStatusSchema },
  'update:check': { input: z.undefined(), output: z.undefined() },
  /** Restarts into a downloaded update. */
  'update:install': { input: z.undefined(), output: z.undefined() },
  /** App-wide choices kept on this computer. */
  'app:prefs': {
    input: z.undefined(),
    output: z.object({
      closeToTray: z.boolean(),
      showLogos: z.boolean(),
      streamerFeatures: z.boolean(),
      showHolidays: z.boolean(),
      holidayCountry: z.string(),
      meetingReminders: z.boolean(),
      reminderLeadMinutes: z.number(),
      holidayReminders: z.boolean()
    })
  },
  /**
   * `streamerFeatures` off hides stream-safe mode, the sponsorship board and mail categories: a plain mail client.
   * `meetingReminders` and `holidayReminders` show Windows toasts, a meeting one `reminderLeadMinutes` ahead.
   * `showHolidays` puts the public holidays of `holidayCountry` (an ISO 3166 code such as US or GB) in the calendar.
   */
  'app:setPrefs': {
    input: z.object({
      closeToTray: z.boolean().optional(),
      showLogos: z.boolean().optional(),
      streamerFeatures: z.boolean().optional(),
      showHolidays: z.boolean().optional(),
      holidayCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
      meetingReminders: z.boolean().optional(),
      reminderLeadMinutes: z.number().int().min(1).max(120).optional(),
      holidayReminders: z.boolean().optional()
    }),
    output: z.undefined()
  },
  /** Whether this computer syncs its settings with your other devices, and how the last round went. */
  'sync:status': { input: z.undefined(), output: syncStatusSchema },
  /** Turns sync on from this computer and returns the pairing code (as text and as a QR image) for the phone to scan. */
  'sync:enable': { input: z.object({ deviceName: z.string().trim().min(1).max(60).optional() }), output: pairingViewSchema },
  /** The pairing code again, to add another device. Null when this computer is not syncing. */
  'sync:pairing': { input: z.undefined(), output: pairingViewSchema.nullable() },
  /** Joins a group another device made, from its pairing code. */
  'sync:join': { input: z.object({ code: z.string().max(4000), deviceName: z.string().trim().min(1).max(60).optional() }), output: syncStatusSchema },
  /**
   * Replaces the key: ends the sync group on the server and starts a new one with a fresh key, sending everything again.
   * Other devices stop syncing until they join with the returned code. Also moves an older group to hashed record names.
   */
  'sync:rotate': { input: z.undefined(), output: pairingViewSchema },
  'sync:now': { input: z.undefined(), output: syncStatusSchema },
  'sync:devices': {
    input: z.undefined(),
    output: z.array(z.object({ id: z.string(), name: z.string(), createdAt: z.number(), lastSeen: z.number(), current: z.boolean() }))
  },
  'sync:removeDevice': { input: z.object({ id: z.string() }), output: z.undefined() },
  /** Stops syncing on this computer. Settings already here stay. */
  'sync:disable': { input: z.undefined(), output: z.undefined() },
  /** Opens the settings window, or brings it forward if it is already open. */
  'settings:open': { input: z.undefined(), output: z.undefined() },
  /** Asks the main window to open something that lives there (the settings window has no room for it). */
  'settings:action': { input: settingsActionSchema, output: z.undefined() },
  /** Title bar buttons of the settings window. */
  'settings:control': {
    input: z.object({ action: z.enum(['minimize', 'close']) }),
    output: z.undefined()
  },
  /**
   * Company logos for sender domains, as inline pictures (null where a domain has none). Empty while `showLogos` is off.
   * The logos come from a favicon service, which sees the domains asked about.
   */
  'logos:get': {
    input: z.object({ domains: z.array(z.string().max(253)).max(80) }),
    output: z.record(z.string(), z.string().nullable())
  },
  /** Public holidays on days from `from` up to `to` (epoch ms) for the chosen country. Empty while holidays are off. */
  'calendar:holidays': {
    input: z.object({ from: z.number(), to: z.number() }),
    output: z.array(z.object({ date: z.string(), name: z.string() }))
  },
  /** Countries that have holiday data, by name. */
  'calendar:holidayCountries': {
    input: z.undefined(),
    output: z.array(z.object({ code: z.string(), name: z.string() }))
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
  /** Opens a PDF attachment in the computer's PDF viewer (after checking it really is a PDF). */
  'attachments:open': {
    input: z.object({ messageId: z.string(), attachmentId: z.string() }),
    output: z.object({ opened: z.boolean() })
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
  'window:state': z.object({ maximized: z.boolean() }),
  'update:changed': updateStatusSchema,
  /** A notification was clicked: open this message. */
  'notification:open': z.object({ messageId: z.string() }),
  /** Settings from another device arrived and changed something here. */
  'sync:applied': z.object({}),
  /** A reminder was clicked: open the calendar. */
  'notification:calendar': z.object({}),
  /** The settings window wants the main window to open a dialog. */
  'settings:action': settingsActionSchema
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

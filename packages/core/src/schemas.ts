import { z } from 'zod'
import { safeWebUrl } from './url'

// ---- Smart categories -----------------------------------------------------------

export const categorySchema = z.enum([
  'sponsorship',
  'collab',
  'platform',
  'fan',
  'invoice',
  'cold',
  'other'
])
export type Category = z.infer<typeof categorySchema>

export const CATEGORY_LABELS: Record<Category, string> = {
  sponsorship: 'Sponsorship',
  collab: 'Collab',
  platform: 'Platform',
  fan: 'Fan mail',
  invoice: 'Invoice',
  cold: 'Cold outreach',
  other: 'Other'
}

export const riskLevelSchema = z.enum(['none', 'caution', 'danger'])
export const riskSchema = z.object({
  level: riskLevelSchema,
  reasons: z.array(z.object({ code: z.string(), level: z.enum(['caution', 'danger']), text: z.string() }))
})

export const calendarResponseSchema = z.enum(['accepted', 'tentative', 'declined'])
export type CalendarResponse = z.infer<typeof calendarResponseSchema>

export const calendarPersonSchema = z.object({ name: z.string(), email: z.string() })

export const calendarEventSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  uid: z.string(),
  sequence: z.number().int(),
  recurrenceId: z.number().nullable(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  start: z.number(),
  end: z.number(),
  allDay: z.boolean(),
  rrule: z.string().nullable(),
  /** The repeat rule in words, e.g. "Every week on Monday". */
  repeats: z.string().nullable(),
  organizer: calendarPersonSchema.nullable(),
  attendees: z.array(
    calendarPersonSchema.extend({ partstat: z.string(), role: z.string(), rsvp: z.boolean() })
  ),
  status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']),
  onlineUrl: z.string().nullable(),
  /** Your answer, or null if you have not replied. */
  myResponse: calendarResponseSchema.nullable(),
  /** You are the organizer (you sent the invitation). */
  mine: z.boolean(),
  messageId: z.string().nullable(),
  /** Read from the account's own calendar: shown, but changed there, not here. */
  readOnly: z.boolean()
})
export type CalendarEvent = z.infer<typeof calendarEventSchema>

/** An invitation as shown on the message that carried it. */
export const inviteSchema = z.object({
  event: calendarEventSchema,
  /** REQUEST, CANCEL or PUBLISH. */
  method: z.string(),
  /** Other accepted or tentative meetings that overlap this one. */
  conflicts: z.array(z.object({ summary: z.string(), start: z.number(), end: z.number() })),
  /** A newer version of this meeting has arrived; this message is out of date. */
  outdated: z.boolean()
})
export type Invite = z.infer<typeof inviteSchema>

export const providerSchema = z.enum(['gmail', 'microsoft', 'imap'])
export type Provider = z.infer<typeof providerSchema>

export const oauthProviderIdSchema = z.enum(['gmail', 'microsoft'])

export const securitySchema = z.enum(['tls', 'starttls', 'none'])

/** Hosts on this computer, where unencrypted mail never crosses a network. */
export const isLocalHost = (host: string): boolean => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(host.trim())

export const serverSchema = z
  .object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    security: securitySchema
  })
  .refine((s) => s.security !== 'none' || isLocalHost(s.host), {
    message: 'Unencrypted connections would send your password in the clear. Choose TLS or STARTTLS.',
    path: ['security']
  })
export type ServerConfig = z.infer<typeof serverSchema>

export const syncStateSchema = z.enum(['connecting', 'syncing', 'idle', 'error'])
export type SyncState = z.infer<typeof syncStateSchema>

export const accountSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  email: z.string(),
  displayName: z.string(),
  color: z.string(),
  syncState: syncStateSchema,
  lastError: z.string().nullable(),
  /** Appended to new messages from this account. Plain text. */
  signature: z.string()
})
export type Account = z.infer<typeof accountSchema>

/** Password-based IMAP/SMTP account (app passwords for Gmail/Outlook until OAuth lands). */
export const imapAccountInputSchema = z.object({
  email: z.string().trim().email().max(255),
  displayName: z.string().trim().max(100).optional(),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
  imap: serverSchema,
  smtp: serverSchema
})
export type ImapAccountInput = z.infer<typeof imapAccountInputSchema>

export const folderRoleSchema = z.enum([
  'inbox',
  'sent',
  'drafts',
  'trash',
  'junk',
  'archive',
  'all',
  'starred'
])
export type FolderRole = z.infer<typeof folderRoleSchema>

export const folderSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  path: z.string(),
  name: z.string(),
  role: folderRoleSchema.nullable(),
  unread: z.number().int(),
  total: z.number().int()
})
export type Folder = z.infer<typeof folderSchema>

export const messageSummarySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  folderId: z.string(),
  uid: z.number().int(),
  fromName: z.string(),
  fromAddr: z.string(),
  subject: z.string(),
  date: z.number(),
  unread: z.boolean(),
  starred: z.boolean(),
  /** Messages in this conversation (1 = standalone). */
  threadSize: z.number().int(),
  category: categorySchema,
  risk: riskLevelSchema,
  /** When a snoozed message comes back; null for everything else. */
  snoozedUntil: z.number().nullable(),
  /** When you asked to be reminded if nobody replies; null if no reminder is set. */
  followUpAt: z.number().nullable(),
  /** The message carries a meeting invitation. */
  invite: z.boolean()
})
export type MessageSummary = z.infer<typeof messageSummarySchema>

export const attachmentSchema = z.object({
  /** Stable within a message: the attachment's position in the parsed MIME tree. */
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int(),
  inline: z.boolean()
})
export type Attachment = z.infer<typeof attachmentSchema>

/** What an attachment looks like without opening another program. */
export const attachmentPreviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), dataUrl: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string(), truncated: z.boolean() }),
  z.object({ kind: z.literal('none') })
])
export type AttachmentPreview = z.infer<typeof attachmentPreviewSchema>

export const messageDetailSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  folderId: z.string(),
  uid: z.number().int(),
  fromName: z.string(),
  fromAddr: z.string(),
  to: z.string(),
  cc: z.string(),
  subject: z.string(),
  date: z.number(),
  unread: z.boolean(),
  starred: z.boolean(),
  /** 'ready' = body cached locally; 'missing' = not downloaded yet; 'error' = last attempt failed. */
  bodyState: z.enum(['ready', 'missing', 'error']),
  error: z.string().nullable(),
  /** Plain-text snippet shown while collapsed. */
  snippet: z.string(),
  /** True when the HTML references remote images that are currently blocked. */
  blockedImages: z.number().int(),
  /** The sender is on the user's "always load images" list. */
  imagesAllowed: z.boolean(),
  attachments: z.array(attachmentSchema),
  category: categorySchema,
  /** True when you chose the category yourself rather than the rules. */
  categoryManual: z.boolean(),
  /** Scam-shield verdict; 'none' once you have marked the message safe. */
  risk: riskSchema,
  riskSafe: z.boolean(),
  snoozedUntil: z.number().nullable(),
  followUpAt: z.number().nullable(),
  /** Your own labels on this message (local to this app, not synced to the mail server). */
  labelIds: z.array(z.string()),
  invite: inviteSchema.nullable()
})
export type MessageDetail = z.infer<typeof messageDetailSchema>

export const threadSchema = z.object({
  subject: z.string(),
  selectedId: z.string(),
  /** Oldest first. */
  messages: z.array(messageDetailSchema)
})
export type Thread = z.infer<typeof threadSchema>

export const messageQuerySchema = z.object({
  /** Omit both to get the unified inbox across all accounts. */
  accountId: z.string().optional(),
  folderId: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
  /** A smart view: everything you owe a reply, or sent mail still waiting on one. */
  view: z.enum(['needsReply', 'waiting', 'suspicious', 'snoozed', 'followUp']).optional(),
  category: categorySchema.optional(),
  /** Only messages carrying this label, in any folder. */
  labelId: z.string().optional()
})

// ---- Compose ---------------------------------------------------------------

const recipients = z.array(z.string().trim().min(3).max(320)).max(200)

export const draftAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string().max(255),
  size: z.number().int(),
  /** A file the main process vetted when it was attached. */
  path: z.string()
})
export type DraftAttachment = z.infer<typeof draftAttachmentSchema>

/** A message waiting to be written, started from outside the app: a mailto: link, a file sent with "Mail this", or both. */
export const composeRequestSchema = z.object({
  to: z.array(z.string()).max(50),
  cc: z.array(z.string()).max(50),
  bcc: z.array(z.string()).max(50),
  subject: z.string().max(998),
  /** Plain text, with line breaks as \n. */
  body: z.string().max(50_000),
  attachments: z.array(draftAttachmentSchema).max(50)
})
export type ComposeRequest = z.infer<typeof composeRequestSchema>

export const draftSchema = z.object({
  /** Set once the draft has been saved locally. */
  id: z.string().optional(),
  accountId: z.string(),
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject: z.string().max(998),
  html: z.string().max(5_000_000),
  /** Message-ID of the message being replied to, with angle brackets. */
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).max(100).optional(),
  attachments: z.array(draftAttachmentSchema).max(50),
  /** Remind me if nobody replies within this many days of it being sent. */
  followUpDays: z.number().int().min(1).max(60).optional(),
  /** A meeting invitation or reply to send as a text/calendar part (iMIP). */
  ical: z
    .object({ method: z.enum(['REQUEST', 'REPLY', 'CANCEL']), content: z.string().max(200_000) })
    .optional()
})
export type Draft = z.infer<typeof draftSchema>

export const replyModeSchema = z.enum(['reply', 'replyAll', 'forward'])
export type ReplyMode = z.infer<typeof replyModeSchema>

export const replyContextSchema = z.object({
  accountId: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  /** The quoted original, already sanitized. */
  html: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string())
})
export type ReplyContext = z.infer<typeof replyContextSchema>

export const draftSummarySchema = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  to: z.array(z.string()),
  updatedAt: z.number()
})
export type DraftSummary = z.infer<typeof draftSummarySchema>

export const outboxItemSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string(),
  to: z.array(z.string()),
  state: z.enum(['queued', 'sending', 'sent', 'failed']),
  error: z.string().nullable(),
  /** Epoch ms when a queued message actually goes out; until then it can be undone. */
  sendAt: z.number(),
  createdAt: z.number(),
  /** Queued for a time you chose, rather than just riding out the undo window. */
  scheduled: z.boolean()
})
export type OutboxItem = z.infer<typeof outboxItemSchema>

export const contactSchema = z.object({ name: z.string(), address: z.string() })
export type Contact = z.infer<typeof contactSchema>

// ---- Stream-safe mode -------------------------------------------------------------

export const streamSafeModeSchema = z.enum(['auto', 'on', 'off'])
export type StreamSafeMode = z.infer<typeof streamSafeModeSchema>

export const streamSafeStateSchema = z.object({
  /** Whether private content is hidden right now. */
  active: z.boolean(),
  mode: streamSafeModeSchema,
  /** The hotkey flipped the state for now; clears when streaming software starts or stops. */
  overridden: z.boolean(),
  /** Name of the streaming program found running, if any. */
  detected: z.string().nullable(),
  /** While active, also keep the window out of screen capture and window capture. */
  hideFromCapture: z.boolean(),
  /** Program names (lowercase) that count as "streaming software is running". */
  watch: z.array(z.string())
})
export type StreamSafeState = z.infer<typeof streamSafeStateSchema>

// ---- Mail actions --------------------------------------------------------------

export const messageActionSchema = z.enum(['archive', 'trash', 'junk', 'move', 'deleteForever'])
export type MessageAction = z.infer<typeof messageActionSchema>

/** What it takes to put a moved message back: the server gives it a new id in its new folder, so it is found by Message-ID. */
export const undoMoveSchema = z.object({
  accountId: z.string(),
  messageId: z.string(),
  /** Where the message is now, and where it came from (IMAP paths). */
  from: z.string(),
  to: z.string(),
  /** Shown in the toast, e.g. "Archived". */
  label: z.string()
})
export type UndoMove = z.infer<typeof undoMoveSchema>

export const ruleMatchSchema = z.object({
  from: z.string().max(200).default(''),
  to: z.string().max(200).default(''),
  subject: z.string().max(200).default(''),
  contains: z.string().max(200).default('')
})
export const ruleActionsSchema = z.object({
  /** A label to add. */
  labelId: z.string().nullable().default(null),
  /** File it under this category, overriding the automatic one. */
  category: categorySchema.nullable().default(null),
  markRead: z.boolean().default(false),
  star: z.boolean().default(false),
  /** Move it out of the inbox to Archive. */
  archive: z.boolean().default(false)
})
export const ruleInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  match: ruleMatchSchema,
  actions: ruleActionsSchema
})
export const ruleSchema = ruleInputSchema.extend({ id: z.string() })
export type Rule = z.infer<typeof ruleSchema>
export type RuleInput = z.input<typeof ruleInputSchema>

export const mediaKitSchema = z.object({ path: z.string(), filename: z.string(), size: z.number().int() })
export type MediaKit = z.infer<typeof mediaKitSchema>

export const savedSearchSchema = z.object({
  id: z.string(),
  name: z.string(),
  query: z.string()
})
export type SavedSearch = z.infer<typeof savedSearchSchema>

export const updateStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unsupported'), message: z.string() }),
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('available'), version: z.string() }),
  z.object({ state: z.literal('downloaded'), version: z.string() }),
  z.object({ state: z.literal('error'), message: z.string() })
])
export type UpdateStatus = z.infer<typeof updateStatusSchema>

export const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Messages carrying it. */
  count: z.number().int()
})
export type Label = z.infer<typeof labelSchema>

export const viewCountsSchema = z.object({
  needsReply: z.number().int(),
  waiting: z.number().int(),
  suspicious: z.number().int(),
  snoozed: z.number().int(),
  followUp: z.number().int(),
  categories: z.array(z.object({ category: categorySchema, unread: z.number().int(), total: z.number().int() }))
})
export type ViewCounts = z.infer<typeof viewCountsSchema>

// ---- Sponsorship deals -------------------------------------------------------------

export const dealStageSchema = z.enum(['lead', 'negotiating', 'contracted', 'delivered', 'paid', 'passed'])
export type DealStage = z.infer<typeof dealStageSchema>

export const DEAL_STAGES: { id: DealStage; label: string }[] = [
  { id: 'lead', label: 'Lead' },
  { id: 'negotiating', label: 'Negotiating' },
  { id: 'contracted', label: 'Contracted' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'paid', label: 'Paid' },
  { id: 'passed', label: 'Passed' }
]

export const dealSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  /** The message the deal was started from, if it is still in the cache. */
  messageId: z.string().nullable(),
  brand: z.string(),
  stage: dealStageSchema,
  rate: z.number().nullable(),
  currency: z.string(),
  deliverables: z.string(),
  /** Epoch ms of the next deadline. */
  dueDate: z.number().nullable(),
  notes: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  paidAt: z.number().nullable()
})
export type Deal = z.infer<typeof dealSchema>

export const dealPatchSchema = z.object({
  brand: z.string().trim().min(1).max(120).optional(),
  stage: dealStageSchema.optional(),
  rate: z.number().min(0).max(1e9).nullable().optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  deliverables: z.string().max(2000).optional(),
  dueDate: z.number().nullable().optional(),
  notes: z.string().max(5000).optional()
})
export type DealPatch = z.infer<typeof dealPatchSchema>

// ---- Notifications -------------------------------------------------------------------

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Only these kinds of mail raise a notification. */
  categories: z.array(categorySchema),
  quietHours: z.object({ enabled: z.boolean(), start: clock, end: clock }),
  /**
   * While stream-safe mode is on: 'silent' shows nothing (notifications appear on screen and in
   * captures), 'generic' shows "New message" with no sender or subject.
   */
  whenStreamSafe: z.enum(['silent', 'generic'])
})
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>

// ---- Templates ------------------------------------------------------------------------

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** May contain {{variables}}. Empty means "leave the subject alone". */
  subject: z.string(),
  /** HTML, may contain {{variables}}. */
  html: z.string(),
  /** Files kept with the template (a media kit, a rate card). */
  attachments: z.array(draftAttachmentSchema),
  updatedAt: z.number()
})
export type Template = z.infer<typeof templateSchema>

export const templateInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  subject: z.string().max(998),
  html: z.string().max(200_000),
  attachments: z.array(draftAttachmentSchema).max(10)
})
export type TemplateInput = z.infer<typeof templateInputSchema>

export const meetingInputSchema = z.object({
  accountId: z.string(),
  summary: z.string().trim().min(1).max(200),
  location: z.string().max(500).default(''),
  description: z.string().max(5000).default(''),
  start: z.number(),
  end: z.number(),
  allDay: z.boolean().default(false),
  /** Addresses, optionally "Name <addr>". */
  attendees: z.array(z.string().trim().min(3).max(320)).min(1).max(100),
  onlineUrl: z
    .string()
    .max(2000)
    .refine((v) => v === '' || safeWebUrl(v) !== null, 'Use a full web address starting with http:// or https://')
    .nullable()
    .default(null),
  /** How a new meeting repeats. Left out on an edit, the series is unchanged. */
  repeat: z.enum(['none', 'daily', 'weekly', 'biweekly', 'monthly']).optional(),
  /** Occurrences in all, when it repeats. */
  repeatCount: z.number().int().min(2).max(200).optional()
})
export type MeetingInput = z.input<typeof meetingInputSchema>

/** An account whose own calendar can be shown (Microsoft and Google sign-ins). */
export const calendarSourceSchema = z.object({
  accountId: z.string(),
  email: z.string(),
  provider: z.enum(['gmail', 'microsoft']),
  /** Calendar access was allowed and the last read worked at least once. */
  connected: z.boolean(),
  syncedAt: z.number().nullable(),
  /** Why the last read failed, in plain words. */
  error: z.string().nullable()
})
export type CalendarSource = z.infer<typeof calendarSourceSchema>

export const calendarOccurrenceSchema = z.object({
  event: calendarEventSchema,
  start: z.number(),
  end: z.number()
})
export type CalendarOccurrence = z.infer<typeof calendarOccurrenceSchema>

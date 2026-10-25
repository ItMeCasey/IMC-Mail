import { z } from 'zod'

export const providerSchema = z.enum(['gmail', 'microsoft', 'imap'])
export type Provider = z.infer<typeof providerSchema>

export const oauthProviderIdSchema = z.enum(['gmail', 'microsoft'])

export const securitySchema = z.enum(['tls', 'starttls', 'none'])

export const serverSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  security: securitySchema
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
  lastError: z.string().nullable()
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
  threadSize: z.number().int()
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
  attachments: z.array(attachmentSchema)
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
  offset: z.number().int().min(0).default(0)
})

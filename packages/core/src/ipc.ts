import { z } from 'zod'
import {
  accountSchema,
  folderSchema,
  imapAccountInputSchema,
  messageQuerySchema,
  messageDetailSchema,
  messageSummarySchema,
  oauthProviderIdSchema,
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
  /** Remember to always load remote images for this sender. */
  'senders:allowImages': {
    input: z.object({ address: z.string().min(3).max(320) }),
    output: z.undefined()
  },
  /** Asks where to save, then writes the attachment. `saved` is the path, or null if cancelled. */
  'attachments:save': {
    input: z.object({ messageId: z.string(), attachmentId: z.string() }),
    output: z.object({ saved: z.string().nullable() })
  }
} as const

/** Main -> renderer pushes. */
export const ipcEvents = {
  /** Something in the local cache changed for this account. */
  'sync:changed': z.object({ accountId: z.string() })
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

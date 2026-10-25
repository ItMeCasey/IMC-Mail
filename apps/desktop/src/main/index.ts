import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { oauthProviders, type Account } from '@imc/core'
import { Credentials } from './credentials'
import { openDb, type Db } from './db'
import { emit, registerIpc } from './ipc'
import { ComposeService, SmtpMailer } from './compose'
import { MessageService } from './messages'
import { loadOAuthConfig, signIn, TokenProvider } from './oauth'
import { safeStorageSecrets } from './secrets'
import { MailStore, type AccountRow } from './store'
import { testConnection } from './sync/engine'
import { SyncManager } from './sync/manager'

let db: Db
let sync: SyncManager
let composeService: ComposeService | undefined

// Email bodies are served from their own origin with a per-message CSP (see render-email.ts).
protocol.registerSchemesAsPrivileged([
  { scheme: 'imc-body', privileges: { standard: true, secure: true } }
])

/** A filename that is safe to offer in a save dialog on any OS. */
const safeFilename = (name: string): string =>
  basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150) || 'attachment'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // Never navigate the app window or open child windows; hand external links to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const publicAccount = ({ config: _config, ...account }: AccountRow): Account => account

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  db = openDb(join(userData, 'imc-mail.sqlite'))
  const store = new MailStore(db)
  const secrets = await safeStorageSecrets(join(userData, 'secrets.json'))
  // In dev, app.getAppPath() is apps/desktop; the repo root two levels up holds .google-oauth.json.
  const oauthConfig = loadOAuthConfig(userData, process.env, [join(app.getAppPath(), '../..')])
  const tokens = new TokenProvider(secrets, oauthConfig, (id) => {
    const provider = store.getAccount(id)?.provider
    return provider && provider !== 'imap' ? oauthProviders[provider] : undefined
  })
  const credentials = new Credentials(secrets, tokens)
  sync = new SyncManager(store, credentials, (accountId) => emit('sync:changed', { accountId }))
  const messages = new MessageService(store, sync)
  const compose = new ComposeService(
    store,
    new SmtpMailer(credentials, (id, path, raw) => sync.append(id, path, raw)),
    {
      outboxDir: join(userData, 'outbox'),
      ensureBody: (id) => messages.ensureBody(id),
      onChange: () => emit('outbox:changed', {}),
      onSent: (accountId) => sync.resync(accountId)
    }
  )
  composeService = compose
  compose.start()
  let signInAbort: AbortController | null = null

  protocol.handle('imc-body', (req) => {
    const url = new URL(req.url)
    const rendered = messages.render(decodeURIComponent(url.pathname.slice(1)), {
      allowImages: url.searchParams.get('images') === '1',
      fg: url.searchParams.get('fg') ?? undefined,
      bg: url.searchParams.get('bg') ?? undefined
    })
    if (!rendered) return new Response('This message has not been downloaded.', { status: 404 })
    return new Response(rendered.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': rendered.csp,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    })
  })

  const addAccountOrThrow = (email: string) => {
    if (store.listAccounts().some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('That account is already added')
    }
  }

  registerIpc({
    'app:info': () => ({
      version: app.getVersion(),
      platform: process.platform,
      schemaVersion: db.pragma('user_version', { simple: true }) as number
    }),
    'app:ping': ({ message }) => ({ reply: `pong: ${message}`, at: Date.now() }),

    'accounts:list': () => store.listAccounts().map(publicAccount),
    'accounts:test': (input) => testConnection(input.imap, input.username, input.password),
    'accounts:add': async (input) => {
      addAccountOrThrow(input.email)
      const account = store.addAccount(input, 'imap')
      try {
        await credentials.setPassword(account.id, input.password)
      } catch (e) {
        store.removeAccount(account.id)
        throw e
      }
      sync.start(account.id)
      return publicAccount(account)
    },
    'oauth:status': () => ({ gmail: !!oauthConfig.gmail, microsoft: !!oauthConfig.microsoft }),
    'accounts:addOAuth': async ({ provider }) => {
      const def = oauthProviders[provider]
      const client = oauthConfig[provider]
      if (!client) {
        throw new Error(
          `${def.label} sign-in is not configured on this computer. See docs/oauth-setup.md.`
        )
      }
      if (signInAbort) throw new Error('A sign-in is already in progress')
      signInAbort = new AbortController()
      try {
        const result = await signIn(def, client, {
          openUrl: (url) => shell.openExternal(url),
          signal: signInAbort.signal
        })
        addAccountOrThrow(result.email)
        const account = store.addAccount(
          {
            email: result.email,
            displayName: result.name,
            username: result.email,
            imap: def.imap,
            smtp: def.smtp
          },
          provider,
          'oauth'
        )
        try {
          await tokens.save(account.id, result.tokens)
        } catch (e) {
          store.removeAccount(account.id)
          throw e
        }
        sync.start(account.id)
        return publicAccount(account)
      } finally {
        signInAbort = null
      }
    },
    'oauth:cancel': () => {
      signInAbort?.abort()
    },
    'accounts:remove': async ({ id }) => {
      sync.stop(id)
      store.removeAccount(id)
      await credentials.remove(id)
      emit('sync:changed', { accountId: id })
    },
    'accounts:resync': ({ id }) => {
      sync.resync(id)
    },

    'folders:list': () => store.listFolders(),
    'messages:list': (q) => store.listMessages(q),
    'messages:open': ({ id }) => messages.open(id),
    'messages:loadBody': ({ id }) => messages.loadBody(id),
    'messages:setFlags': async ({ id, seen, flagged }) => {
      await messages.setFlags(id, { seen, flagged })
      const accountId = store.getMessage(id)?.accountId
      if (accountId) emit('sync:changed', { accountId })
    },
    'accounts:setSignature': ({ id, signature }) => {
      store.setSignature(id, signature)
    },
    'compose:replyContext': ({ messageId, mode }) => compose.replyContext(messageId, mode),
    'compose:attach': async ({ paths }) => {
      if (paths) return compose.vetFiles(paths)
      const pick = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      return pick.canceled ? [] : compose.vetFiles(pick.filePaths)
    },
    'compose:send': (draft) => compose.send(draft),
    'compose:undo': ({ outboxId }) => compose.undo(outboxId),
    'compose:saveDraft': (draft) => compose.saveDraft(draft),
    'compose:drafts': () => compose.listDrafts(),
    'compose:loadDraft': ({ id }) => compose.loadDraft(id),
    'compose:discardDraft': ({ id }) => {
      compose.discardDraft(id)
    },
    'contacts:search': ({ q }) => compose.contacts(q),
    'outbox:list': () => compose.list(),
    'senders:allowImages': ({ address }) => {
      messages.allowImages(address)
    },
    'attachments:save': async ({ messageId, attachmentId }) => {
      const meta = store.getBody(messageId)?.attachments.find((a) => a.id === attachmentId)
      if (!meta) throw new Error('That attachment is not available')
      const target = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('downloads'), safeFilename(meta.filename))
      })
      if (target.canceled || !target.filePath) return { saved: null }
      const att = await messages.attachment(messageId, attachmentId)
      await writeFile(target.filePath, att.content)
      return { saved: target.filePath }
    }
  })

  sync.startAll()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  composeService?.stop()
  sync?.stopAll()
  db?.close()
})

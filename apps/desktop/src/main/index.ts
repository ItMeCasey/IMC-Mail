import { app, BrowserWindow, dialog, globalShortcut, nativeImage, Notification, protocol, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { oauthProviders, type Account, type NotificationSettings } from '@imc/core'
import { Credentials } from './credentials'
import { brandFrom } from './deals'
import { openDb, type Db } from './db'
import { emit, registerIpc } from './ipc'
import { dealsToCsv } from '@imc/core'
import { previewOf } from './preview'
import { dealDeadlineFromEmail } from './deal-deadline'
import { BadgeController, badgePng } from './badge'
import { CalendarService } from './calendar'
import { ComposeService, SmtpMailer } from './compose'
import { MessageService } from './messages'
import { SnoozeWaker } from './snooze'
import { TemplateService } from './templates'
import { DEFAULT_NOTIFICATIONS, Notifier } from './notifications'
import { loadOAuthConfig, signIn, TokenProvider } from './oauth'
import { safeStorageSecrets } from './secrets'
import { MailStore, type AccountRow } from './store'
import { testConnection } from './sync/engine'
import { parseProcessList, StreamSafeController, type StreamSafeSettings } from './streamsafe'
import { SyncManager } from './sync/manager'

let db: Db
let sync: SyncManager
let composeService: ComposeService | undefined
let streamSafe: StreamSafeController | undefined
let notifier: Notifier | undefined
let snoozeWaker: SnoozeWaker | undefined
let badge: BadgeController | undefined

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

  win.setContentProtection(!!streamSafe && streamSafe.state.active && streamSafe.state.hideFromCapture)
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
  sync = new SyncManager(
    store,
    credentials,
    (accountId) => emit('sync:changed', { accountId }),
    (ids) => notifier?.handleNew(ids)
  )
  // The calendar service needs compose to send invitations, and compose needs messages, so the
  // message service reaches the calendar through this small forwarder.
  let calendarSvc: CalendarService | undefined
  const messages = new MessageService(
    store,
    sync,
    (accountId) => {
      sync.resync(accountId)
      emit('sync:changed', { accountId })
    },
    {
      ingest: (accountId, messageId, events) => calendarSvc?.ingest(accountId, messageId, events),
      inviteFor: (messageId) => calendarSvc?.inviteFor(messageId) ?? null
    }
  )
  const compose = new ComposeService(
    store,
    new SmtpMailer(credentials, (id, path, raw) => sync.append(id, path, raw)),
    {
      outboxDir: join(userData, 'outbox'),
      ensureBody: (id) => messages.ensureBody(id),
      onChange: () => emit('outbox:changed', {}),
      onSent: (accountId) => sync.resync(accountId),
      onFollowUp: (accountId, messageId, due) => store.addPendingFollowUp(accountId, messageId, due)
    }
  )
  composeService = compose
  calendarSvc = new CalendarService(store, { send: (d, o) => compose.send(d, o) })
  const calendar = calendarSvc
  const templates = new TemplateService(store, join(userData, 'templates'))
  compose.start()

  // Stream-safe mode: settings live in userData/settings.json next to the database.
  const settingsFile = join(userData, 'settings.json')
  const readSettings = (): Record<string, unknown> => {
    try {
      return existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
    } catch {
      return {}
    }
  }
  streamSafe = new StreamSafeController({
    listProcesses: () =>
      new Promise((resolve, reject) => {
        const [cmd, args] =
          process.platform === 'win32'
            ? ['tasklist', ['/FO', 'CSV', '/NH']]
            : ['ps', ['-A', '-o', 'comm=']]
        execFile(cmd as string, args as string[], { timeout: 4000, windowsHide: true }, (err, out) =>
          err ? reject(err) : resolve(parseProcessList(out, process.platform))
        )
      }),
    loadSettings: () => (readSettings()['streamSafe'] as StreamSafeSettings | undefined) ?? null,
    saveSettings: (s) => writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), streamSafe: s }, null, 2)),
    onChange: (state) => {
      // Hiding the window from capture also blanks its taskbar thumbnail.
      for (const w of BrowserWindow.getAllWindows()) {
        w.setContentProtection(state.active && state.hideFromCapture)
      }
      emit('streamsafe:changed', state)
    }
  })
  streamSafe.start()

  // Desktop notifications for new mail, quiet while stream-safe mode is hiding things.
  let notificationSettings: NotificationSettings = {
    ...DEFAULT_NOTIFICATIONS,
    ...((readSettings()['notifications'] as Partial<NotificationSettings> | undefined) ?? {})
  }
  const showToast = (t: { title: string; body: string; messageId: string | null }) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: t.title, body: t.body })
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      if (t.messageId) emit('notification:open', { messageId: t.messageId })
    })
    n.show()
  }
  snoozeWaker = new SnoozeWaker({
    wakeDue: (now) => store.wakeDue(now),
    markUnread: async (id) => {
      store.setLocalFlags(id, { seen: false })
      // Best effort: without this the next sync would mark it read again, but offline is fine.
      const m = store.getMessage(id)
      if (m) {
        await sync.setFlags(m.accountId, m.folderPath, m.uid, { remove: ['\\Seen'] }).catch(() => {})
      }
    },
    onWoken: (ids) => {
      for (const accountId of new Set(ids.map((i) => store.getMessage(i)?.accountId).filter(Boolean))) {
        emit('sync:changed', { accountId: accountId as string })
      }
      notifier?.handleWake(ids)
    }
  })
  notifier = new Notifier({
    getSettings: () => notificationSettings,
    streamActive: () => streamSafe?.state.active ?? true,
    load: (ids) => store.incoming(ids),
    loadSent: (ids) => store.sentItems(ids),
    show: showToast
  })
  snoozeWaker.start()
  // Follow-up reminders: shown once when due, dropped quietly if someone replied.
  const followUpTimer = setInterval(() => {
    const ids = store.followUpTick(Date.now())
    if (ids.length === 0) return
    for (const accountId of new Set(ids.map((i) => store.getMessage(i)?.accountId).filter(Boolean))) {
      emit('sync:changed', { accountId: accountId as string })
    }
    notifier?.handleFollowUp(ids)
  }, 30_000)
  app.on('will-quit', () => clearInterval(followUpTimer))
  // Unread count on the taskbar (Windows overlay) or dock / launcher (macOS, Linux).
  badge = new BadgeController({
    count: () => store.inboxUnread(),
    hidden: () => streamSafe?.state.active ?? true,
    apply: (n) => {
      if (process.platform === 'win32') {
        const icon = n > 0 ? nativeImage.createFromBuffer(badgePng(n)) : null
        for (const w of BrowserWindow.getAllWindows()) {
          w.setOverlayIcon(icon, n > 0 ? `${n} unread` : '')
        }
      } else {
        app.setBadgeCount(n)
      }
    }
  })
  badge.start()
  if (!globalShortcut.register('CommandOrControl+Shift+L', () => streamSafe?.toggle())) {
    console.warn('[stream-safe] Ctrl+Shift+L is taken by another app; use the sidebar control instead')
  }
  let signInAbort: AbortController | null = null

  protocol.handle('imc-body', (req) => {
    const url = new URL(req.url)
    const rendered = messages.render(decodeURIComponent(url.pathname.slice(1)), {
      allowImages: url.searchParams.get('images') === '1',
      allowLinks: url.searchParams.get('links') === '1',
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
    'messages:search': ({ q }) => store.search(q),
    'messages:snooze': ({ id, until }) => {
      messages.snooze(id, until)
    },
    'folders:loadOlder': async ({ folderId }) => {
      const f = store.getFolder(folderId)
      if (!f) throw new Error('That folder no longer exists')
      const r = await sync.loadOlder(f.accountId, f)
      emit('sync:changed', { accountId: f.accountId })
      return r
    },
    'labels:list': () => store.listLabels(),
    'labels:create': ({ name }) => store.createLabel(name),
    'labels:delete': ({ id }) => {
      store.deleteLabel(id)
    },
    'messages:setLabels': ({ id, labelIds }) => {
      messages.setLabels(id, labelIds)
    },
    'messages:followUp': ({ id, at }) => {
      messages.followUp(id, at)
    },
    'messages:markSafe': ({ id, safe }) => {
      messages.markSafe(id, safe)
    },
    'messages:setCategory': ({ id, category }) => {
      store.setCategory(id, category)
    },
    'views:counts': () => store.viewCounts(),
    'deals:exportCsv': async () => {
      const target = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('downloads'), 'sponsorship-deals.csv'),
        filters: [{ name: 'CSV spreadsheet', extensions: ['csv'] }]
      })
      if (target.canceled || !target.filePath) return { saved: null }
      // The byte-order mark makes Excel read the file as UTF-8 (brand names keep their accents).
      await writeFile(target.filePath, '﻿' + dealsToCsv(store.listDeals()), 'utf8')
      return { saved: target.filePath }
    },
    'deals:list': () => store.listDeals(),
    'deals:create': ({ messageId, accountId, patch }) => {
      const m = messageId ? store.getMessage(messageId) : undefined
      const acct = m?.accountId ?? accountId ?? store.listAccounts()[0]?.id
      if (!acct) throw new Error('Add an account first')
      const brand = patch?.brand ?? (m ? brandFrom(m.fromName, m.fromAddr) : 'New deal')
      // Starting from an email: pick up a deadline it asks for, unless you already gave one.
      const found = m && patch?.dueDate === undefined ? dealDeadlineFromEmail(m.subject, store.getBody(m.id)) : null
      return store.createDeal({
        ...patch,
        ...(found ? { dueDate: found.dueDate, notes: [patch?.notes, found.note].filter(Boolean).join('\n') } : {}),
        accountId: acct,
        messageId: m?.id ?? null,
        brand
      })
    },
    'deals:update': ({ id, patch }) => store.updateDeal(id, patch),
    'deals:delete': ({ id }) => {
      store.deleteDeal(id)
    },
    'messages:open': ({ id }) => messages.open(id),
    'messages:loadBody': ({ id }) => messages.loadBody(id),
    'messages:act': ({ id, action, folderId }) => messages.act(id, action, folderId),
    'messages:undoMove': async (u) => {
      await messages.undoMove(u)
    },
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
    'compose:send': ({ sendAt, ...draft }) => compose.send(draft, { sendAt }),
    'compose:undo': ({ outboxId }) => compose.undo(outboxId),
    'compose:saveDraft': (draft) => compose.saveDraft(draft),
    'compose:drafts': () => compose.listDrafts(),
    'compose:loadDraft': ({ id }) => compose.loadDraft(id),
    'compose:discardDraft': ({ id }) => {
      compose.discardDraft(id)
    },
    'contacts:search': ({ q }) => compose.contacts(q),
    'outbox:list': () => compose.list(),
    'calendar:respond': ({ messageId, response, comment }) =>
      calendar.respond(messageId, response, comment),
    'calendar:list': ({ from, to }) => calendar.list(from, to),
    'calendar:schedule': (input) => calendar.schedule(input),
    'calendar:update': ({ id, patch }) => calendar.update(id, patch),
    'calendar:cancel': ({ id }) => calendar.cancel(id),
    'calendar:exportIcs': async ({ id }) => {
      const ics = calendar.exportIcs(id)
      const target = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('downloads'), safeFilename(ics.filename)),
        filters: [{ name: 'Calendar event', extensions: ['ics'] }]
      })
      if (target.canceled || !target.filePath) return { saved: null }
      await writeFile(target.filePath, ics.content, 'utf8')
      return { saved: target.filePath }
    },
    'templates:list': () => templates.list(),
    'templates:save': (input) => templates.save(input),
    'templates:delete': async ({ id }) => {
      await templates.delete(id)
    },
    'notifications:get': () => notificationSettings,
    'notifications:set': (patch) => {
      notificationSettings = { ...notificationSettings, ...patch }
      writeFileSync(
        settingsFile,
        JSON.stringify({ ...readSettings(), notifications: notificationSettings }, null, 2)
      )
      return notificationSettings
    },
    'notifications:test': () => {
      if (streamSafe?.state.active && notificationSettings.whenStreamSafe === 'silent') {
        return { shown: false, reason: 'Stream-safe mode is on, so notifications are silent' }
      }
      if (!Notification.isSupported()) {
        return { shown: false, reason: 'This system cannot show notifications' }
      }
      showToast({ title: 'IMC-Mail', body: 'This is how new mail will look.', messageId: null })
      return { shown: true, reason: null }
    },
    'streamsafe:get': () => streamSafe!.state,
    'streamsafe:set': (patch) => streamSafe!.update(patch),
    'streamsafe:toggle': () => streamSafe!.toggle(),
    'senders:allowImages': ({ address }) => {
      messages.allowImages(address)
    },
    'attachments:preview': async ({ messageId, attachmentId }) => {
      const meta = store.getBody(messageId)?.attachments.find((a) => a.id === attachmentId)
      if (!meta) throw new Error('That attachment is not available')
      const att = await messages.attachment(messageId, attachmentId)
      return previewOf(meta.filename, meta.mime, att.content)
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

  store.backfillCategories()
  sync.startAll()
  createWindow()
  badge?.reset()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      badge?.reset()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  snoozeWaker?.stop()
  badge?.stop()
  notifier?.stop()
  streamSafe?.stop()
  globalShortcut.unregisterAll()
  composeService?.stop()
  sync?.stopAll()
  db?.close()
})

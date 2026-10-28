import appIcon from '../../build/icon.ico?asset'
import { app, BrowserWindow, ipcMain, Menu, Tray, dialog, globalShortcut, nativeImage, Notification, protocol, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { categorySchema, oauthProviders, SYNC_SERVER_URL, type Account, type NotificationSettings } from '@imc/core'
import { Credentials } from './credentials'
import { brandFrom } from './deals'
import { openDb, type Db } from './db'
import { emit, registerIpc } from './ipc'
import { cleanFolderName, dealsToCsv, isAllowedRelayUrl, issueUrl, parseBackup, planImport, PROTECTED_ROLES, REPORT_RELAY_URL, reportBody, type Backup } from '@imc/core'
import { looksLikePdf, previewOf } from './preview'
import { RuleEngine } from './rules'
import { dealDeadlineFromEmail } from './deal-deadline'
import { BadgeController, badgePng } from './badge'
import { closeAction, trayTooltip } from './tray'
import { CrashLog } from './crashlog'
import { Updater } from './updater'
import { CalendarService } from './calendar'
import { ComposeService, SmtpMailer } from './compose'
import { LaunchInbox } from './launch'
import { MessageService } from './messages'
import { SnoozeWaker } from './snooze'
import { TemplateService } from './templates'
import { DEFAULT_NOTIFICATIONS, Notifier } from './notifications'
import { loadOAuthConfig, signIn, TokenProvider } from './oauth'
import { CalendarSync } from './calendar-sync'
import { defaultHolidayCountry, holidayCountries, holidaysBetween } from './holidays'
import { createLogos } from './logos'
import { ReminderService } from './reminders'
import { DeviceSync } from './sync'
import { sqliteSyncStorage, syncAdapters, type PrefsAccess } from './sync-local'
import { safeStorageSecrets } from './secrets'
import { MailStore, type AccountRow } from './store'
import { testConnection } from './sync/engine'
import { parseProcessList, StreamSafeController, type StreamSafeSettings } from './streamsafe'
import { SyncManager } from './sync/manager'

let db: Db
let sync: SyncManager
let composeService: ComposeService | undefined
let streamSafe: StreamSafeController | undefined
let calendarSync: CalendarSync | undefined
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

let closeToTray = false
let showLogos = true
let streamerFeatures = true
let showHolidays = false
let holidayCountry = 'US'
let meetingReminders = true
let reminderLeadMinutes = 10
let holidayReminders = false
let quitting = false
let tray: Tray | null = null
let updater: Updater | null = null

/** Brings the window back from the tray, the taskbar or behind other windows. */
function showMainWindow(): void {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

// Only one copy runs; opening it again brings the first one forward (it may be sitting in the tray).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow()
    // A mail link was clicked, or "Mail this" was used on a file, while the app was already running.
    if (launch) launch.handle(argv)
    else earlyLaunches.push(argv)
  })
}

/** Messages started from outside the app (see launch.ts). Set up once the compose service exists. */
let launch: LaunchInbox | null = null
/** Launches that arrived before then, this one's own arguments first. */
const earlyLaunches: string[][] = [process.argv]

const windowState: { maximized: boolean; saved: Electron.Rectangle | null } = { maximized: false, saved: null }
/** Maximizes, or puts the window back to the size it had. A transparent window is sized by hand. */
function setMaximized(w: BrowserWindow, on: boolean): void {
  if (on && !windowState.maximized) {
    windowState.saved = w.getBounds()
    w.maximize()
    reportMaximized(true)
  } else if (!on && windowState.maximized) {
    if (windowState.saved) w.setBounds(windowState.saved)
    else w.unmaximize()
    reportMaximized(false)
  }
}

function reportMaximized(m: boolean): void {
  windowState.maximized = m
  emit('window:state', { maximized: m })
}

let mainWin: BrowserWindow | null = null

/** The channels that change something that syncs between devices. */
const SYNCED_CHANGES = /^(labels:(create|delete)|rules:(save|delete)|searches:(save|delete)|templates:(save|delete)|notifications:set|messages:(snooze|followUp|setLabels)|deals:(create|update|delete)|calendar:(respond|schedule|update|cancel))$/

/** The window whose edge is being dragged: the one with focus, since the grips are in its page. */
function targetWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  return focused && !focused.isDestroyed() ? focused : (mainWin ?? BrowserWindow.getAllWindows()[0])
}
let settingsWin: BrowserWindow | null = null

/** Settings live in a window of their own: a normal window with its own title bar that can be moved and resized anywhere. */
function openSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    return
  }
  const win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 640,
    minHeight: 440,
    show: false,
    title: 'IMC-Mail settings',
    icon: appIcon,
    // Frameless and transparent like the main window, so the corners are rounded in CSS; the
    // resize edges are drawn by the page (see ResizeGrips).
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  settingsWin = win
  win.removeMenu()
  win.setContentProtection(!!streamSafe && streamSafe.state.active && streamSafe.state.hideFromCapture)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#settings`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' })
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    // Frameless and transparent so the corners can be rounded in CSS; the title bar and resize
    // edges are drawn by the app (see WindowFrame in the renderer).
    icon: appIcon,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWin = win
  win.on('closed', () => {
    mainWin = null
    // Settings belong to the main window: closing it for good closes them too.
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.destroy()
  })
  win.setContentProtection(!!streamSafe && streamSafe.state.active && streamSafe.state.hideFromCapture)
  win.once('ready-to-show', () => win.show())
  // With "keep running in the tray" on, the close button hides the window instead of quitting.
  win.on('close', (e) => {
    if (closeAction({ closeToTray, quitting }) === 'hide') {
      e.preventDefault()
      win.hide()
    }
  })
  // A transparent window cannot be maximized by the OS, so Electron sets its bounds; tell the page so it can square its corners.
  // Double-clicking the title bar: Windows sends WM_NCLBUTTONDBLCLK for the drag area, and a
  // transparent window ignores it by itself, so do what a title bar does.
  if (process.platform === 'win32') {
    win.hookWindowMessage(0x00a3, () => setMaximized(win, !windowState.maximized))
  }
  win.on('maximize', () => reportMaximized(true))
  win.on('unmaximize', () => reportMaximized(false))

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

let crashLog: CrashLog | null = null
process.on('uncaughtException', (e) => {
  crashLog?.add('error', e)
  console.error('[uncaught]', e)
})
process.on('unhandledRejection', (e) => {
  crashLog?.add('rejection', e)
  console.error('[unhandled rejection]', e)
})
app.on('render-process-gone', (_e, _wc, d) => crashLog?.add('renderer-gone', { message: `Window process ended: ${d.reason}` }))
app.on('child-process-gone', (_e, d) => {
  if (d.reason !== 'clean-exit') crashLog?.add('process-gone', { message: `${d.type} process ended: ${d.reason}` })
})

/** Where PDFs are unpacked to be opened in the system viewer; emptied at start and quit so they do not pile up. */
const openedFilesDir = (): string => join(app.getPath('temp'), 'imc-mail-open')
const clearOpenedFiles = (): void => {
  try {
    rmSync(openedFilesDir(), { recursive: true, force: true })
  } catch {
    // a viewer may still hold one open; it is removed next time
  }
}

app.whenReady().then(async () => {
  // The app never needs the camera, microphone, location or any other web permission, so refuse them all.
  // (Electron approves every request by default.) Notifications come from the main process, not the page.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  clearOpenedFiles()
  const userData = app.getPath('userData')
  db = openDb(join(userData, 'imc-mail.sqlite'))
  const logos = createLogos({ dir: join(userData, 'logos'), fetchFn: (url, init) => fetch(url, init) })
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
    (ids) => {
      // Rules run first, so a message a rule archives or marks read does not raise a toast.
      void (ruleEngine ? ruleEngine.apply(ids) : Promise.resolve(0)).finally(() => {
        const keep = ids.filter((id) => store.ruleTargets([id]).length > 0)
        notifier?.handleNew(keep)
      })
    }
  )
  // The calendar service needs compose to send invitations, and compose needs messages, so the
  // message service reaches the calendar through this small forwarder.
  let calendarSvc: CalendarService | undefined
  let ruleEngine: RuleEngine | undefined
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
  ruleEngine = new RuleEngine(store, {
    setFlags: (id, change) => messages.setFlags(id, change),
    archive: async (id) => {
      await messages.act(id, 'archive')
    }
  })
  const rules = ruleEngine
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
  launch = new LaunchInbox({
    vet: (paths) => compose.vetFiles(paths),
    ready: () => {
      showMainWindow()
      emit('mailto:waiting', {})
    },
    fail: (message) => dialog.showErrorBox('IMC-Mail could not attach that file', message)
  })
  for (const argv of earlyLaunches.splice(0)) launch.handle(argv)
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
  streamerFeatures = readSettings()['streamerFeatures'] !== false
  showHolidays = readSettings()['showHolidays'] === true
  showLogos = readSettings()['showLogos'] !== false
  const savedCountry = readSettings()['holidayCountry']
  meetingReminders = readSettings()['meetingReminders'] !== false
  const savedLead = readSettings()['reminderLeadMinutes']
  reminderLeadMinutes = typeof savedLead === 'number' && savedLead >= 1 && savedLead <= 120 ? Math.round(savedLead) : 10
  holidayReminders = readSettings()['holidayReminders'] === true
  holidayCountry = typeof savedCountry === 'string' && /^[A-Z]{2}$/.test(savedCountry) ? savedCountry : defaultHolidayCountry(app.getLocale())
  if (!streamerFeatures) streamSafe.setEnabled(false)
  streamSafe.start()

  /** The saved media kit, if the file is still there. */
  const readMediaKit = () => {
    const p = readSettings()['mediaKit']
    if (typeof p !== 'string') return null
    try {
      const st = statSync(p)
      return st.isFile() ? { path: p, filename: basename(p), size: st.size } : null
    } catch {
      return null
    }
  }

  // Desktop notifications for new mail, quiet while stream-safe mode is hiding things.
  let notificationSettings: NotificationSettings = {
    ...DEFAULT_NOTIFICATIONS,
    ...((readSettings()['notifications'] as Partial<NotificationSettings> | undefined) ?? {})
  }
  const showToast = (t: { title: string; body: string; messageId: string | null; calendar?: boolean }) => {
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
      else if (t.calendar) emit('notification:calendar', {})
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
    // Without streamer features there are no mail kinds to choose from, so every kind notifies.
    getSettings: () => (streamerFeatures ? notificationSettings : { ...notificationSettings, categories: [...categorySchema.options] }),
    streamActive: () => streamSafe?.state.active ?? true,
    load: (ids) => store.incoming(ids),
    loadSent: (ids) => store.sentItems(ids),
    show: showToast
  })
  snoozeWaker.start()
  // Reminders for meetings about to start and for public holidays, as Windows toasts that open the calendar.
  const reminders = new ReminderService({
    prefs: () => ({ meetings: meetingReminders, leadMinutes: reminderLeadMinutes, holidays: holidayReminders }),
    notifications: () => notificationSettings,
    streamActive: () => streamSafe?.state.active ?? true,
    meetings: (from, to) => calendar.list(from, to),
    holidaysOn: (day) => {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
      return holidaysBetween(holidayCountry, start, start + 86_400_000).map((h) => h.name)
    },
    lastHolidayDay: () => {
      const v = readSettings()['holidayNotifiedOn']
      return typeof v === 'string' ? v : null
    },
    saveHolidayDay: (key) => writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), holidayNotifiedOn: key }, null, 2)),
    show: (t) => showToast({ ...t, messageId: null, calendar: true })
  })
  reminders.start()
  app.on('will-quit', () => reminders.stop())
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
  updater = new Updater({ packaged: app.isPackaged, onStatus: (st) => emit('update:changed', st) })
  // A quiet check shortly after start, then every few hours while the app stays open.
  setTimeout(() => updater?.check(), 15_000)
  const updateTimer = setInterval(() => updater?.check(), 6 * 3600_000)
  app.on('will-quit', () => clearInterval(updateTimer))
  crashLog = new CrashLog(join(userData, 'crash-log.json'))
  const reportParts = (note: string, includeErrors: boolean) => {
    const crashes = includeErrors ? crashLog!.list().slice(-5) : []
    const body = reportBody({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron, note, crashes })
    const title = crashes.length > 0 ? `Problem: ${crashes[crashes.length - 1]!.message.slice(0, 80)}` : 'Problem report'
    return { title, body }
  }
  const seenCrashes = () => Number(readSettings()['crashesAskedAt'] ?? 0)
  /** The relay's address, if one is set up and safe to use. */
  const relayUrl = (): string | null => {
    const url = process.env['IMC_REPORT_URL'] || REPORT_RELAY_URL
    return url && isAllowedRelayUrl(url) ? url : null
  }
  closeToTray = readSettings()['closeToTray'] === true
  tray = new Tray(nativeImage.createFromPath(appIcon))
  tray.setToolTip(trayTooltip(0))
  tray.on('click', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w && w.isVisible() && !w.isMinimized()) w.hide()
    else showMainWindow()
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open IMC-Mail', click: showMainWindow },
      { label: 'Check mail now', click: () => store.listAccounts().forEach((a) => sync.resync(a.id)) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  badge = new BadgeController({
    count: () => store.inboxUnread(),
    hidden: () => streamSafe?.state.active ?? true,
    apply: (n) => {
      tray?.setToolTip(trayTooltip(n))
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
  /** Streamer features (stream-safe mode, the sponsorship board, mail categories) on or off. Off is a plain mail client. */
  const applyStreamerFeatures = (on: boolean): void => {
    streamerFeatures = on
    streamSafe?.setEnabled(on)
    globalShortcut.unregister('CommandOrControl+Shift+L')
    if (on && !globalShortcut.register('CommandOrControl+Shift+L', () => streamSafe?.toggle())) {
      console.warn('[stream-safe] Ctrl+Shift+L is taken by another app; use the sidebar control instead')
    }
  }
  applyStreamerFeatures(streamerFeatures)
  const savePrefs = (): void =>
    writeFileSync(
      settingsFile,
      JSON.stringify({ ...readSettings(), closeToTray, showLogos, streamerFeatures, showHolidays, holidayCountry, meetingReminders, reminderLeadMinutes, holidayReminders }, null, 2)
    )
  // Settings that follow you to your other devices (see sync-local.ts). Window behavior is not among them.
  const prefsAccess: PrefsAccess = {
    getApp: () => ({ streamerFeatures, showHolidays, holidayCountry, meetingReminders, reminderLeadMinutes, holidayReminders }),
    setApp: (p) => {
      applyStreamerFeatures(p.streamerFeatures)
      showHolidays = p.showHolidays
      holidayCountry = p.holidayCountry
      meetingReminders = p.meetingReminders
      reminderLeadMinutes = p.reminderLeadMinutes
      holidayReminders = p.holidayReminders
      savePrefs()
    },
    getNotifications: () => notificationSettings,
    setNotifications: (s) => {
      notificationSettings = s
      writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), notifications: notificationSettings }, null, 2))
    }
  }
  const deviceSync = new DeviceSync({
    storage: sqliteSyncStorage(db),
    secrets,
    adapters: syncAdapters(store, prefsAccess),
    onApplied: () => emit('sync:applied', {})
  })
  deviceSync.start()
  app.on('will-quit', () => deviceSync.stop())
  let signInAbort: AbortController | null = null
  calendarSync = new CalendarSync({
    store,
    calendarToken: (id) => tokens.getCalendarToken(id),
    onChange: (accountId) => emit('sync:changed', { accountId })
  })
  const calendarSyncer = calendarSync

  protocol.handle('imc-body', (req) => {
    const url = new URL(req.url)
    const rendered = messages.render(decodeURIComponent(url.pathname.slice(1)), {
      allowImages: true,
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
    'folders:create': async ({ accountId, parentId, name }) => {
      const clean = cleanFolderName(name)
      if (!clean.ok) throw new Error(clean.error)
      const parent = parentId ? store.getFolder(parentId) : undefined
      if (parentId && (!parent || parent.accountId !== accountId)) throw new Error('That parent folder no longer exists')
      const path = await sync.createFolder(accountId, parent?.path ?? null, clean.name)
      // Show it at once; the next sync confirms it and fills in its role.
      const folderId = store.upsertFolder(accountId, { path, name: clean.name, role: null })
      emit('sync:changed', { accountId })
      return { folderId }
    },
    'folders:rename': async ({ folderId, name }) => {
      const clean = cleanFolderName(name)
      if (!clean.ok) throw new Error(clean.error)
      const f = store.getFolder(folderId)
      if (!f) throw new Error('That folder no longer exists')
      if (f.role && (PROTECTED_ROLES as readonly string[]).includes(f.role)) throw new Error('This is a standard folder and cannot be renamed.')
      const row = store.listFolders().find((x) => x.id === folderId)
      const oldName = row?.name ?? f.path
      const prefix = f.path.endsWith(oldName) ? f.path.slice(0, f.path.length - oldName.length) : ''
      const newPath = prefix + clean.name
      if (newPath === f.path) return
      await sync.renameFolder(f.accountId, f.path, newPath)
      store.removeFolderTree(folderId)
      emit('sync:changed', { accountId: f.accountId })
    },
    'folders:delete': async ({ folderId }) => {
      const f = store.getFolder(folderId)
      if (!f) throw new Error('That folder no longer exists')
      if (f.role && (PROTECTED_ROLES as readonly string[]).includes(f.role)) throw new Error('This is a standard folder and cannot be deleted.')
      if (store.hasSubfolders(folderId)) throw new Error('Delete or move the folders inside it first.')
      await sync.deleteFolder(f.accountId, f.path)
      store.removeFolder(folderId)
      emit('sync:changed', { accountId: f.accountId })
    },
    'accounts:markAll': async ({ id, seen }) => {
      const inbox = store.findFolderByRole(id, 'inbox')
      if (!inbox) throw new Error('This account has no Inbox yet. Try again after it has synced.')
      // The server first, so a refusal leaves everything as it was.
      await sync.markAllSeen(id, inbox.path, seen)
      const changed = store.setSeenInFolder(inbox.id, seen)
      emit('sync:changed', { accountId: id })
      return { changed }
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
    'searches:list': () => store.listSavedSearches(),
    'searches:save': ({ name, query }) => store.saveSearch(name, query),
    'searches:delete': ({ id }) => {
      store.deleteSavedSearch(id)
    },
    'rules:list': () => store.listRules(),
    'rules:save': (input) => store.saveRule(input),
    'rules:delete': ({ id }) => {
      store.deleteRule(id)
    },
    'rules:run': async ({ id }) => ({ matched: await rules.apply(store.recentInboxIds(500), id) }),
    'mediaKit:get': () => readMediaKit(),
    'mediaKit:choose': async () => {
      const pick = await dialog.showOpenDialog({ title: 'Choose your media kit or rate card', properties: ['openFile'] })
      if (pick.canceled || !pick.filePaths[0]) return null
      writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), mediaKit: pick.filePaths[0] }, null, 2))
      return readMediaKit()
    },
    'mediaKit:clear': () => {
      const { mediaKit: _gone, ...rest } = readSettings()
      writeFileSync(settingsFile, JSON.stringify(rest, null, 2))
    },
    'sync:status': () => deviceSync.client.status(),
    'sync:enable': async ({ deviceName }) => {
      if (streamSafe?.state.active) throw new Error('The pairing code is hidden while stream-safe mode is on.')
      const p = await deviceSync.client.enable(SYNC_SERVER_URL, deviceName ?? hostname())
      void deviceSync.client.syncNow()
      return deviceSync.view(p)
    },
    'sync:pairing': async () => {
      if (streamSafe?.state.active) throw new Error('The pairing code is hidden while stream-safe mode is on.')
      const p = await deviceSync.client.pairing()
      return p ? deviceSync.view(p) : null
    },
    'sync:rotate': async () => {
      if (streamSafe?.state.active) throw new Error('The pairing code is hidden while stream-safe mode is on.')
      const p = await deviceSync.client.rotate()
      void deviceSync.client.syncNow()
      return deviceSync.view(p)
    },
    'sync:join': async ({ code, deviceName }) => {
      await deviceSync.client.join(code, deviceName ?? hostname())
      return deviceSync.client.syncNow()
    },
    'sync:now': () => deviceSync.client.syncNow(),
    'sync:devices': () => deviceSync.client.devices(),
    'sync:removeDevice': ({ id }) => deviceSync.client.removeDevice(id).then(() => undefined),
    'sync:disable': () => deviceSync.client.disable().then(() => undefined),
    'settings:open': () => {
      openSettingsWindow()
    },
    'settings:action': (a) => {
      // The dialogs these open belong to the main window: bring it forward, then tell it which one.
      if (!mainWin || mainWin.isDestroyed()) return
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
      emit('settings:action', a)
    },
    'settings:control': ({ action }) => {
      if (!settingsWin || settingsWin.isDestroyed()) return
      if (action === 'minimize') settingsWin.minimize()
      else settingsWin.close()
    },
    'window:control': ({ action }) => {
      const w = mainWin ?? BrowserWindow.getAllWindows()[0]
      if (!w) return
      if (action === 'minimize') w.minimize()
      else if (action === 'maximize') setMaximized(w, true)
      else if (action === 'restore') setMaximized(w, false)
      else w.close()
    },
    'window:bounds': () => {
      const w = targetWindow()
      if (!w) return { x: 0, y: 0, width: 1280, height: 800, maximized: false }
      return { ...w.getBounds(), maximized: w === mainWin && windowState.maximized }
    },
    'window:setBounds': ({ x, y, width, height }) => {
      const w = targetWindow()
      if (!w || (w === mainWin && windowState.maximized)) return
      const [minW, minH] = w.getMinimumSize()
      w.setBounds({ x, y, width: Math.max(minW ?? 0, width), height: Math.max(minH ?? 0, height) })
    },
    'settings:export': async () => {
      const labels = store.listLabels()
      const backup: Backup = {
        app: 'IMC-Mail',
        version: 1,
        exportedAt: Date.now(),
        labels: labels.map((l) => l.name),
        rules: store.listRules().map((rule) => ({
          name: rule.name,
          enabled: rule.enabled,
          match: rule.match,
          actions: {
            labelName: labels.find((l) => l.id === rule.actions.labelId)?.name ?? null,
            category: rule.actions.category,
            markRead: rule.actions.markRead,
            star: rule.actions.star,
            archive: rule.actions.archive
          }
        })),
        savedSearches: store.listSavedSearches().map((q) => ({ name: q.name, query: q.query })),
        templates: templates.list().map((t) => ({ name: t.name, subject: t.subject, html: t.html })),
        notifications: notificationSettings,
        closeToTray
      }
      const target = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), 'imc-mail-settings.json'),
        filters: [{ name: 'IMC-Mail settings', extensions: ['json'] }]
      })
      if (target.canceled || !target.filePath) return { saved: null }
      await writeFile(target.filePath, JSON.stringify(backup, null, 2), 'utf8')
      return { saved: target.filePath }
    },
    'settings:import': async () => {
      const pick = await dialog.showOpenDialog({ title: 'Choose a settings file', properties: ['openFile'], filters: [{ name: 'IMC-Mail settings', extensions: ['json'] }] })
      if (pick.canceled || !pick.filePaths[0]) return null
      const file = pick.filePaths[0]
      if ((await stat(file)).size > 5_000_000) throw new Error('That file is too large to be a settings backup.')
      const parsed = parseBackup(await readFile(file, 'utf8'))
      if (!parsed.ok) throw new Error(parsed.error)
      const b = parsed.backup
      const plan = planImport(
        {
          labels: store.listLabels().map((l) => l.name),
          rules: store.listRules().map((x) => x.name),
          savedSearchQueries: store.listSavedSearches().map((q) => q.query),
          templates: templates.list().map((t) => t.name)
        },
        b
      )
      for (const name of plan.labels) store.createLabel(name)
      // Rules may use any label in the file, including ones you already had.
      const labelId = (name: string | null) => (name ? (store.listLabels().find((l) => l.name.toLowerCase() === name.toLowerCase())?.id ?? null) : null)
      for (const rule of plan.rules) {
        store.saveRule({
          name: rule.name,
          enabled: rule.enabled,
          match: rule.match,
          actions: { labelId: labelId(rule.actions.labelName), category: rule.actions.category, markRead: rule.actions.markRead, star: rule.actions.star, archive: rule.actions.archive }
        })
      }
      for (const q of plan.savedSearches) store.saveSearch(q.name, q.query)
      for (const t of plan.templates) await templates.save({ name: t.name, subject: t.subject, html: t.html, attachments: [] })
      let settingsApplied = false
      if (b.notifications) {
        notificationSettings = b.notifications
        writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), notifications: notificationSettings }, null, 2))
        settingsApplied = true
      }
      if (b.closeToTray !== undefined) {
        closeToTray = b.closeToTray
        writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), closeToTray }, null, 2))
        settingsApplied = true
      }
      return {
        added: { labels: plan.labels.length, rules: plan.rules.length, savedSearches: plan.savedSearches.length, templates: plan.templates.length },
        skipped: plan.skipped,
        settingsApplied
      }
    },
    'report:summary': () => {
      const all = crashLog?.list() ?? []
      return { errors: all.length, hasNew: all.some((c) => c.at > seenCrashes()), relay: relayUrl() !== null }
    },
    'report:preview': ({ note, includeErrors }) => reportParts(note, includeErrors),
    'report:send': async ({ note, includeErrors }) => {
      const url = relayUrl()
      if (!url) throw new Error('Sending reports is not set up yet. Use "Open on GitHub" instead.')
      const { title, body } = reportParts(note, includeErrors)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body, version: app.getVersion(), platform: process.platform }),
          signal: AbortSignal.timeout(15_000)
        })
      } catch {
        throw new Error('Could not reach the report server. Check your connection, or use "Open on GitHub" instead.')
      }
      const out = (await res.json().catch(() => null)) as { ok?: boolean; url?: string; duplicate?: boolean; error?: string } | null
      if (!res.ok || !out?.ok || !out.url) throw new Error(out?.error ?? `The report server answered ${res.status}.`)
      writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), crashesAskedAt: Date.now() }, null, 2))
      return { url: out.url, duplicate: out.duplicate === true }
    },
    'report:open': async ({ note, includeErrors }) => {
      const { title, body } = reportParts(note, includeErrors)
      writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), crashesAskedAt: Date.now() }, null, 2))
      await shell.openExternal(issueUrl(title, body))
    },
    'report:dismiss': () => {
      writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), crashesAskedAt: Date.now() }, null, 2))
    },
    'update:status': () => updater?.status ?? { state: 'unsupported', message: 'Updates are not available.' },
    'update:check': () => {
      updater?.check()
    },
    'update:install': () => {
      updater?.install()
    },
    'app:prefs': () => ({ closeToTray, showLogos, streamerFeatures, showHolidays, holidayCountry, meetingReminders, reminderLeadMinutes, holidayReminders }),
    'app:setPrefs': (p) => {
      if (p.closeToTray !== undefined) closeToTray = p.closeToTray
      if (p.showLogos !== undefined) showLogos = p.showLogos
      if (p.streamerFeatures !== undefined) applyStreamerFeatures(p.streamerFeatures)
      if (p.showHolidays !== undefined) showHolidays = p.showHolidays
      if (p.holidayCountry !== undefined) holidayCountry = p.holidayCountry
      if (p.meetingReminders !== undefined) meetingReminders = p.meetingReminders
      if (p.reminderLeadMinutes !== undefined) reminderLeadMinutes = p.reminderLeadMinutes
      if (p.holidayReminders !== undefined) holidayReminders = p.holidayReminders
      savePrefs()
    },
    'logos:get': ({ domains }) => (showLogos ? logos.get(domains) : {}),
    'calendar:holidays': ({ from, to }) => (showHolidays && to > from ? holidaysBetween(holidayCountry, from, Math.min(to, from + 400 * 86_400_000)) : []),
    'calendar:holidayCountries': () => holidayCountries(),
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
    'accounts:rename': ({ id, displayName }) => {
      store.setDisplayName(id, displayName)
      emit('sync:changed', { accountId: id })
    },
    'accounts:setSignature': ({ id, signature }) => {
      store.setSignature(id, signature)
    },
    'compose:replyContext': ({ messageId, mode }) => compose.replyContext(messageId, mode),
    'mailto:take': () => launch?.take() ?? null,
    'compose:attach': async ({ paths }) => {
      if (paths) return compose.attachDropped(paths)
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
    'calendar:sources': () => {
      const states = new Map(store.remoteSyncStates().map((s) => [s.accountId, s]))
      return store.listAccounts().flatMap((a) => {
        if (a.provider !== 'gmail' && a.provider !== 'microsoft') return []
        const s = states.get(a.id)
        return [{ accountId: a.id, email: a.email, provider: a.provider, connected: !!s && (s.syncedAt !== null || s.error === null), syncedAt: s?.syncedAt ?? null, error: s?.error ?? null }]
      })
    },
    'calendar:connect': async ({ accountId }) => {
      const account = store.listAccounts().find((a) => a.id === accountId)
      if (!account || (account.provider !== 'gmail' && account.provider !== 'microsoft')) throw new Error('Only Google and Microsoft accounts have a calendar to show')
      const def = oauthProviders[account.provider]
      const client = oauthConfig[account.provider]
      if (!client) throw new Error(`${def.label} sign-in is not configured on this computer. See docs/oauth-setup.md.`)
      if (signInAbort) throw new Error('A sign-in is already in progress')
      signInAbort = new AbortController()
      try {
        const result = await signIn(def, client, { openUrl: (url) => shell.openExternal(url), signal: signInAbort.signal, calendar: true, loginHint: account.email })
        if (result.email.toLowerCase() !== account.email.toLowerCase()) {
          throw new Error(`You signed in as ${result.email}, but this account is ${account.email}. Try again with the right one.`)
        }
        await tokens.save(account.id, result.tokens)
        tokens.forgetCalendarToken(account.id)
      } finally {
        signInAbort = null
      }
      const r = await calendarSyncer.syncAccount(account.id)
      return { ok: r.state === 'connected', message: r.state === 'error' ? r.error : r.state === 'not-connected' ? 'Calendar access was not allowed.' : null }
    },
    'calendar:syncNow': async ({ accountId }) => {
      if (accountId) await calendarSyncer.syncAccount(accountId)
      else await calendarSyncer.syncAll()
    },
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
    'attachments:open': async ({ messageId, attachmentId }) => {
      const meta = store.getBody(messageId)?.attachments.find((a) => a.id === attachmentId)
      if (!meta) throw new Error('That attachment is not available')
      const att = await messages.attachment(messageId, attachmentId)
      if (!looksLikePdf(att.content)) throw new Error('This file is not a real PDF, so it was not opened. Save it if you trust it.')
      const dir = openedFilesDir()
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${randomUUID()}-${safeFilename(meta.filename).replace(/\.pdf$/i, '')}.pdf`)
      await writeFile(path, att.content)
      const err = await shell.openPath(path)
      if (err) throw new Error(`Could not open the PDF: ${err}`)
      return { opened: true }
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
  },
  // Anything that changes what syncs is sent a few seconds later.
  (channel) => {
    // A new account lets items that were waiting for it come in: ask for everything again.
    if (channel === 'accounts:add' || channel === 'accounts:addOAuth') {
      deviceSync.client.rewind()
      deviceSync.syncSoon()
    }
    // Only the changes that are synced; opening and reading mail changes nothing to send.
    if (SYNCED_CHANGES.test(channel) || channel === 'app:setPrefs' || channel === 'settings:import') deviceSync.syncSoon()
  })

  // The window tells us which files the user dropped on it (see the preload); only those can be attached by path.
  ipcMain.on('attach:allow', (e, path: unknown) => {
    if (typeof path === 'string' && BrowserWindow.fromWebContents(e.sender)) composeService?.allowDropped(path)
  })

  store.backfillCategories()
  sync.startAll()
  calendarSync.start()
  createWindow()
  badge?.reset()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      badge?.reset()
    }
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  clearOpenedFiles()
  calendarSync?.stop()
  snoozeWaker?.stop()
  badge?.stop()
  notifier?.stop()
  streamSafe?.stop()
  globalShortcut.unregisterAll()
  composeService?.stop()
  sync?.stopAll()
  db?.close()
})

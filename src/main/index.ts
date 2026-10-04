import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { NoteRepository } from './storage'
import { configureSafeLogging } from './logger'
import type { NoteUpdate } from '../shared/types'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

configureSafeLogging(app.isPackaged)

// Keep every Chromium cache and spellchecker artifact inside the isolated
// test directory. Production keeps Electron's normal per-user profile.
if (process.env.LOCUS_TEST_MODE === '1' && process.env.LOCUS_DATA_DIR) {
  app.setPath('userData', join(process.env.LOCUS_DATA_DIR, '.electron-profile'))
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'locus-attachment',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}])

let mainWindow: BrowserWindow | null = null
let repository: NoteRepository
let closeApproved = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    title: 'Locus Notes',
    backgroundColor: '#f6f7fb',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: process.env.LOCUS_TEST_MODE !== '1'
    }
  })

  // autoHideMenuBar still allows Alt to reveal/focus the Windows menu.
  // All Locus actions live in the renderer; remove the native menu entirely.
  mainWindow.setMenu(null)

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (closeApproved || !mainWindow || mainWindow.webContents.isDestroyed()) return
    event.preventDefault()
    mainWindow.webContents.send('app:prepare-close')
  })
  // A note link must never replace the trusted page that owns the preload API.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('IPC request rejected: untrusted frame')
  }
}

function registerIpc(): void {
  const handle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event)
      return listener(event, ...args)
    })
  }
  handle('notes:list', () => repository.listNotes())
  handle('notes:create', (_event, sectionId?: string | null) => repository.createNote(sectionId ?? null))
  handle('notes:save', (_event, update: NoteUpdate) => repository.saveNote(update))
  handle('notes:delete', (_event, id: string) => repository.deleteNote(id))
  handle('trash:list', () => repository.listTrash())
  handle('trash:restore', (_event, trashName: string) => repository.restoreTrash(trashName))
  handle('trash:delete-permanently', (_event, trashName: string) => repository.deleteTrashPermanently(trashName))
  handle('trash:empty', () => repository.emptyTrash())
  handle('sections:list', () => repository.listSections())
  handle('sections:create', (_event, name: string) => repository.createSection(name))
  handle('sections:delete', (_event, id: string) => repository.deleteSection(id))
  handle('attachments:choose', async (_event, noteId: string) => {
    if (!mainWindow) return []
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Прикрепить файлы к заметке',
      properties: ['openFile', 'multiSelections']
    })
    if (choice.canceled) return []
    return repository.importAttachments(noteId, choice.filePaths)
  })
  handle('attachments:import-paths', (_event, noteId: string, paths: string[]) =>
    repository.importAttachments(noteId, paths)
  )
  handle(
    'attachments:save-bytes',
    (_event, noteId: string, data: ArrayBuffer | Uint8Array, originalName: string, mimeType: string) =>
      repository.saveAttachmentBytes(noteId, data, originalName, mimeType)
  )
  handle('attachments:open', async (_event, relativePath: string) => {
    const absolutePath = repository.resolveAttachmentPath(relativePath)
    if (process.env.LOCUS_TEST_MODE === '1') return
    const error = await shell.openPath(absolutePath)
    if (error) throw new Error(error)
  })
  handle('attachments:reveal', (_event, relativePath: string) => {
    const absolutePath = repository.resolveAttachmentPath(relativePath)
    if (process.env.LOCUS_TEST_MODE !== '1') shell.showItemInFolder(absolutePath)
  })
  handle('storage:stats', () => repository.getStorageStats())
  handle('storage:scan-unused', () => repository.scanUnusedAttachments())
  handle('storage:cleanup-unused', () => repository.cleanupUnusedAttachments())
  handle('data:path', () => repository.root)
  handle('data:open', () => shell.openPath(repository.root).then(() => undefined))
  handle('data:export', async () => {
    if (!mainWindow) return { canceled: true }
    const choice = await dialog.showOpenDialog(mainWindow, {
      title: 'Куда сохранить экспорт?',
      properties: ['openDirectory', 'createDirectory']
    })
    if (choice.canceled || !choice.filePaths[0]) return { canceled: true }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(/:/g, '-')
    const destination = join(choice.filePaths[0], `Locus Notes Export ${stamp}`)
    await mkdir(destination, { recursive: true })
    await repository.copyExport(destination)
    return { canceled: false, path: destination }
  })
  ipcMain.on('app:ready-to-close', (event) => {
    // Ignore an untrusted notification without throwing in an event listener.
    try { assertTrustedSender(event) } catch { return }
    closeApproved = true
    mainWindow?.close()
  })
}

app.whenReady().then(async () => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const dataRoot = process.env.LOCUS_DATA_DIR || join(app.getPath('documents'), 'Locus Notes')
  repository = new NoteRepository(dataRoot)
  await repository.initialize()
  protocol.handle('locus-attachment', (request) => {
    try {
      const relativePath = new URL(request.url).searchParams.get('path')
      if (!relativePath) return new Response('Вложение не указано', { status: 400 })
      const absolutePath = repository.resolveAttachmentPath(relativePath)
      return net.fetch(pathToFileURL(absolutePath).toString())
    } catch (error) {
      console.error('Не удалось открыть вложение', error)
      return new Response('Вложение не найдено', { status: 404 })
    }
  })
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

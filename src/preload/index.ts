import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { LocusApi, NoteUpdate } from '../shared/types'

const api: LocusApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  createNote: (sectionId) => ipcRenderer.invoke('notes:create', sectionId),
  saveNote: (update: NoteUpdate) => ipcRenderer.invoke('notes:save', update),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  listTrash: () => ipcRenderer.invoke('trash:list'),
  restoreTrash: (trashName) => ipcRenderer.invoke('trash:restore', trashName),
  deleteTrashPermanently: (trashName) => ipcRenderer.invoke('trash:delete-permanently', trashName),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  listSections: () => ipcRenderer.invoke('sections:list'),
  createSection: (name) => ipcRenderer.invoke('sections:create', name),
  deleteSection: (id) => ipcRenderer.invoke('sections:delete', id),
  chooseAttachments: (noteId) => ipcRenderer.invoke('attachments:choose', noteId),
  importAttachmentPaths: (noteId, paths) => ipcRenderer.invoke('attachments:import-paths', noteId, paths),
  saveAttachmentBytes: (noteId, data, originalName, mimeType) => ipcRenderer.invoke('attachments:save-bytes', noteId, data, originalName, mimeType),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  openAttachment: (relativePath) => ipcRenderer.invoke('attachments:open', relativePath),
  revealAttachment: (relativePath) => ipcRenderer.invoke('attachments:reveal', relativePath),
  getStorageStats: () => ipcRenderer.invoke('storage:stats'),
  scanUnusedAttachments: () => ipcRenderer.invoke('storage:scan-unused'),
  cleanupUnusedAttachments: () => ipcRenderer.invoke('storage:cleanup-unused'),
  exportAll: () => ipcRenderer.invoke('data:export'),
  getDataPath: () => ipcRenderer.invoke('data:path'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  onPrepareClose: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:prepare-close', listener)
    return () => ipcRenderer.removeListener('app:prepare-close', listener)
  },
  readyToClose: () => ipcRenderer.send('app:ready-to-close')
}

contextBridge.exposeInMainWorld('locus', api)

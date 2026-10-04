export interface Note {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  sectionId: string | null
  tags: string[]
  favorite: boolean
  language: string
}

export interface NoteUpdate {
  id: string
  title: string
  content: string
  sectionId: string | null
  tags: string[]
  favorite: boolean
  language?: string
}

export interface TrashNote extends Note {
  trashName: string
  deletedAt: string
}

export interface Section {
  id: string
  name: string
  color: string
  createdAt: string
}

export interface AppConfig {
  version: 1
  sections: Section[]
}

export interface SaveResult {
  note: Note
  backupCreated: boolean
}

export interface ExportResult {
  canceled: boolean
  path?: string
}

export interface AttachmentInfo {
  originalName: string
  storedName: string
  relativePath: string
  mimeType: string
  size: number
  isImage: boolean
}

export interface StorageStats {
  notesBytes: number
  attachmentsBytes: number
  trashBytes: number
  backupsBytes: number
  otherBytes: number
  totalBytes: number
}

export interface CleanupSummary {
  count: number
  bytes: number
}

export interface TrashCleanupResult {
  notes: number
  attachments: number
  bytes: number
}

export interface LocusApi {
  listNotes(): Promise<Note[]>
  createNote(sectionId?: string | null): Promise<Note>
  saveNote(update: NoteUpdate): Promise<SaveResult>
  deleteNote(id: string): Promise<boolean>
  listTrash(): Promise<TrashNote[]>
  restoreTrash(trashName: string): Promise<Note>
  deleteTrashPermanently(trashName: string): Promise<TrashCleanupResult>
  emptyTrash(): Promise<TrashCleanupResult>
  listSections(): Promise<Section[]>
  createSection(name: string): Promise<Section>
  deleteSection(id: string): Promise<boolean>
  chooseAttachments(noteId: string): Promise<AttachmentInfo[]>
  importAttachmentPaths(noteId: string, paths: string[]): Promise<AttachmentInfo[]>
  saveAttachmentBytes(noteId: string, data: ArrayBuffer, originalName: string, mimeType: string): Promise<AttachmentInfo>
  getPathForFile(file: File): string
  openAttachment(relativePath: string): Promise<void>
  revealAttachment(relativePath: string): Promise<void>
  getStorageStats(): Promise<StorageStats>
  scanUnusedAttachments(): Promise<CleanupSummary>
  cleanupUnusedAttachments(): Promise<CleanupSummary>
  exportAll(): Promise<ExportResult>
  getDataPath(): Promise<string>
  openDataFolder(): Promise<void>
  onPrepareClose(callback: () => void): () => void
  readyToClose(): void
}

declare global {
  interface Window {
    locus: LocusApi
  }
}

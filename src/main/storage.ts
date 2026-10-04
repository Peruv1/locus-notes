import { randomUUID } from 'node:crypto'
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname, join, resolve as resolvePath, sep } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { parse, stringify } from 'yaml'
import type {
  AppConfig,
  AttachmentInfo,
  CleanupSummary,
  Note,
  NoteUpdate,
  SaveResult,
  Section,
  StorageStats,
  TrashCleanupResult,
  TrashNote
} from '../shared/types'

const DEFAULT_SECTIONS = ['Учёба', 'Наука', 'Репетиторство', 'Программирование', 'Личное']
const SECTION_COLORS = ['#6c8cff', '#8b78f6', '#43aa8b', '#f4a261', '#e76f8a', '#4ca7d8']

interface NoteFrontMatter {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sectionId: string | null
  tags: string[]
  favorite: boolean
  language: string
}

export class NoteRepository {
  readonly root: string
  readonly notesDir: string
  readonly backupsDir: string
  readonly trashDir: string
  readonly attachmentsDir: string
  readonly configPath: string
  private mutationQueue: Promise<unknown> = Promise.resolve()

  // Serialize section changes with saves/creation/restoration so a stale save
  // cannot put a note back into a section that was just removed.
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.catch(() => undefined)
    return result
  }

  constructor(root: string) {
    this.root = root
    this.notesDir = join(root, 'notes')
    this.backupsDir = join(root, 'backups')
    this.trashDir = join(root, 'trash')
    this.attachmentsDir = join(root, 'attachments')
    this.configPath = join(root, 'config.json')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.notesDir, { recursive: true }),
      mkdir(this.backupsDir, { recursive: true }),
      mkdir(this.trashDir, { recursive: true }),
      mkdir(this.attachmentsDir, { recursive: true })
    ])

    if (!(await exists(this.configPath))) {
      await this.writeConfig(createDefaultConfig())
    }
  }

  async listNotes(): Promise<Note[]> {
    await this.initialize()
    const files = (await readdir(this.notesDir)).filter((file) => file.endsWith('.md'))
    const notes: Note[] = []
    for (const file of files) {
      try {
        notes.push(await this.readNote(join(this.notesDir, file)))
      } catch (error) {
        console.error(`Не удалось прочитать заметку ${file}`, error)
      }
    }
    return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  createNote(sectionId: string | null = null): Promise<Note> {
    return this.mutate(() => this.createNoteInternal(sectionId))
  }

  private async createNoteInternal(sectionId: string | null): Promise<Note> {
    await this.initialize()
    const now = new Date().toISOString()
    const note: Note = {
      id: randomUUID(),
      title: 'Новая заметка',
      content: '',
      createdAt: now,
      updatedAt: now,
      sectionId: await this.existingSectionId(sectionId),
      tags: [],
      favorite: false,
      language: 'auto'
    }
    await this.writeNote(note)
    return note
  }

  saveNote(update: NoteUpdate): Promise<SaveResult> {
    return this.mutate(() => this.saveNoteInternal(update))
  }

  private async saveNoteInternal(update: NoteUpdate): Promise<SaveResult> {
    await this.initialize()
    const filePath = this.notePath(update.id)
    const previous = await this.readNote(filePath)
    const next: Note = {
      ...previous,
      title: cleanTitle(update.title),
      content: update.content.replace(/\r\n/g, '\n'),
      sectionId: await this.existingSectionId(update.sectionId),
      tags: cleanTags(update.tags),
      favorite: Boolean(update.favorite),
      language: update.language === undefined ? previous.language : cleanLanguage(update.language),
      updatedAt: new Date().toISOString()
    }

    let backupCreated = false
    if (!notesEqual(previous, next)) {
      backupCreated = await this.createDailyBackup(filePath, previous.id)
      await this.writeNote(next)
    } else {
      next.updatedAt = previous.updatedAt
    }
    return { note: next, backupCreated }
  }

  deleteNote(id: string): Promise<boolean> {
    return this.mutate(() => this.deleteNoteInternal(id))
  }

  private async deleteNoteInternal(id: string): Promise<boolean> {
    const source = this.notePath(id)
    if (!(await exists(source))) return false
    await mkdir(this.trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await rename(source, join(this.trashDir, `${id}-${stamp}.md`))
    return true
  }

  async listTrash(): Promise<TrashNote[]> {
    await this.initialize()
    const files = (await readdir(this.trashDir)).filter((file) => file.endsWith('.md'))
    const notes: TrashNote[] = []
    for (const file of files) {
      try {
        const note = await this.readNote(join(this.trashDir, file))
        if (!isUuid(note.id)) {
          console.error(`Файл корзины ${file} оставлен нетронутым: не удалось безопасно определить ID`)
          continue
        }
        notes.push({ ...note, trashName: file, deletedAt: deletedAtFromTrashName(file) })
      } catch (error) {
        console.error(`Не удалось прочитать заметку из корзины ${file}`, error)
      }
    }
    return notes.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  restoreTrash(trashName: string): Promise<Note> {
    return this.mutate(() => this.restoreTrashInternal(trashName))
  }

  private async restoreTrashInternal(trashName: string): Promise<Note> {
    const source = this.trashPath(trashName)
    const note = await this.readNote(source)
    if (!isUuid(note.id)) throw new Error('Не удалось безопасно определить ID заметки в корзине')
    const destination = this.notePath(note.id)
    if (await exists(destination)) throw new Error('Активная заметка с таким ID уже существует')
    await rename(source, destination)
    return note
  }

  async deleteTrashPermanently(trashName: string): Promise<TrashCleanupResult> {
    const source = this.trashPath(trashName)
    const note = await this.readNote(source)
    if (!isUuid(note.id)) throw new Error('Не удалось безопасно определить ID заметки в корзине')
    const markdownBytes = (await stat(source)).size
    await rm(source)
    const attachmentResult = await this.removeAttachmentsForDeletedNote(note.id)
    return {
      notes: 1,
      attachments: attachmentResult.count,
      bytes: markdownBytes + attachmentResult.bytes
    }
  }

  async emptyTrash(): Promise<TrashCleanupResult> {
    const items = await this.listTrash()
    const result: TrashCleanupResult = { notes: 0, attachments: 0, bytes: 0 }
    for (const item of items) {
      const removed = await this.deleteTrashPermanently(item.trashName)
      result.notes += removed.notes
      result.attachments += removed.attachments
      result.bytes += removed.bytes
    }
    return result
  }

  async getStorageStats(): Promise<StorageStats> {
    await this.initialize()
    const [notesBytes, attachmentsBytes, trashBytes, backupsBytes, configBytes] = await Promise.all([
      directorySize(this.notesDir),
      directorySize(this.attachmentsDir),
      directorySize(this.trashDir),
      directorySize(this.backupsDir),
      fileSize(this.configPath)
    ])
    const totalBytes = await directorySize(this.root)
    return {
      notesBytes,
      attachmentsBytes,
      trashBytes,
      backupsBytes,
      otherBytes: Math.max(0, totalBytes - notesBytes - attachmentsBytes - trashBytes - backupsBytes),
      totalBytes: Math.max(totalBytes, notesBytes + attachmentsBytes + trashBytes + backupsBytes + configBytes)
    }
  }

  async scanUnusedAttachments(): Promise<CleanupSummary> {
    const candidates = await this.findUnusedAttachments()
    return summarizeFiles(candidates)
  }

  async cleanupUnusedAttachments(): Promise<CleanupSummary> {
    const candidates = await this.findUnusedAttachments()
    const summary = summarizeFiles(candidates)
    for (const candidate of candidates) await rm(candidate.absolutePath)
    await this.removeEmptyAttachmentDirectories()
    return summary
  }

  async listSections(): Promise<Section[]> {
    return (await this.readConfig()).sections
  }

  createSection(rawName: string): Promise<Section> {
    return this.mutate(() => this.createSectionInternal(rawName))
  }

  private async createSectionInternal(rawName: string): Promise<Section> {
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 80)
    if (!name) throw new Error('Название раздела не может быть пустым')
    const config = await this.readConfig()
    const existing = config.sections.find(
      (section) => section.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU')
    )
    if (existing) return existing

    const section: Section = {
      id: randomUUID(),
      name,
      color: SECTION_COLORS[config.sections.length % SECTION_COLORS.length] ?? SECTION_COLORS[0]!,
      createdAt: new Date().toISOString()
    }
    config.sections.push(section)
    await this.writeConfig(config)
    return section
  }

  deleteSection(id: string): Promise<boolean> {
    return this.mutate(async () => {
      if (!isUuid(id)) throw new Error('Этот системный раздел нельзя удалить')
      const config = await this.readConfig()
      if (!config.sections.some((section) => section.id === id)) return false

      // Keep a reversible snapshot, including config and original Markdown.
      // Only sectionId changes; preserve the complete body and unknown metadata.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = join(this.backupsDir, stamp.slice(0, 10), `section-${id}-${stamp}`)
      await mkdir(backup, { recursive: true })
      await copyFile(this.configPath, join(backup, 'config.json'))
      for (const directory of [this.notesDir, this.trashDir]) {
        for (const file of (await readdir(directory)).filter((name) => name.endsWith('.md'))) {
          const path = join(directory, file)
          const raw = await readFile(path, 'utf8')
          const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/)
          if (!header) continue
          const attributes = parse(header[1] ?? '') as Record<string, unknown> | null
          if (!attributes || attributes.sectionId !== id) continue
          const backupDir = join(backup, basename(directory))
          await mkdir(backupDir, { recursive: true })
          await copyFile(path, join(backupDir, file))
          attributes.sectionId = null
          const next = `---\n${stringify(attributes, { lineWidth: 0 }).trimEnd()}\n---${raw.slice(header[0].length)}`
          await writeFileAtomic(path, next, { encoding: 'utf8', fsync: true })
        }
      }
      // Commit config last. An interrupted operation always retains the notes.
      config.sections = config.sections.filter((section) => section.id !== id)
      await this.writeConfig(config)
      return true
    })
  }

  private async existingSectionId(id: unknown): Promise<string | null> {
    if (typeof id !== 'string' || !id) return null
    return (await this.listSections()).some((section) => section.id === id) ? id : null
  }

  async importAttachments(noteId: string, sourcePaths: string[]): Promise<AttachmentInfo[]> {
    await this.ensureNoteExists(noteId)
    const results: AttachmentInfo[] = []
    for (const sourcePath of sourcePaths) {
      const info = await stat(sourcePath)
      if (!info.isFile()) continue
      const originalName = basename(sourcePath)
      const target = await this.createAttachmentTarget(noteId, originalName)
      const temporary = `${target.absolutePath}.tmp`
      await copyFile(sourcePath, temporary)
      await rename(temporary, target.absolutePath)
      await this.backupAttachmentForDay(noteId, target.absolutePath, target.storedName)
      results.push(makeAttachmentInfo(originalName, target.storedName, target.relativePath, info.size))
    }
    return results
  }

  async saveAttachmentBytes(
    noteId: string,
    data: ArrayBuffer | Uint8Array,
    originalName: string,
    suppliedMimeType = ''
  ): Promise<AttachmentInfo> {
    await this.ensureNoteExists(noteId)
    const buffer = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (buffer.length > 100 * 1024 * 1024) {
      throw new Error('Файл из буфера обмена или drag & drop превышает лимит 100 МБ')
    }
    const cleanOriginal = sanitizeFilename(originalName)
    const target = await this.createAttachmentTarget(noteId, cleanOriginal)
    await writeFileAtomic(target.absolutePath, buffer, { fsync: true })
    await this.backupAttachmentForDay(noteId, target.absolutePath, target.storedName)
    return makeAttachmentInfo(cleanOriginal, target.storedName, target.relativePath, buffer.length, suppliedMimeType)
  }

  resolveAttachmentPath(relativePath: string): string {
    let decoded: string
    try {
      decoded = decodeURIComponent(relativePath)
    } catch {
      throw new Error('Некорректная ссылка на вложение')
    }
    const normalized = decoded.replace(/\\/g, '/')
    if (!normalized.startsWith('../attachments/')) throw new Error('Некорректная ссылка на вложение')
    const candidate = resolvePath(this.notesDir, normalized)
    const root = resolvePath(this.attachmentsDir)
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw new Error('Ссылка выходит за пределы хранилища вложений')
    }
    return candidate
  }

  async copyExport(destination: string): Promise<void> {
    await this.initialize()
    const targetNotes = join(destination, 'notes')
    await mkdir(targetNotes, { recursive: true })
    const files = (await readdir(this.notesDir)).filter((file) => file.endsWith('.md'))
    await Promise.all(files.map((file) => copyFile(join(this.notesDir, file), join(targetNotes, file))))
    await cp(this.attachmentsDir, join(destination, 'attachments'), { recursive: true, force: true })
    await copyFile(this.configPath, join(destination, 'config.json'))
    await writeFile(
      join(destination, 'README.txt'),
      'Экспорт Locus Notes. Заметки находятся в папке notes, вложения — в attachments. Относительные ссылки ../attachments/... сохраняют связь между ними. Копируйте обе папки вместе.\n',
      'utf8'
    )
  }

  private notePath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Некорректный ID заметки')
    return join(this.notesDir, `${id}.md`)
  }

  private trashPath(name: string): string {
    if (basename(name) !== name || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-.+\.md$/i.test(name)) {
      throw new Error('Некорректное имя файла в корзине')
    }
    return join(this.trashDir, name)
  }

  private async removeAttachmentsForDeletedNote(noteId: string): Promise<CleanupSummary> {
    if (await exists(this.notePath(noteId))) return { count: 0, bytes: 0 }
    const otherTrashEntry = (await this.listTrash()).some((item) => item.id === noteId)
    if (otherTrashEntry) return { count: 0, bytes: 0 }
    const directory = join(this.attachmentsDir, noteId)
    if (!(await exists(directory))) return { count: 0, bytes: 0 }
    const files = await collectRegularFiles(directory)
    const summary = summarizeFiles(files.map((file) => ({ ...file, relativePath: '' })))
    await rm(directory, { recursive: true, force: false })
    return summary
  }

  private async findUnusedAttachments(): Promise<Array<{ absolutePath: string; relativePath: string; size: number }>> {
    await this.initialize()
    const contents: string[] = []
    for (const directory of [this.notesDir, this.trashDir]) {
      const files = (await readdir(directory)).filter((file) => file.endsWith('.md'))
      for (const file of files) {
        // A read failure aborts cleanup instead of risking a false orphan.
        contents.push(await readFile(join(directory, file), 'utf8'))
      }
    }

    const candidates: Array<{ absolutePath: string; relativePath: string; size: number }> = []
    const directories = await readdir(this.attachmentsDir, { withFileTypes: true })
    for (const directory of directories) {
      if (!directory.isDirectory() || !isUuid(directory.name)) continue
      const absoluteDirectory = join(this.attachmentsDir, directory.name)
      const entries = await readdir(absoluteDirectory, { withFileTypes: true })
      // Unknown nested structures are deliberately ignored by cleanup.
      if (entries.some((entry) => !entry.isFile())) continue
      for (const entry of entries) {
        const absolutePath = join(absoluteDirectory, entry.name)
        const encoded = `../attachments/${directory.name}/${encodeURIComponent(entry.name)}`
        const decoded = `../attachments/${directory.name}/${entry.name}`
        if (contents.some((content) => content.includes(encoded) || content.includes(decoded))) continue
        candidates.push({ absolutePath, relativePath: encoded, size: (await stat(absolutePath)).size })
      }
    }
    return candidates
  }

  private async removeEmptyAttachmentDirectories(): Promise<void> {
    const directories = await readdir(this.attachmentsDir, { withFileTypes: true })
    for (const directory of directories) {
      if (!directory.isDirectory() || !isUuid(directory.name)) continue
      const path = join(this.attachmentsDir, directory.name)
      if ((await readdir(path)).length === 0) await rm(path, { recursive: false })
    }
  }

  private async ensureNoteExists(id: string): Promise<void> {
    const path = this.notePath(id)
    if (!(await exists(path))) throw new Error('Заметка для вложения не найдена')
  }

  private async createAttachmentTarget(noteId: string, originalName: string): Promise<{
    absolutePath: string
    storedName: string
    relativePath: string
  }> {
    const directory = join(this.attachmentsDir, noteId)
    await mkdir(directory, { recursive: true })
    const storedName = `${randomUUID()}-${sanitizeFilename(originalName)}`
    return {
      absolutePath: join(directory, storedName),
      storedName,
      relativePath: `../attachments/${noteId}/${encodeURIComponent(storedName)}`
    }
  }

  private async readNote(filePath: string): Promise<Note> {
    const raw = await readFile(filePath, 'utf8')
    const { attributes, body } = parseMarkdownFile(raw)
    const fileId = basename(filePath, '.md')
    return {
      id: typeof attributes.id === 'string' ? attributes.id : fileId,
      title: cleanTitle(attributes.title),
      content: body,
      createdAt: validDate(attributes.createdAt),
      updatedAt: validDate(attributes.updatedAt),
      sectionId: await this.existingSectionId(attributes.sectionId),
      tags: cleanTags(attributes.tags),
      favorite: Boolean(attributes.favorite),
      language: cleanLanguage(attributes.language)
    }
  }

  private async writeNote(note: Note): Promise<void> {
    const attributes: NoteFrontMatter = {
      id: note.id,
      title: note.title,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      sectionId: note.sectionId,
      tags: note.tags,
      favorite: note.favorite,
      language: cleanLanguage(note.language)
    }
    const yaml = stringify(attributes, { lineWidth: 0 }).trimEnd()
    const raw = `---\n${yaml}\n---\n\n${note.content}`
    await writeFileAtomic(this.notePath(note.id), raw, { encoding: 'utf8', fsync: true })
  }

  private async createDailyBackup(filePath: string, id: string): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10)
    const dayDir = join(this.backupsDir, day)
    const target = join(dayDir, `${id}.md`)
    if (await exists(target)) return false
    await mkdir(dayDir, { recursive: true })
    await copyFile(filePath, target)
    await this.copyAttachmentsToDailyBackup(id, dayDir)
    await this.pruneBackups(30)
    return true
  }

  private async copyAttachmentsToDailyBackup(noteId: string, dayDir: string): Promise<void> {
    const source = join(this.attachmentsDir, noteId)
    if (!(await exists(source))) return
    await cp(source, join(dayDir, 'attachments', noteId), { recursive: true, force: true })
  }

  private async backupAttachmentForDay(noteId: string, sourcePath: string, storedName: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10)
    const targetDir = join(this.backupsDir, day, 'attachments', noteId)
    await mkdir(targetDir, { recursive: true })
    await copyFile(sourcePath, join(targetDir, storedName))
    await this.pruneBackups(30)
  }

  private async pruneBackups(keepDays: number): Promise<void> {
    const entries = await readdir(this.backupsDir, { withFileTypes: true })
    const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
    const stale = directories.slice(keepDays)
    for (const directory of stale) {
      const full = join(this.backupsDir, directory)
      await rm(full, { recursive: true, force: true })
    }
  }

  private async readConfig(): Promise<AppConfig> {
    await this.initialize()
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      if (!Array.isArray(parsed.sections)) throw new Error('В config.json отсутствует список разделов')
      const sections = parsed.sections.filter(isValidSection)
      return { version: 1, sections }
    } catch (error) {
      console.error('Повреждён config.json; создаётся безопасная конфигурация', error)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        await rename(this.configPath, join(this.root, `config.corrupt-${stamp}.json`))
      } catch {
        // If the broken file cannot be moved, atomic write below still replaces it safely.
      }
      const recovered = createDefaultConfig()
      await this.writeConfig(recovered)
      return recovered
    }
  }

  private async writeConfig(config: AppConfig): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await writeFileAtomic(this.configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      fsync: true
    })
  }
}

function createDefaultConfig(): AppConfig {
  const now = new Date().toISOString()
  return {
    version: 1,
    sections: DEFAULT_SECTIONS.map((name, index) => ({
      id: randomUUID(),
      name,
      color: SECTION_COLORS[index % SECTION_COLORS.length] ?? SECTION_COLORS[0]!,
      createdAt: now
    }))
  }
}

function isValidSection(value: unknown): value is Section {
  if (!value || typeof value !== 'object') return false
  const section = value as Partial<Section>
  return typeof section.id === 'string' &&
    typeof section.name === 'string' &&
    typeof section.color === 'string' &&
    typeof section.createdAt === 'string'
}

function parseMarkdownFile(raw: string): { attributes: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { attributes: {}, body: raw }
  let attributes: Record<string, unknown> = {}
  try {
    attributes = (parse(match[1] ?? '') as Record<string, unknown>) ?? {}
  } catch {
    attributes = {}
  }
  return { attributes, body: (match[2] ?? '').replace(/^\r?\n/, '') }
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return 'Без названия'
  return value.trim().replace(/[\r\n]+/g, ' ').slice(0, 200) || 'Без названия'
}

function cleanTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^#/, '').replace(/\s+/g, '-').slice(0, 50))
    .filter(Boolean))].slice(0, 30)
}

function validDate(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return new Date().toISOString()
}

function notesEqual(a: Note, b: Note): boolean {
  return a.title === b.title &&
    a.content === b.content &&
    a.sectionId === b.sectionId &&
    a.favorite === b.favorite &&
    a.language === b.language &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
}

function cleanLanguage(value: unknown): string {
  // Extensible BCP-47-style metadata; no destructive rewrite of legacy files.
  return typeof value === 'string' && /^(?:auto|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i.test(value)
    ? value.toLowerCase() : 'auto'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function sanitizeFilename(value: string): string {
  const base = basename(value).normalize('NFC')
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return (cleaned || 'attachment').slice(0, 180)
}

function makeAttachmentInfo(
  originalName: string,
  storedName: string,
  relativePath: string,
  size: number,
  suppliedMimeType = ''
): AttachmentInfo {
  const mimeType = suppliedMimeType || mimeTypeForName(originalName)
  return {
    originalName,
    storedName,
    relativePath,
    mimeType,
    size,
    isImage: mimeType.startsWith('image/')
  }
}

function deletedAtFromTrashName(name: string): string {
  const match = name.match(/^[0-9a-f-]{36}-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/i)
  if (!match) return new Date(0).toISOString()
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

async function directorySize(directory: string): Promise<number> {
  if (!(await exists(directory))) return 0
  return (await collectRegularFiles(directory)).reduce((total, file) => total + file.size, 0)
}

async function fileSize(path: string): Promise<number> {
  if (!(await exists(path))) return 0
  const info = await stat(path)
  return info.isFile() ? info.size : 0
}

async function collectRegularFiles(directory: string): Promise<Array<{ absolutePath: string; size: number }>> {
  const result: Array<{ absolutePath: string; size: number }> = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) result.push(...await collectRegularFiles(path))
    else if (entry.isFile()) result.push({ absolutePath: path, size: (await stat(path)).size })
  }
  return result
}

function summarizeFiles(files: Array<{ size: number }>): CleanupSummary {
  return { count: files.length, bytes: files.reduce((total, file) => total + file.size, 0) }
}

function mimeTypeForName(name: string): string {
  const extension = extname(name).toLocaleLowerCase()
  const known: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar'
  }
  return known[extension] ?? 'application/octet-stream'
}

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoteRepository } from '../src/main/storage'

let root = ''
let repository: NoteRepository

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'locus-notes-test-'))
  repository = new NoteRepository(root)
  await repository.initialize()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Markdown-хранилище', () => {
  it('создаёт и повторно читает заметку с русским текстом и метаданными', async () => {
    const section = await repository.createSection('Эксперименты')
    const created = await repository.createNote(section.id)
    await repository.saveNote({
      id: created.id,
      title: 'Мембранный потенциал',
      content: '# Опыт\n\nФормула: $$E = kq/r^2$$\n\nТекст по-русски.',
      sectionId: section.id,
      tags: ['биофизика', 'идея'],
      favorite: true
    })

    const loaded = (await repository.listNotes())[0]
    expect(loaded).toMatchObject({
      title: 'Мембранный потенциал',
      sectionId: section.id,
      tags: ['биофизика', 'идея'],
      favorite: true
    })
    expect(loaded?.content).toContain('E = kq/r^2')
    const raw = await readFile(join(root, 'notes', `${created.id}.md`), 'utf8')
    expect(raw).toContain('---\n')
    expect(raw).toContain('# Опыт')
  })

  it('создаёт не более одной резервной копии заметки в день', async () => {
    const note = await repository.createNote()
    const first = await repository.saveNote({ ...note, title: 'Версия 1', content: 'Первое сохранение' })
    const second = await repository.saveNote({ ...first.note, title: 'Версия 2', content: 'Второе сохранение' })
    const day = new Date().toISOString().slice(0, 10)
    expect(first.backupCreated).toBe(true)
    expect(second.backupCreated).toBe(false)
    expect(await readdir(join(root, 'backups', day))).toHaveLength(1)
  })

  it('перемещает удалённую заметку в восстанавливаемую корзину', async () => {
    const note = await repository.createNote()
    expect(await repository.deleteNote(note.id)).toBe(true)
    expect(await repository.listNotes()).toHaveLength(0)
    const trashed = await repository.listTrash()
    expect(trashed[0]).toMatchObject({ id: note.id, title: note.title })
    await repository.restoreTrash(trashed[0]!.trashName)
    expect((await repository.listNotes())[0]?.id).toBe(note.id)
    expect(await repository.listTrash()).toHaveLength(0)
  })

  it('работает с большой заметкой без потери данных', async () => {
    const note = await repository.createNote()
    const content = 'Длинная строка с формулой $x^2$.\n'.repeat(20_000)
    await repository.saveNote({ ...note, content })
    expect((await repository.listNotes())[0]?.content).toBe(content)
  })

  it('экспортирует переносимую копию заметок и конфигурации', async () => {
    const note = await repository.createNote()
    const destination = join(root, 'export-check')
    await repository.copyExport(destination)
    expect(await readdir(join(destination, 'notes'))).toContain(`${note.id}.md`)
    expect(await readFile(join(destination, 'config.json'), 'utf8')).toContain('sections')
    expect(await readFile(join(destination, 'README.txt'), 'utf8')).toContain('attachments')
  })

  it('восстанавливается после повреждения config.json и сохраняет его копию', async () => {
    await writeFile(join(root, 'config.json'), '{ это не JSON', 'utf8')
    const originalConsoleError = console.error
    console.error = () => undefined
    const recovered = await repository.listSections().finally(() => { console.error = originalConsoleError })
    expect(recovered).toHaveLength(5)
    const files = await readdir(root)
    expect(files.some((file) => file.startsWith('config.corrupt-'))).toBe(true)
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).sections).toHaveLength(5)
  })

  it('копирует изображения и обычные файлы в управляемое переносимое хранилище', async () => {
    const note = await repository.createNote()
    const sources = join(root, 'исходные файлы')
    await mkdir(sources)
    const pngSource = join(sources, 'снимок опыта 01.png')
    const pdfSource = join(sources, 'статья с пробелами.pdf')
    const archiveSource = join(sources, 'данные эксперимента.zip')
    await writeFile(pngSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await writeFile(pdfSource, Buffer.from('%PDF-1.7'))
    await writeFile(archiveSource, Buffer.from('ZIP'))

    const imported = await repository.importAttachments(note.id, [pngSource, pdfSource, archiveSource])
    expect(imported).toHaveLength(3)
    expect(imported[0]).toMatchObject({ originalName: 'снимок опыта 01.png', isImage: true, mimeType: 'image/png' })
    expect(imported[1]).toMatchObject({ originalName: 'статья с пробелами.pdf', isImage: false, mimeType: 'application/pdf' })
    expect(imported[0]?.relativePath).toContain('../attachments/')

    const storedImage = repository.resolveAttachmentPath(imported[0]!.relativePath)
    await rm(pngSource)
    expect(await readFile(storedImage)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const day = new Date().toISOString().slice(0, 10)
    const backedUp = join(root, 'backups', day, 'attachments', note.id, imported[0]!.storedName)
    expect(await readFile(backedUp)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(() => repository.resolveAttachmentPath('../attachments/../config.json')).toThrow()
  })

  it('включает вложения в полный экспорт', async () => {
    const note = await repository.createNote()
    const attachment = await repository.saveAttachmentBytes(
      note.id,
      new Uint8Array([1, 2, 3, 4]),
      'результаты опыта.bin',
      'application/octet-stream'
    )
    const destination = join(root, 'full-export')
    await repository.copyExport(destination)
    const exported = join(destination, 'attachments', note.id, attachment.storedName)
    expect([...await readFile(exported)]).toEqual([1, 2, 3, 4])
  })

  it('сохраняет вложения при перемещении в корзину и восстановлении', async () => {
    const note = await repository.createNote()
    const attachment = await repository.saveAttachmentBytes(note.id, new Uint8Array([9, 8, 7]), 'опыт 🧪.png', 'image/png')
    await repository.saveNote({ ...note, content: `![опыт](${attachment.relativePath})` })
    const stored = repository.resolveAttachmentPath(attachment.relativePath)

    await repository.deleteNote(note.id)
    expect(await readFile(stored)).toEqual(Buffer.from([9, 8, 7]))
    expect(await repository.scanUnusedAttachments()).toEqual({ count: 0, bytes: 0 })
    const trashed = (await repository.listTrash())[0]!
    await repository.restoreTrash(trashed.trashName)
    expect(await readFile(stored)).toEqual(Buffer.from([9, 8, 7]))
  })

  it('окончательно удаляет только вложения выбранной заметки из корзины', async () => {
    const active = await repository.createNote()
    const activeAttachment = await repository.saveAttachmentBytes(active.id, new Uint8Array([1, 2]), 'активный.pdf', 'application/pdf')
    await repository.saveNote({ ...active, content: `[активный](${activeAttachment.relativePath})` })

    const removed = await repository.createNote()
    const removedAttachment = await repository.saveAttachmentBytes(removed.id, new Uint8Array([3, 4, 5]), 'удаляемый.zip', 'application/zip')
    await repository.saveNote({ ...removed, content: `[архив](${removedAttachment.relativePath})` })
    await repository.deleteNote(removed.id)
    const trashed = (await repository.listTrash())[0]!
    const result = await repository.deleteTrashPermanently(trashed.trashName)

    expect(result).toMatchObject({ notes: 1, attachments: 1 })
    await expect(access(repository.resolveAttachmentPath(removedAttachment.relativePath))).rejects.toThrow()
    expect(await readFile(repository.resolveAttachmentPath(activeAttachment.relativePath))).toEqual(Buffer.from([1, 2]))
  })

  it('очистка корзины удаляет её заметки и не затрагивает активные файлы', async () => {
    const active = await repository.createNote()
    const activeAttachment = await repository.saveAttachmentBytes(active.id, new Uint8Array([7]), 'важный документ.docx', '')
    await repository.saveNote({ ...active, content: `[важный](${activeAttachment.relativePath})` })
    for (const name of ['первая', 'вторая']) {
      const note = await repository.createNote()
      const file = await repository.saveAttachmentBytes(note.id, new Uint8Array([5]), `${name}.bin`, '')
      await repository.saveNote({ ...note, content: `[${name}](${file.relativePath})` })
      await repository.deleteNote(note.id)
    }

    const result = await repository.emptyTrash()
    expect(result.notes).toBe(2)
    expect(result.attachments).toBe(2)
    expect(await repository.listTrash()).toHaveLength(0)
    expect(await readFile(repository.resolveAttachmentPath(activeAttachment.relativePath))).toEqual(Buffer.from([7]))
  })

  it('находит только действительно неиспользуемые вложения, включая Unicode и пробелы', async () => {
    const active = await repository.createNote()
    const used = await repository.saveAttachmentBytes(active.id, new Uint8Array([1, 1]), 'используется 🧬 01.jpg', 'image/jpeg')
    const unused = await repository.saveAttachmentBytes(active.id, new Uint8Array([2, 2, 2]), 'лишний файл 🗂️.pdf', 'application/pdf')
    await repository.saveNote({ ...active, content: `![фото](${used.relativePath})` })

    const trashed = await repository.createNote()
    const trashAttachment = await repository.saveAttachmentBytes(trashed.id, new Uint8Array([3, 3, 3, 3]), 'нужен после восстановления.zip', 'application/zip')
    await repository.saveNote({ ...trashed, content: `[архив](${trashAttachment.relativePath})` })
    await repository.deleteNote(trashed.id)

    expect(await repository.scanUnusedAttachments()).toEqual({ count: 1, bytes: 3 })
    expect(await repository.cleanupUnusedAttachments()).toEqual({ count: 1, bytes: 3 })
    await expect(access(repository.resolveAttachmentPath(unused.relativePath))).rejects.toThrow()
    expect(await readFile(repository.resolveAttachmentPath(used.relativePath))).toEqual(Buffer.from([1, 1]))
    expect(await readFile(repository.resolveAttachmentPath(trashAttachment.relativePath))).toEqual(Buffer.from([3, 3, 3, 3]))
  })

  it('подсчитывает размер заметок, вложений, корзины, backups и общий объём', async () => {
    const note = await repository.createNote()
    await repository.saveAttachmentBytes(note.id, new Uint8Array(4096), 'размер файла.bin', '')
    await repository.saveNote({ ...note, content: 'Изменение для резервной копии' })
    const deleted = await repository.createNote()
    await repository.deleteNote(deleted.id)

    const stats = await repository.getStorageStats()
    expect(stats.notesBytes).toBeGreaterThan(0)
    expect(stats.attachmentsBytes).toBe(4096)
    expect(stats.trashBytes).toBeGreaterThan(0)
    expect(stats.backupsBytes).toBeGreaterThan(0)
    expect(stats.totalBytes).toBeGreaterThanOrEqual(stats.notesBytes + stats.attachmentsBytes + stats.trashBytes + stats.backupsBytes)
  })
})

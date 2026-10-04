import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoteRepository } from '../src/main/storage'

let root: string
let repository: NoteRepository
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'locus-v13-storage-'))
  repository = new NoteRepository(root)
  await repository.initialize()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('v1.3 language compatibility', () => {
  it('reads legacy notes as auto without rewriting files; persists language with an original backup', async () => {
    const note = await repository.createNote()
    const path = join(root, 'notes', `${note.id}.md`)
    const legacy = (await readFile(path, 'utf8')).replace('language: auto\n', '')
    await writeFile(path, legacy)
    const loaded = (await repository.listNotes())[0]!
    expect(loaded.language).toBe('auto')
    expect(await readFile(path, 'utf8')).toBe(legacy)
    await repository.saveNote({ ...loaded, language: 'ru' })
    const restarted = new NoteRepository(root)
    expect((await restarted.listNotes())[0]?.language).toBe('ru')
    const day = new Date().toISOString().slice(0, 10)
    expect(await readFile(join(root, 'backups', day, `${note.id}.md`), 'utf8')).toBe(legacy)
    const updated = (await restarted.listNotes())[0]!
    const { language: _language, ...oldClientUpdate } = updated
    await restarted.saveNote(oldClientUpdate)
    expect((await restarted.listNotes())[0]?.language).toBe('ru')
    await restarted.deleteNote(note.id)
    const trashed = (await restarted.listTrash())[0]!
    expect(trashed.language).toBe('ru')
    expect((await restarted.restoreTrash(trashed.trashName)).language).toBe('ru')
  })
  it('accepts extensible codes and defaults malformed language to auto', async () => {
    const note = await repository.createNote()
    for (const [value, expected] of [['en', 'en'], ['pt-BR', 'pt-br'], ['', 'auto'], ['<script>', 'auto']]) {
      await repository.saveNote({ ...note, language: value })
      expect((await repository.listNotes())[0]?.language).toBe(expected)
    }
  })
})

describe('v1.3 safe section deletion', () => {
  it('preserves active/trash notes, unknown metadata, exact bodies, attachments and backups across restart', async () => {
    const section = await repository.createSection('Удаляемый раздел')
    const other = await repository.createSection('Оставшийся раздел')
    const active = await repository.createNote(section.id)
    const deleted = await repository.createNote(section.id)
    const unaffected = await repository.createNote(other.id)
    const file = await repository.saveAttachmentBytes(active.id, new Uint8Array([1, 2, 3]), 'важный.pdf')
    await repository.saveNote({ ...active, title: 'Название', content: `Текст\n[файл](${file.relativePath})\n\n`, language: 'en', tags: ['тег'], favorite: true })
    const path = join(root, 'notes', `${active.id}.md`)
    const original = (await readFile(path, 'utf8')).replace('favorite: true', 'customField: keep-me\nfavorite: true')
    await writeFile(path, original)
    await repository.deleteNote(deleted.id)
    const trash = (await repository.listTrash())[0]!
    const originalTrash = await readFile(join(root, 'trash', trash.trashName), 'utf8')
    expect(await repository.deleteSection(section.id)).toBe(true)
    expect(await repository.deleteSection(section.id)).toBe(false)
    const restarted = new NoteRepository(root)
    expect((await restarted.listSections()).some((item) => item.id === section.id)).toBe(false)
    expect((await restarted.listNotes()).find((item) => item.id === active.id)).toMatchObject({ sectionId: null, title: 'Название', language: 'en', tags: ['тег'], favorite: true })
    expect((await restarted.listNotes()).find((item) => item.id === unaffected.id)?.sectionId).toBe(other.id)
    const next = await readFile(path, 'utf8')
    expect(next).toContain('customField: keep-me')
    expect(next.slice(next.indexOf('\n---\n'))).toBe(original.slice(original.indexOf('\n---\n')))
    expect((await restarted.listTrash())[0]?.sectionId).toBeNull()
    expect((await restarted.restoreTrash(trash.trashName)).sectionId).toBeNull()
    expect(await readFile(restarted.resolveAttachmentPath(file.relativePath))).toEqual(Buffer.from([1, 2, 3]))
    expect(await restarted.scanUnusedAttachments()).toEqual({ count: 0, bytes: 0 })
    const day = new Date().toISOString().slice(0, 10)
    const snapshot = (await readdir(join(root, 'backups', day))).find((name) => name.startsWith(`section-${section.id}-`))!
    expect(await readFile(join(root, 'backups', day, snapshot, 'notes', `${active.id}.md`), 'utf8')).toBe(original)
    expect(await readFile(join(root, 'backups', day, snapshot, 'trash', trash.trashName), 'utf8')).toBe(originalTrash)
    expect(await readFile(join(root, 'backups', day, snapshot, 'config.json'), 'utf8')).toContain(section.id)
  })
  it('serializes deletion against stale saves, creation, and section creation', async () => {
    const section = await repository.createSection('Раздел')
    const note = await repository.createNote(section.id)
    const [, save, created, other] = await Promise.all([
      repository.deleteSection(section.id),
      repository.saveNote({ ...note, content: 'Последний текст' }),
      repository.createNote(section.id),
      repository.createSection('Другой')
    ])
    expect(save.note).toMatchObject({ content: 'Последний текст', sectionId: null })
    expect(created.sectionId).toBeNull()
    expect((await repository.listSections()).some((item) => item.id === other.id)).toBe(true)
  })
  it('protects system views and permits deleting all ordinary sections', async () => {
    for (const id of ['trash', 'storage', 'unsectioned', 'all']) {
      await expect(repository.deleteSection(id)).rejects.toThrow('системный раздел')
    }
    for (const section of await repository.listSections()) await repository.deleteSection(section.id)
    expect(await new NoteRepository(root).listSections()).toEqual([])
  })
  it('leaves the section and Markdown intact if a malformed front matter prevents deletion', async () => {
    const section = await repository.createSection('Безопасность')
    const note = await repository.createNote(section.id)
    const path = join(root, 'notes', `${note.id}.md`)
    const raw = `---\nsectionId: ${section.id}\nbroken: [\n---\n\nНельзя терять этот текст`
    await writeFile(path, raw)
    await expect(repository.deleteSection(section.id)).rejects.toThrow()
    expect((await repository.listSections()).some((item) => item.id === section.id)).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(raw)
  })
})

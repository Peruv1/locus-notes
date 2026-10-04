import { _electron as electron } from 'playwright-core'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import assert from 'node:assert/strict'

const dataDir = await mkdtemp(join(tmpdir(), 'locus-e2e-'))
const cwd = resolve('.')
const executablePath = process.env.LOCUS_E2E_EXECUTABLE ? resolve(process.env.LOCUS_E2E_EXECUTABLE) : electronPath
const packagedRun = executablePath !== electronPath
const initialWorkingDirectories = new Set((await readdir(cwd, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name))

async function launch() {
  return electron.launch({
    executablePath,
    args: [...(packagedRun ? [] : ['.']), `--user-data-dir=${join(dataDir, 'electron-profile')}`],
    cwd,
    env: { ...process.env, LOCUS_DATA_DIR: dataDir, LOCUS_TEST_MODE: '1' }
  })
}

async function syntheticFileEvent(page, kind, files) {
  await page.locator('[data-testid="note-content"]').evaluate((editor, payload) => {
    const transfer = new DataTransfer()
    for (const item of payload.files) {
      const binary = atob(item.base64)
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      transfer.items.add(new File([bytes], item.name, { type: item.type }))
    }
    const target = payload.kind === 'drop' ? editor.closest('[data-drop-zone]') : editor
    const event = payload.kind === 'drop'
      ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    target.dispatchEvent(event)
  }, { kind, files })
}

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const onePixelJpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDq6KKK/os/Kj//2Q=='
const tinyPdf = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64')
const tinyZip = Buffer.from('PK\u0003\u0004test archive').toString('base64')

let app
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => console.error('PAGE ERROR:', error.message))
  page.on('console', (message) => message.type() === 'error' && console.error('BROWSER:', message.text()))
  await page.waitForSelector('[data-testid="new-note"]')
  await page.waitForSelector('[data-filter="all"]')
  console.log('E2E 1/15: приложение запущено')

  await page.click('[data-testid="new-note"]')
  await page.waitForSelector('[data-testid="note-content"]:visible')
  await page.fill('[data-testid="note-content"]', '# Законы Ньютона\n\nРусский текст про силу.\n\n$$F = ma$$\n\n`код`')
  await page.fill('[data-testid="tags"]', 'физика, учёба')
  await page.locator('[data-testid="tags"]').blur()
  await page.click('[data-testid="favorite"]')
  await page.waitForTimeout(700)
  await page.waitForSelector('[data-save-status]:not(.saving):not(.error)')
  assert.equal(await page.inputValue('[data-testid="note-title"]'), 'Законы Ньютона')
  console.log('E2E 2/15: создание, автозаголовок, теги и избранное')

  await page.getByRole('button', { name: 'Просмотр', exact: true }).click()
  await page.waitForSelector('.katex')
  assert.match(await page.locator('[data-testid="preview"]').textContent(), /Русский текст/)
  await page.click('[data-testid="start-edit"]')
  await page.fill('[data-testid="note-content"]', '# Законы Ньютона\n\nИзменение в режиме редактирования.\n\n$$F = ma$$')
  await page.click('[data-testid="finish-edit"]')
  await page.waitForSelector('[data-testid="start-edit"]')
  assert.match(await page.locator('[data-testid="preview"]').textContent(), /Изменение в режиме редактирования/)
  console.log('E2E 3/15: просмотр → редактирование → просмотр и LaTeX')

  await page.click('[data-testid="start-edit"]')
  await syntheticFileEvent(page, 'drop', [
    { name: 'снимок опыта 01.png', type: 'image/png', base64: onePixelPng },
    { name: 'фотография опыта 02.jpeg', type: 'image/jpeg', base64: onePixelJpeg },
    { name: 'статья с пробелами.pdf', type: 'application/pdf', base64: tinyPdf },
    { name: 'данные эксперимента.zip', type: 'application/zip', base64: tinyZip }
  ])
  await page.waitForFunction(() => (document.querySelector('[data-testid="note-content"]')?.value.match(/\.\.\/attachments\//g) ?? []).length >= 4)
  await syntheticFileEvent(page, 'paste', [
    { name: 'вставка из буфера.png', type: 'image/png', base64: onePixelPng }
  ])
  await page.waitForFunction(() => (document.querySelector('[data-testid="note-content"]')?.value.match(/\.\.\/attachments\//g) ?? []).length >= 5)
  await page.click('[data-testid="finish-edit"]')
  await page.waitForSelector('.note-image')
  await page.waitForFunction(() => [...document.querySelectorAll('.note-image')].every((image) => image.complete && image.naturalWidth > 0))
  assert.equal(await page.locator('.note-image').count(), 3)
  assert.equal(await page.locator('.attachment-link').count(), 2)
  assert.match(await page.locator('.attachment-link').first().textContent(), /статья с пробелами\.pdf/)
  await page.locator('.attachment-link').first().click()
  await page.waitForSelector('.toast:has-text("Файл открыт")')
  await page.locator('[data-testid="reveal-attachment"]').first().click()
  await page.waitForSelector('.toast:has-text("Проводнике")')
  console.log('E2E 4/15: PNG/JPEG, clipboard, PDF, архив, открытие и показ в Проводнике')

  await page.click('[data-add-section]')
  await page.fill('[data-testid="dialog-input"]', 'Физика')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForSelector('button[data-filter="section"]:has-text("Физика")')
  console.log('E2E 5/15: создание раздела')

  await page.keyboard.press('Control+N')
  await page.fill('[data-testid="note-content"]', 'Связано с [[Законы Ньютона]]\n\nПоисковый маркер: гравитация')
  await page.waitForTimeout(700)
  await page.waitForSelector('[data-save-status]:not(.saving):not(.error)')
  await page.keyboard.press('Control+F')
  await page.keyboard.type('гравитация')
  assert.equal(await page.locator('[data-testid="note-card"]').count(), 1)
  console.log('E2E 6/15: поиск по содержимому')

  await page.keyboard.press('Control+K')
  await page.fill('#quick-input', 'Законы Ньютона')
  await page.keyboard.press('Enter')
  assert.equal(await page.inputValue('[data-testid="note-title"]'), 'Законы Ньютона')
  assert.equal(await page.locator('.note-image').count(), 3)
  console.log('E2E 7/15: быстрый переход и сохранность вложений при переключении')

  await page.click('[data-testid="start-edit"]')
  const contentWithAttachments = await page.inputValue('[data-testid="note-content"]')
  const longText = `${contentWithAttachments}\n\n${'Очень длинная заметка.\n'.repeat(5000)}`
  await page.locator('[data-testid="note-content"]').evaluate((element, value) => {
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, longText)
  await page.click('[data-testid="close-note"]')
  await page.waitForSelector('#empty-title:has-text("Заметка закрыта")')
  await page.keyboard.press('Control+K')
  await page.fill('#quick-input', 'Законы Ньютона')
  await page.keyboard.press('Enter')
  assert.equal((await page.inputValue('[data-testid="note-content"]')).length, longText.length)
  console.log('E2E 8/15: закрытие заметки сохранило несохранённое изменение')

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('[data-testid="note-card"]')
  assert.equal(await page.locator('[data-testid="start-edit"]').count(), 0)
  await page.locator('[data-testid="note-card"]').filter({ has: page.getByRole('heading', { name: 'Законы Ньютона', exact: true }) }).click()
  await page.waitForSelector('[data-testid="start-edit"]')
  assert.equal(await page.inputValue('[data-testid="note-title"]'), 'Законы Ньютона')
  assert.equal((await page.inputValue('[data-testid="note-content"]')).length, longText.length)
  console.log('E2E 9/15: холодный запуск → выбор существующей заметки → кнопка «Редактировать»')

  await page.evaluate(async () => {
    for (let index = 0; index < 35; index += 1) await window.locus.createSection(`Дополнительный раздел ${index + 1}`)
    for (let index = 0; index < 28; index += 1) {
      const note = await window.locus.createNote()
      await window.locus.saveNote({
        id: note.id,
        title: `Тест прокрутки ${index + 1}`,
        content: `Заметка для проверки тега ${index + 1}`,
        sectionId: null,
        tags: [`длинный-тег-${index + 1}`],
        favorite: false
      })
    }
  })
  await page.reload()
  await page.waitForSelector('[data-testid="sidebar-scroll"]')
  const scrollState = await page.locator('[data-testid="sidebar-scroll"]').evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    sectionCount: element.querySelectorAll('[data-filter="section"]').length,
    tagCount: element.querySelectorAll('[data-filter="tag"]').length
  }))
  assert.ok(scrollState.scrollHeight > scrollState.clientHeight)
  assert.ok(scrollState.sectionCount >= 40)
  assert.ok(scrollState.tagCount >= 28)
  const primaryTopBefore = await page.locator('.nav-primary').evaluate((element) => element.getBoundingClientRect().top)
  await page.locator('[data-testid="sidebar-scroll"]').evaluate((element) => { element.scrollTop = 1000 })
  const primaryTopAfter = await page.locator('.nav-primary').evaluate((element) => element.getBoundingClientRect().top)
  assert.equal(primaryTopAfter, primaryTopBefore)
  console.log('E2E 10/15: прокрутка 40 разделов и 28 тегов при фиксированной навигации')

  await page.keyboard.press('Control+K')
  await page.fill('#quick-input', 'Законы Ньютона')
  await page.keyboard.press('Enter')
  await page.click('[data-testid="delete-note"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForTimeout(250)
  assert.notEqual(await page.inputValue('[data-testid="note-title"]'), 'Законы Ньютона')
  await page.click('[data-filter="trash"]')
  await page.locator('[data-testid="trash-card"]').filter({ has: page.getByRole('heading', { name: 'Законы Ньютона', exact: true }) }).click()
  assert.equal(await page.locator('[data-testid="trash-preview"] .note-image').count(), 3)
  assert.equal(await page.locator('[data-testid="trash-preview"] .attachment-link').count(), 2)
  await page.locator('[data-testid="trash-preview"] .attachment-link').first().click()
  await page.waitForSelector('.toast:has-text("Файл открыт")')
  await page.click('[data-testid="restore-trash"]')
  await page.waitForSelector('[data-testid="start-edit"]')
  assert.equal(await page.locator('.note-image').count(), 3)
  console.log('E2E 11/15: корзина → PNG/PDF сохранены → восстановление')

  await page.click('[data-testid="delete-note"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.click('[data-filter="trash"]')
  await page.locator('[data-testid="trash-card"]').filter({ has: page.getByRole('heading', { name: 'Законы Ньютона', exact: true }) }).click()
  await page.click('[data-testid="delete-trash-permanently"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForSelector('#empty-title:has-text("Корзина пуста")')
  console.log('E2E 12/15: окончательное удаление заметки и принадлежащих ей вложений')

  await page.click('[data-testid="new-note"]')
  await page.fill('[data-testid="note-content"]', '# Проверка очистки')
  await syntheticFileEvent(page, 'drop', [
    { name: 'используемый файл.pdf', type: 'application/pdf', base64: tinyPdf },
    { name: 'неиспользуемый файл.zip', type: 'application/zip', base64: tinyZip }
  ])
  await page.waitForFunction(() => (document.querySelector('[data-testid="note-content"]')?.value.match(/\.\.\/attachments\//g) ?? []).length >= 2)
  await page.locator('[data-testid="note-content"]').evaluate((element) => {
    element.value = element.value.split('\n').filter((line) => !line.includes('неиспользуемый')).join('\n')
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('[data-testid="finish-edit"]')
  await page.waitForSelector('.attachment-link')
  assert.equal(await page.locator('.attachment-link').count(), 1)
  await page.click('[data-filter="storage"]')
  await page.waitForSelector('[data-testid="storage-panel"]')
  assert.match(await page.locator('[data-testid="storage-total"]').textContent(), /Б|КБ|МБ/)
  await page.click('[data-testid="open-storage-folder"]')
  await page.click('[data-testid="clean-unused"]')
  await page.waitForSelector('#action-message:has-text("Найдено файлов: 1")')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForSelector('.toast:has-text("Удалено неиспользуемых файлов: 1")')
  console.log('E2E 13/15: статистика хранилища и подтверждаемая очистка одного orphan-файла')

  await page.click('[data-testid="new-note"]')
  await page.fill('[data-testid="note-content"]', 'Временная заметка для очистки корзины')
  await page.waitForTimeout(700)
  await page.click('[data-testid="delete-note"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.click('[data-filter="storage"]')
  await page.click('[data-testid="empty-trash"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForSelector('.toast:has-text("Удалено заметок: 1")')
  await page.keyboard.press('Control+K')
  await page.fill('#quick-input', 'Проверка очистки')
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('.attachment-link').count(), 1)
  console.log('E2E 14/15: очистка корзины через раздел «Хранилище»')

  const finalWorkingDirectories = (await readdir(cwd, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const unexpectedDirectories = finalWorkingDirectories.filter((name) => !initialWorkingDirectories.has(name))
  assert.deepEqual(unexpectedDirectories, [])
  console.log(`E2E 15/15: ${packagedRun ? 'production' : 'development'}-приложение не создало посторонних папок.`)

  await app.close()
  app = undefined
} finally {
  if (app) await app.close().catch(() => app.process().kill())
  await rm(dataDir, { recursive: true, force: true })
}

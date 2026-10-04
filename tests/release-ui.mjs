import { _electron as electron } from 'playwright-core'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { execFile } from 'node:child_process'

const root = await mkdtemp(join(tmpdir(), 'locus-v13-ui-'))
const output = resolve('tests/diagnostics')
const packagedExecutable = process.env.LOCUS_RELEASE_EXECUTABLE
const legacyId = '11111111-1111-4111-8111-111111111111'
await mkdir(join(root, 'notes'), { recursive: true })
await mkdir(output, { recursive: true })
await writeFile(join(root, 'notes', `${legacyId}.md`), `---\nid: ${legacyId}\ntitle: Старая заметка\ncreatedAt: 2026-09-20T10:00:00Z\nupdatedAt: 2026-09-20T10:00:00Z\nsectionId: null\ntags: []\nfavorite: false\n---\n\nСтарое содержимое`)
let app
let page
const errors = []
try {
  await launch()
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), '1.3.0')
  assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()), null)
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration }
  })
  assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false })
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  const trustedUrl = page.url()
  await page.evaluate(() => { location.href = 'data:text/html,<h1>Untrusted page</h1>' })
  await page.waitForTimeout(200)
  assert.equal(page.url(), trustedUrl)
  // Load the same preload in a separate, hidden window: its IPC must be denied.
  const denied = await app.evaluate(async ({ BrowserWindow, app }) => {
    const main = BrowserWindow.getAllWindows()[0]
    const other = new BrowserWindow({ show: false, webPreferences: {
      preload: `${app.getAppPath()}/out/preload/index.cjs`,
      sandbox: true, contextIsolation: true, nodeIntegration: false
    } })
    try {
      await other.loadURL(main.webContents.getURL())
      return await other.webContents.executeJavaScript(`window.locus.listNotes().then(() => false, error => error.message.includes('untrusted frame'))`)
    } finally { other.destroy() }
  })
  assert.equal(denied, true)
  console.log('Security: sandbox/context isolation, no renderer Node API, blocked navigation and rejected foreign-window IPC.')
  await page.locator('[data-note-id]').first().click()
  assert.equal(await page.locator('[data-language]').inputValue(), 'auto')
  await page.click('[data-start-edit]')
  const editor = page.locator('[data-editor]')

  await editor.fill('Текст $\\s')
  await popupVisible()
  assert.deepEqual(await page.locator('.latex-autocomplete [role=option]').allTextContents(), ['\\sqrt', '\\sum', '\\sin', '\\sigma'])
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert.equal(await editor.inputValue(), 'Текст $\\sum')
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true)
  assert.equal(await page.locator('.latex-autocomplete').isVisible(), false)

  await editor.fill('Обычный текст $\\fr')
  await popupVisible()
  await page.keyboard.press('Tab')
  assert.equal(await editor.inputValue(), 'Обычный текст $\\frac')
  await page.keyboard.type('{}{}$ и обычный текст')
  assert.equal(await editor.inputValue(), 'Обычный текст $\\frac{}{}$ и обычный текст')
  assert.equal(await page.locator('.latex-autocomplete').isVisible(), false)

  await editor.fill('\\sq')
  await popupVisible()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.latex-autocomplete').isVisible(), false)
  await page.keyboard.press('Backspace')
  await popupVisible()
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.locator('.latex-autocomplete .active').textContent(), '\\sigma')
  await page.keyboard.type('zz')
  assert.equal(await page.locator('.latex-autocomplete').isVisible(), false)
  await editor.fill('\\fr')
  await popupVisible()
  await page.locator('.latex-autocomplete [role=option]').first().click()
  assert.equal(await editor.inputValue(), '\\frac')
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true)

  for (const text of ['Обычный ввод', '\\fr', `${'Длинная заметка\n\n'.repeat(3000)}\\fr`]) {
    if (text.length > 10000) await setLongContent(editor, text)
    else await editor.fill(text)
    await editor.evaluate((element) => { element.scrollTop = element.scrollHeight })
    if (text.endsWith('\\fr')) {
      await popupVisible()
      await page.screenshot({ path: join(output, text.length > 10000 ? 'v13-long-autocomplete.png' : 'v13-autocomplete.png') })
      const popupGeometry = await page.locator('.latex-autocomplete').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, viewport: innerHeight, width: innerWidth }
      })
      assert.ok(popupGeometry.top >= 0 && popupGeometry.bottom <= popupGeometry.viewport)
      assert.ok(popupGeometry.left >= 0 && popupGeometry.right <= popupGeometry.width)
    }
    const before = await editor.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd }))
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press('Shift+Alt')
      await page.keyboard.press('Alt+Shift')
    }
    await page.keyboard.press('Alt')
    const after = await editor.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element }))
    assert.deepEqual({ start: after.start, end: after.end }, before)
    assert.equal(after.focused, true)
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false)
    assert.equal(await editor.inputValue(), text)
    if (text.endsWith('\\fr')) assert.equal(await page.locator('.latex-autocomplete').isVisible(), true)
  }
  console.log('v1.3: autocomplete navigation/accept/Escape/Backspace/no matches/mouse; Alt and both Shift+Alt orders preserve focus and caret (automated events).')

  const long = `# Длинная заметка\n\n${'Абзац для прокрутки.\n\n'.repeat(3000)}`
  await setLongContent(editor, long)
  await page.click('[data-view=split]')
  await page.waitForFunction(() => document.querySelector('[data-preview]').textContent.includes('Абзац'))
  for (const zoom of [1, 1.25, 1.5, 0.8]) {
    await app.evaluate(({ BrowserWindow }, factor) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor) }, zoom)
    for (const size of [[1440, 900], [960, 620], [1200, 760]]) {
      await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size)
      await page.waitForTimeout(100)
      await assertLayout()
    }
  }
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(1)
    window.setSize(1440, 900)
  })
  await page.click('[data-finish-edit]')
  await assertLayout()
  await page.screenshot({ path: join(output, 'v13-long-preview.png') })
  await page.click('[data-start-edit]')
  await editor.fill('Короткая заметка $\\sqrt{4}$')
  await page.locator('[data-language]').selectOption('ru')
  await page.keyboard.press('Control+s')
  await page.waitForFunction(() => document.querySelector('[data-save-status]').textContent === 'Сохранено')
  await page.click('[data-finish-edit]')
  await page.waitForSelector('.katex')
  await page.locator('[data-language]').selectOption('en')
  // Closing immediately checks pending metadata persistence during shutdown.
  await app.close()
  app = undefined
  await launch()
  await page.locator(`[data-note-id="${legacyId}"]`).click()
  assert.equal(await page.locator('[data-language]').inputValue(), 'en')
  assert.ok((await readFile(join(root, 'notes', `${legacyId}.md`), 'utf8')).includes('language: en'))
  await assertLayout()
  console.log('v1.3: short/long edit, split and preview; resize and 80–150% zoom; language and unsaved shutdown/restart persistence.')

  await page.click('[data-add-section]')
  await page.fill('#action-input', 'Раздел релиза')
  await page.click('#action-confirm')
  await page.waitForSelector('[data-filter=section].active')
  const sectionId = await page.locator('[data-filter=section].active').getAttribute('data-id')
  await page.keyboard.press('Control+n')
  await page.locator('[data-title]').fill('Сохранить после удаления раздела')
  await page.locator('[data-editor]').fill('Важное содержимое')
  await page.locator('[data-language]').selectOption('ru')
  // Wait for normal autosave, without Ctrl+S.
  await page.waitForFunction(() => document.querySelector('[data-save-status]').textContent === 'Сохранено')
  const id = await page.locator('[data-note-editor]').getAttribute('data-note-editor')
  await page.click(`[data-delete-section="${sectionId}"]`)
  await page.waitForSelector('#action-dialog:not([hidden])')
  await page.click('#action-cancel')
  assert.equal(await page.locator(`[data-filter=section][data-id="${sectionId}"]`).count(), 1)
  await page.click(`[data-delete-section="${sectionId}"]`)
  await page.click('#action-confirm')
  await page.waitForSelector('[data-filter=unsectioned].active')
  assert.equal(await page.locator(`[data-filter=section][data-id="${sectionId}"]`).count(), 0)
  assert.equal(await page.locator('[data-section]').inputValue(), '')
  assert.equal(await page.locator('[data-editor]').inputValue(), 'Важное содержимое')
  assert.equal(await page.locator('[data-language]').inputValue(), 'ru')
  assert.equal(await page.locator(`[data-note-id="${id}"]`).count(), 1)
  await page.click('[data-filter=all]')
  await page.click('[data-filter=section]')
  await page.click('[data-filter=unsectioned]')
  assert.equal(await page.locator(`[data-note-id="${id}"]`).count(), 1)

  await page.click('[data-delete]')
  await page.click('#action-confirm')
  await page.click('[data-filter=trash]')
  await page.locator('[data-trash-name]').first().click()
  await page.click('[data-restore-trash]')
  await page.waitForSelector('[data-start-edit]')
  assert.equal(await page.locator('[data-language]').inputValue(), 'ru')
  assert.equal(await page.locator('[data-section]').inputValue(), '')
  assert.match(await page.locator('[data-preview]').textContent(), /Важное содержимое/)
  await page.click('[data-filter=storage]')
  await page.waitForSelector('[data-testid=storage-panel]')
  await page.keyboard.press('Control+f')
  assert.equal(await page.locator('#search').evaluate((element) => document.activeElement === element), true)
  await page.keyboard.press('Control+k')
  await page.fill('#quick-input', 'Сохранить после удаления')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-start-edit]')
  // Cyrillic key values on the same physical keys keep shortcuts working.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'а', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })))
  assert.equal(await page.locator('#search').evaluate((element) => document.activeElement === element), true)
  await app.close()
  app = undefined
  await launch()
  await page.click('[data-filter=unsectioned]')
  await page.locator(`[data-note-id="${id}"]`).click()
  assert.equal(await page.locator('[data-language]').inputValue(), 'ru')
  assert.match(await page.locator('[data-preview]').textContent(), /Важное содержимое/)
  assert.equal(await page.locator(`[data-filter=section][data-id="${sectionId}"]`).count(), 0)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(output, 'v13-note-metadata.png') })
  console.log('v1.3: section create/switch/delete/cancel, note preservation, Trash/restore/Storage, shortcuts, restart after deletion. No renderer errors.')
} catch (error) {
  console.error(String(error).slice(0, 1000))
  if (page) await page.screenshot({ path: join(output, 'v13-failure.png'), timeout: 3000 }).catch(() => {})
  throw error
} finally {
  if (app) await closeTestApp(app)
  await rm(root, { recursive: true, force: true })
}

async function closeTestApp(application) {
  let timer
  try {
    await Promise.race([
      application.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test shutdown timeout')), 5000) })
    ])
  } catch {
    const process = application.process()
    if (process.exitCode === null && process.pid) {
      // Only the process launched by this test and its children are terminated.
      if (globalThis.process.platform === 'win32') {
        await new Promise((resolveExit) => execFile('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true }, resolveExit))
      } else process.kill('SIGKILL')
    }
  } finally { clearTimeout(timer) }
}

async function launch() {
  app = await electron.launch({
    executablePath: packagedExecutable ? resolve(packagedExecutable) : electronPath,
    args: [...(packagedExecutable ? [] : ['.']), `--user-data-dir=${join(root, '.electron-profile')}`],
    cwd: resolve('.'), env: { ...process.env, LOCUS_DATA_DIR: root, LOCUS_TEST_MODE: '1' }
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('[data-note-id]')
}
async function popupVisible() { await page.waitForSelector('.latex-autocomplete:not([hidden])') }
async function setLongContent(editor, text) {
  await editor.evaluate((element, value) => {
    element.value = value
    element.focus()
    element.setSelectionRange(value.length, value.length)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
}
async function assertLayout() {
  const geometry = await page.evaluate(() => {
    const preview = document.querySelector('[data-preview]')
    const textarea = document.querySelector('[data-editor]')
    const sidebar = document.querySelector('.sidebar')
    const header = document.querySelector('.editor-header')
    const footer = document.querySelector('.editor-footer')
    const before = [sidebar.getBoundingClientRect().top, header.getBoundingClientRect().top, footer.getBoundingClientRect().bottom]
    preview.scrollTop = preview.scrollHeight
    if (textarea) textarea.scrollTop = textarea.scrollHeight
    return {
      body: document.body.scrollHeight, viewport: innerHeight,
      workspace: document.querySelector('#workspace').getBoundingClientRect().height,
      previewScroll: preview.scrollTop, previewOverflow: preview.scrollHeight > preview.clientHeight,
      before, after: [sidebar.getBoundingClientRect().top, header.getBoundingClientRect().top, footer.getBoundingClientRect().bottom]
    }
  })
  assert.ok(geometry.body <= geometry.viewport + 1)
  assert.ok(geometry.workspace <= geometry.viewport + 1)
  assert.deepEqual(geometry.after, geometry.before)
  assert.ok(geometry.before[2] <= geometry.viewport + 1)
  if (geometry.previewOverflow) assert.ok(geometry.previewScroll > 0)
}

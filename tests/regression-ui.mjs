import { _electron as electron } from 'playwright-core'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const root = await mkdtemp(join(tmpdir(), 'locus-regression-ui-'))
const output = resolve('tests', 'diagnostics')
const packagedExecutable = process.env.LOCUS_REGRESSION_EXECUTABLE
const activeId = '11111111-1111-4111-8111-111111111111'
const trashFixtures = [
  ['22222222-2222-4222-8222-222222222222', 'Удалённая для восстановления'],
  ['33333333-3333-4333-8333-333333333333', 'Удалённая навсегда'],
  ['44444444-4444-4444-8444-444444444444', 'Очистить один'],
  ['55555555-5555-4555-8555-555555555555', 'Очистить два']
]

await Promise.all([
  mkdir(join(root, 'notes'), { recursive: true }),
  mkdir(join(root, 'trash'), { recursive: true }),
  mkdir(output, { recursive: true })
])
await writeFile(join(root, 'config.json'), '{"version":1,"sections":[]}\n', 'utf8')
await writeMarkdown(join(root, 'notes', `${activeId}.md`), activeId, 'Существующая до запуска', '# Исходный текст')
for (const [id, title] of trashFixtures) {
  await writeMarkdown(join(root, 'trash', `${id}-2026-09-20T10-00-00-000Z.md`), id, title, `# ${title}`)
}

let app
try {
  app = await launch()
  let page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('[data-testid="note-card"]')
  assert.equal((await readdir(join(root, 'notes'))).length, 1, 'Тест не должен создавать заметку для инициализации')

  await noteCard(page, 'Существующая до запуска').click()
  await assertVisibleAndClickable(page.locator('[data-testid="start-edit"]'), 'Редактировать')
  await assertVisibleAndClickable(page.locator('[data-testid="close-note"]'), 'Закрыть')
  const coldGeometry = await page.evaluate(() => ({
    workspaceScrollTop: document.querySelector('#workspace')?.scrollTop,
    emptyDisplay: getComputedStyle(document.querySelector('#empty-state')).display,
    editorTop: document.querySelector('#editor-host')?.getBoundingClientRect().top
  }))
  assert.equal(coldGeometry.workspaceScrollTop, 0)
  assert.equal(coldGeometry.emptyDisplay, 'none')

  await page.click('[data-testid="start-edit"]')
  await assertVisibleAndClickable(page.locator('[data-testid="finish-edit"]'), 'Готово')
  await page.locator('[data-testid="note-content"]').fill('# Исходный текст\n\nИзменение сохранено после cold start')
  await page.click('[data-testid="finish-edit"]')
  await page.waitForSelector('[data-testid="preview"]:has-text("Изменение сохранено после cold start")')
  await page.screenshot({ path: join(output, 'regression-cold-note.png') })

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('[data-testid="note-card"]')
  await noteCard(page, 'Существующая до запуска').click()
  await page.waitForSelector('[data-testid="preview"]:has-text("Изменение сохранено после cold start")')
  assert.equal((await readdir(join(root, 'notes'))).length, 1, 'Перезапуск не должен создавать новую заметку')
  console.log('Regression 1: pre-seeded note → visible Edit/Close → edit → Done → persisted restart.')

  await page.click('[data-filter="trash"]')
  assert.equal(await page.locator('#list-title').textContent(), 'Корзина')
  await assertVisibleAndClickable(page.locator('[data-testid="empty-trash-header"]'), 'Очистить корзину')
  await trashCard(page, 'Удалённая для восстановления').click()
  await assertVisibleAndClickable(page.locator('[data-testid="restore-trash"]'), 'Восстановить')
  await assertVisibleAndClickable(page.locator('[data-testid="delete-trash-permanently"]'), 'Удалить навсегда')
  await page.screenshot({ path: join(output, 'regression-trash-actions.png') })
  await page.click('[data-testid="restore-trash"]')
  await page.waitForSelector('[data-testid="start-edit"]')
  assert.equal(await noteCard(page, 'Удалённая для восстановления').count(), 1)

  await page.click('[data-filter="trash"]')
  assert.equal(await trashCard(page, 'Удалённая для восстановления').count(), 0)
  await trashCard(page, 'Удалённая навсегда').click()
  await page.click('[data-testid="delete-trash-permanently"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.click('[data-filter="trash"]')
  assert.equal(await trashCard(page, 'Удалённая навсегда').count(), 0)

  await assertVisibleAndClickable(page.locator('[data-testid="empty-trash-header"]'), 'Очистить корзину')
  await page.click('[data-testid="empty-trash-header"]')
  await page.click('[data-testid="dialog-confirm"]')
  await page.waitForSelector('#empty-title:has-text("Корзина пуста")')
  assert.equal(await page.locator('[data-testid="trash-card"]').count(), 0)
  assert.equal(await page.locator('[data-testid="empty-trash-header"]').isVisible(), false)
  console.log('Regression 2: visible Trash mode → restore → permanent delete → empty two notes → empty state.')
} finally {
  if (app) await app.close().catch(() => app.process().kill())
  await rm(root, { recursive: true, force: true })
}

async function launch() {
  return electron.launch({
    executablePath: packagedExecutable ? resolve(packagedExecutable) : electronPath,
    args: packagedExecutable ? [] : ['.', `--user-data-dir=${join(root, '.electron-profile')}`],
    cwd: resolve('.'),
    env: { ...process.env, LOCUS_DATA_DIR: root, LOCUS_TEST_MODE: '1' }
  })
}

async function writeMarkdown(path, id, title, content) {
  const now = '2026-09-20T10:00:00.000Z'
  const raw = `---\nid: ${id}\ntitle: ${title}\ncreatedAt: ${now}\nupdatedAt: ${now}\nsectionId: null\ntags: []\nfavorite: false\n---\n\n${content}`
  await writeFile(path, raw, 'utf8')
}

function noteCard(page, title) {
  return page.locator('[data-testid="note-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

function trashCard(page, title) {
  return page.locator('[data-testid="trash-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

async function assertVisibleAndClickable(locator, label) {
  await locator.waitFor({ state: 'visible' })
  const geometry = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return { hidden: element.hidden, display: style.display, visibility: style.visibility, width: rect.width, height: rect.height }
  })
  assert.equal(geometry.hidden, false, `${label}: hidden`)
  assert.notEqual(geometry.display, 'none', `${label}: display:none`)
  assert.notEqual(geometry.visibility, 'hidden', `${label}: visibility:hidden`)
  assert.ok(geometry.width > 0 && geometry.height > 0, `${label}: zero-sized`)
  assert.equal(await locator.isEnabled(), true, `${label}: disabled`)
}

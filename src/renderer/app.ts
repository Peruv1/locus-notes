import './styles.css'
import { renderMarkdown } from './markdown'
import { extractWikiLinks, normalizeSearch, noteMatches } from '../shared/search'
import { attachLatexAutocomplete } from './latex-autocomplete'
import type { AttachmentInfo, Note, Section, StorageStats, TrashNote } from '../shared/types'

type Filter =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'storage' }
  | { kind: 'unsectioned' }
  | { kind: 'section'; id: string }
  | { kind: 'tag'; name: string }

type ViewMode = 'edit' | 'split' | 'preview'
type SortMode = 'updated' | 'created' | 'title'

const elements = {
  newNote: byId<HTMLButtonElement>('new-note'),
  emptyCreate: byId<HTMLButtonElement>('empty-create'),
  emptyTitle: byId<HTMLElement>('empty-title'),
  emptyCopy: byId<HTMLElement>('empty-copy'),
  sidebarNav: byId<HTMLElement>('sidebar-nav'),
  search: byId<HTMLInputElement>('search'),
  sort: byId<HTMLSelectElement>('sort-notes'),
  listTitle: byId<HTMLElement>('list-title'),
  noteCount: byId<HTMLElement>('note-count'),
  noteList: byId<HTMLElement>('note-list'),
  emptyTrashHeader: byId<HTMLButtonElement>('empty-trash-header'),
  emptyState: byId<HTMLElement>('empty-state'),
  editorHost: byId<HTMLElement>('editor-host'),
  openData: byId<HTMLButtonElement>('open-data'),
  exportData: byId<HTMLButtonElement>('export-data'),
  quickSwitch: byId<HTMLElement>('quick-switch'),
  quickInput: byId<HTMLInputElement>('quick-input'),
  quickResults: byId<HTMLElement>('quick-results'),
  actionDialog: byId<HTMLElement>('action-dialog'),
  actionTitle: byId<HTMLElement>('action-title'),
  actionMessage: byId<HTMLElement>('action-message'),
  actionInput: byId<HTMLInputElement>('action-input'),
  actionCancel: byId<HTMLButtonElement>('action-cancel'),
  actionConfirm: byId<HTMLButtonElement>('action-confirm'),
  toasts: byId<HTMLElement>('toast-region')
}

let notes: Note[] = []
let trashNotes: TrashNote[] = []
let sections: Section[] = []
let selectedId: string | null = null
let selectedTrashName: string | null = null
let activeFilter: Filter = { kind: 'all' }
let viewMode: ViewMode = 'preview'
let sortMode: SortMode = 'updated'
let quickIndex = 0
let quickMatches: Note[] = []
let previewTimer: ReturnType<typeof setTimeout> | undefined
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlightSaves = new Map<string, Promise<void>>()
const versions = new Map<string, number>()
let dialogResolver: ((value: string | boolean | null) => void) | null = null
let disposeAutocomplete: (() => void) | undefined

void initialize()

async function initialize(): Promise<void> {
  try {
    ;[notes, trashNotes, sections] = await Promise.all([
      window.locus.listNotes(),
      window.locus.listTrash(),
      window.locus.listSections()
    ])
    bindStaticEvents()
    renderSidebar()
    renderList()
    showEmptyState()
  } catch (error) {
    showToast(`Не удалось открыть хранилище: ${messageOf(error)}`, true, 8000)
  }
}

function bindStaticEvents(): void {
  elements.newNote.addEventListener('click', () => void createNote())
  elements.emptyCreate.addEventListener('click', () => void createNote())
  elements.search.addEventListener('input', renderList)
  elements.sort.addEventListener('change', () => {
    sortMode = elements.sort.value as SortMode
    renderList()
  })
  elements.noteList.addEventListener('click', (event) => {
    const trashButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-trash-name]')
    if (trashButton?.dataset.trashName) {
      void selectTrashNote(trashButton.dataset.trashName)
      return
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-note-id]')
    if (button?.dataset.noteId) void selectNote(button.dataset.noteId)
  })
  elements.emptyTrashHeader.addEventListener('click', () => void emptyTrashFromStorage())
  elements.sidebarNav.addEventListener('click', (event) => void handleSidebarClick(event))
  elements.openData.addEventListener('click', () => void window.locus.openDataFolder())
  elements.exportData.addEventListener('click', () => void exportNotes())
  elements.quickSwitch.addEventListener('mousedown', (event) => {
    if (event.target === elements.quickSwitch) closeQuickSwitch()
  })
  elements.quickInput.addEventListener('input', () => {
    quickIndex = 0
    renderQuickResults()
  })
  elements.quickInput.addEventListener('keydown', handleQuickKeys)
  elements.quickResults.addEventListener('click', (event) => {
    const result = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-quick-id]')
    if (result?.dataset.quickId) {
      closeQuickSwitch()
      void selectNote(result.dataset.quickId)
    }
  })
  elements.actionCancel.addEventListener('click', () => closeActionDialog(null))
  elements.actionConfirm.addEventListener('click', confirmActionDialog)
  elements.actionInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirmActionDialog()
  })
  elements.actionDialog.addEventListener('mousedown', (event) => {
    if (event.target === elements.actionDialog) closeActionDialog(null)
  })
  document.addEventListener('keydown', handleGlobalKeys)
  window.addEventListener('blur', () => void saveAllPending())
  window.locus.onPrepareClose(async () => {
    await saveAllPending()
    window.locus.readyToClose()
  })
}

async function handleSidebarClick(event: Event): Promise<void> {
  const remove = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-section]')
  if (remove?.dataset.deleteSection) {
    await deleteSection(remove.dataset.deleteSection)
    return
  }
  const add = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-add-section]')
  if (add) {
    const name = await askText('Новый раздел', 'Раздел поможет отделить основное направление. Теги при этом останутся независимыми.', 'Например, Биофизика', 'Создать')
    if (typeof name !== 'string' || !name.trim()) return
    try {
      const section = await window.locus.createSection(name)
      if (!sections.some((item) => item.id === section.id)) sections.push(section)
      activeFilter = { kind: 'section', id: section.id }
      renderSidebar()
      renderList()
      showToast(`Раздел «${section.name}» создан`)
    } catch (error) {
      showToast(messageOf(error), true)
    }
    return
  }

  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]')
  if (!target) return
  const kind = target.dataset.filter
  if (kind === 'trash' || kind === 'storage') {
    await saveSelectedNow()
    activeFilter = { kind }
    selectedId = null
    selectedTrashName = null
    renderSidebar()
    renderList()
    if (kind === 'storage') await renderStorageView()
    else showEmptyState(
      false,
      trashNotes.length ? 'Выберите удалённую заметку' : 'Корзина пуста',
      trashNotes.length
        ? 'После выбора сверху появятся кнопки «Восстановить» и «Удалить навсегда».'
        : 'Удалённых заметок нет.',
      false
    )
    return
  }
  const leavingSpecialView = activeFilter.kind === 'trash' || activeFilter.kind === 'storage'
  if (kind === 'all' || kind === 'recent' || kind === 'favorites' || kind === 'unsectioned') activeFilter = { kind }
  if (kind === 'section' && target.dataset.id) activeFilter = { kind, id: target.dataset.id }
  if (kind === 'tag' && target.dataset.name) activeFilter = { kind, name: target.dataset.name }
  renderSidebar()
  renderList()
  if (leavingSpecialView) showEmptyState(false)
}

async function deleteSection(id: string): Promise<void> {
  const section = sections.find((item) => item.id === id)
  if (!section) return
  const confirmed = await askConfirm(
    `Удалить раздел «${section.name}»?`,
    'Все заметки этого раздела перейдут в «Без раздела». Содержимое, вложения и заметки в Корзине сохранятся.',
    'Удалить раздел'
  )
  if (!confirmed) return
  let deletionStarted = false
  try {
    await saveAllPending()
    if (saveTimers.size) throw new Error('Сначала дождитесь успешного сохранения заметок')
    deletionStarted = true
    await window.locus.deleteSection(id)
    ;[notes, trashNotes, sections] = await Promise.all([
      window.locus.listNotes(), window.locus.listTrash(), window.locus.listSections()
    ])
    if (activeFilter.kind === 'section' && activeFilter.id === id) activeFilter = { kind: 'unsectioned' }
    renderSidebar()
    renderList()
    const current = selectedNote()
    if (current) renderEditor(current)
    showToast('Раздел удалён. Заметки сохранены в «Без раздела»')
  } catch (error) {
    // A failed filesystem operation may have moved some notes safely already.
    if (deletionStarted) {
      ;[notes, trashNotes, sections] = await Promise.all([
        window.locus.listNotes(), window.locus.listTrash(), window.locus.listSections()
      ])
      renderSidebar()
      renderList()
      const current = selectedNote()
      if (current) renderEditor(current)
    }
    showToast(`Не удалось удалить раздел: ${messageOf(error)}`, true)
  }
}

async function createNote(): Promise<void> {
  await saveSelectedNow()
  const sectionId = activeFilter.kind === 'section' ? activeFilter.id : null
  try {
    const note = await window.locus.createNote(sectionId)
    notes.unshift(note)
    versions.set(note.id, 0)
    renderSidebar()
    await selectNote(note.id, 'edit')
    const editor = elements.editorHost.querySelector<HTMLTextAreaElement>('[data-editor]')
    editor?.focus()
  } catch (error) {
    showToast(`Не удалось создать заметку: ${messageOf(error)}`, true)
  }
}

async function selectNote(id: string, mode: ViewMode = 'preview'): Promise<void> {
  if (selectedId === id && !elements.editorHost.hidden) return
  await saveSelectedNow()
  const note = notes.find((item) => item.id === id)
  if (!note) return
  selectedId = id
  selectedTrashName = null
  viewMode = mode
  elements.emptyState.hidden = true
  elements.editorHost.hidden = false
  renderList()
  renderEditor(note)
}

function showEmptyState(closed = false, customTitle = '', customCopy = '', allowCreate = true): void {
  disposeAutocomplete?.()
  selectedId = null
  selectedTrashName = null
  const hasNotes = notes.length > 0
  elements.emptyTitle.textContent = customTitle || (closed ? 'Заметка закрыта' : hasNotes ? 'Выберите заметку' : 'Здесь появится ваша первая мысль')
  elements.emptyCopy.innerHTML = customCopy || (closed || hasNotes
    ? 'Выберите заметку в списке<br>или создайте новую.'
    : 'Создайте заметку и просто начните писать.<br>Сохранение происходит автоматически.')
  elements.emptyCreate.hidden = !allowCreate
  elements.emptyState.hidden = false
  elements.editorHost.hidden = true
  elements.editorHost.replaceChildren()
}

function renderSidebar(): void {
  const counts = new Map<string, number>()
  const tagCounts = new Map<string, number>()
  for (const note of notes) {
    if (note.sectionId) counts.set(note.sectionId, (counts.get(note.sectionId) ?? 0) + 1)
    for (const tag of note.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
  const navItem = (filter: string, label: string, icon: string, count: number, extra = '') => `
    <button class="nav-item ${isFilterActive(filter, extra) ? 'active' : ''}" data-filter="${filter}" ${extra}>
      <span class="nav-icon">${icon}</span><span>${escapeHtml(label)}</span><span class="nav-count">${count}</span>
    </button>`

  elements.sidebarNav.innerHTML = `
    <div class="nav-primary nav-group">
      ${navItem('all', 'Все заметки', '▤', notes.length)}
      ${navItem('recent', 'Последние', '◷', Math.min(notes.length, 20))}
      ${navItem('favorites', 'Избранное', '☆', notes.filter((note) => note.favorite).length)}
      ${navItem('trash', 'Корзина', '♲', trashNotes.length)}
      ${navItem('storage', 'Хранилище', '▣', 0)}
    </div>
    <div class="nav-scroll" data-testid="sidebar-scroll">
      <div class="nav-group">
        <div class="nav-title"><span>Разделы</span><button data-add-section title="Новый раздел" aria-label="Новый раздел">＋</button></div>
        ${navItem('unsectioned', 'Без раздела', '○', notes.filter((note) => !note.sectionId).length)}
        ${sections.map((section) => `
          <div class="section-row">
          <button class="nav-item ${isFilterActive('section', section.id) ? 'active' : ''}" data-filter="section" data-id="${section.id}">
            <span class="section-dot" style="background:${section.color}"></span><span>${escapeHtml(section.name)}</span><span class="nav-count">${counts.get(section.id) ?? 0}</span>
          </button>
          <button class="section-delete" data-delete-section="${section.id}" title="Удалить раздел «${escapeAttribute(section.name)}»" aria-label="Удалить раздел «${escapeAttribute(section.name)}»">×</button>
          </div>`).join('')}
      </div>
      ${tags.length ? `<div class="nav-group"><div class="nav-title"><span>Теги</span></div>
        ${tags.map(([tag, count]) => `
          <button class="nav-item ${isFilterActive('tag', tag) ? 'active' : ''}" data-filter="tag" data-name="${escapeAttribute(tag)}">
            <span class="tag-symbol">#</span><span>${escapeHtml(tag)}</span><span class="nav-count">${count}</span>
          </button>`).join('')}</div>` : ''}
    </div>`
}

function isFilterActive(kind: string, value = ''): boolean {
  if (activeFilter.kind !== kind) return false
  if (kind === 'section') return activeFilter.kind === 'section' && activeFilter.id === value
  if (kind === 'tag') return activeFilter.kind === 'tag' && activeFilter.name === value
  return true
}

function renderList(): void {
  elements.emptyTrashHeader.hidden = activeFilter.kind !== 'trash' || trashNotes.length === 0
  if (activeFilter.kind === 'storage') {
    elements.listTitle.textContent = 'Хранилище'
    elements.noteCount.textContent = ''
    elements.noteList.innerHTML = '<div class="list-empty"><span>▣</span>Статистика и безопасная очистка данных.</div>'
    return
  }
  if (activeFilter.kind === 'trash') {
    elements.listTitle.textContent = 'Корзина'
    elements.noteCount.textContent = String(trashNotes.length)
    elements.noteList.innerHTML = trashNotes.length
      ? trashNotes.map((note) => `
        <button class="note-card trash-card ${note.trashName === selectedTrashName ? 'active' : ''}" data-trash-name="${escapeAttribute(note.trashName)}" data-testid="trash-card">
          <div class="note-card-top"><h2>${escapeHtml(note.title)}</h2><time>${formatDateTime(note.deletedAt)}</time></div>
          <p>${escapeHtml(snippet(note.content))}</p>
          <div class="note-tags"><span>Удалена</span></div>
        </button>`).join('')
      : '<div class="list-empty"><span>♲</span>Корзина пуста.</div>'
    return
  }
  const filtered = visibleNotes()
  elements.listTitle.textContent = filterTitle()
  elements.noteCount.textContent = String(filtered.length)
  if (!filtered.length) {
    elements.noteList.innerHTML = `<div class="list-empty"><span>⌕</span>${elements.search.value ? 'Ничего не найдено.<br>Попробуйте другой запрос.' : 'В этом списке пока нет заметок.'}</div>`
    return
  }
  elements.noteList.innerHTML = filtered.map((note) => `
    <button class="note-card ${note.id === selectedId ? 'active' : ''}" data-note-id="${note.id}" data-testid="note-card">
      <div class="note-card-top"><h2>${escapeHtml(note.title)}</h2>${note.favorite ? '<span class="star">★</span>' : ''}<time>${formatRelative(note.updatedAt)}</time></div>
      <p>${escapeHtml(snippet(note.content))}</p>
      <div class="note-tags">${note.tags.slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('')}</div>
    </button>`).join('')
}

function visibleNotes(): Note[] {
  if (activeFilter.kind === 'trash' || activeFilter.kind === 'storage') return []
  let result = notes.filter((note) => {
    if (activeFilter.kind === 'favorites') return note.favorite
    if (activeFilter.kind === 'unsectioned') return note.sectionId === null
    if (activeFilter.kind === 'section') return note.sectionId === activeFilter.id
    if (activeFilter.kind === 'tag') return note.tags.includes(activeFilter.name)
    return true
  }).filter((note) => noteMatches(note, elements.search.value))

  result = [...result].sort((a, b) => {
    if (sortMode === 'title') return a.title.localeCompare(b.title, 'ru')
    if (sortMode === 'created') return b.createdAt.localeCompare(a.createdAt)
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  if (activeFilter.kind === 'recent') result = result.slice(0, 20)
  return result
}

function filterTitle(): string {
  if (activeFilter.kind === 'all') return 'Все заметки'
  if (activeFilter.kind === 'recent') return 'Последние'
  if (activeFilter.kind === 'favorites') return 'Избранное'
  if (activeFilter.kind === 'tag') return `#${activeFilter.name}`
  if (activeFilter.kind === 'trash') return 'Корзина'
  if (activeFilter.kind === 'storage') return 'Хранилище'
  if (activeFilter.kind === 'unsectioned') return 'Без раздела'
  const sectionId = activeFilter.id
  return sections.find((section) => section.id === sectionId)?.name ?? 'Раздел'
}

function renderEditor(note: Note): void {
  disposeAutocomplete?.()
  const backlinks = getBacklinks(note)
  const editing = viewMode !== 'preview'
  elements.editorHost.innerHTML = `
    <div class="editor-layout" data-note-editor="${note.id}">
      <header class="editor-header">
        <div class="editor-title-row">
          <input class="editor-title ${editing ? '' : 'viewing'}" data-title data-testid="note-title" value="${escapeAttribute(note.title)}" aria-label="Название заметки" ${editing ? '' : 'readonly'} />
          ${editing
            ? '<button class="edit-action done" data-finish-edit data-testid="finish-edit">✓ Готово</button>'
            : '<button class="edit-action" data-start-edit data-testid="start-edit">✎ Редактировать</button>'}
          <button class="icon-button ${note.favorite ? 'favorite' : ''}" data-favorite data-testid="favorite" title="${note.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}">${note.favorite ? '★' : '☆'}</button>
          <button class="icon-button danger" data-delete data-testid="delete-note" title="Удалить заметку">⌫</button>
          <button class="icon-button close-note" data-close-note data-testid="close-note" title="Закрыть заметку">×</button>
        </div>
        <div class="editor-meta">
          <select class="meta-field section" data-section aria-label="Раздел" ${editing ? '' : 'disabled'}>
            <option value="">Без раздела</option>
            ${sections.map((section) => `<option value="${section.id}" ${section.id === note.sectionId ? 'selected' : ''}>${escapeHtml(section.name)}</option>`).join('')}
          </select>
          <select class="meta-field language" data-language data-testid="note-language" aria-label="Язык заметки" title="Язык заметки">
            ${[['auto', 'Auto'], ['ru', 'RU'], ['en', 'EN'], ...(!['auto', 'ru', 'en'].includes(note.language) ? [[note.language, note.language.toUpperCase()]] : [])].map(([code, label]) => `<option value="${escapeAttribute(code!)}" ${note.language === code ? 'selected' : ''}>${escapeHtml(label!)}</option>`).join('')}
          </select>
          <input class="meta-field tags-field" data-tags data-testid="tags" value="${escapeAttribute(note.tags.join(', '))}" placeholder="Теги через запятую" aria-label="Теги" ${editing ? '' : 'readonly'} />
          <span class="updated-label">Изменено ${formatDateTime(note.updatedAt)}</span>
        </div>
      </header>
      ${editing ? `<div class="format-bar" data-toolbar>
        <button data-format="heading" title="Заголовок">H</button>
        <button data-format="bold" title="Жирный"><b>B</b></button>
        <button data-format="italic" title="Курсив"><i>I</i></button>
        <button data-format="quote" title="Цитата">❞</button>
        <span class="format-separator"></span>
        <button data-format="bullet" title="Маркированный список">• ≡</button>
        <button data-format="ordered" title="Нумерованный список">1.</button>
        <button data-format="link" title="Ссылка">↗</button>
        <button data-format="table" title="Таблица">▦</button>
        <span class="format-separator"></span>
        <button data-format="code" title="Inline-код">&lt;/&gt;</button>
        <button data-format="codeblock" title="Блок кода">{ }</button>
        <button data-format="math" title="Формула LaTeX">∑</button>
        <span class="format-separator"></span>
        <button class="attach-button" data-attach data-testid="attach-file" title="Скопировать файл в хранилище заметки">📎 Прикрепить файл</button>
        <div class="view-toggle" aria-label="Режим редактора">
          <button data-view="edit" class="${viewMode === 'edit' ? 'active' : ''}">Текст</button>
          <button data-view="split" class="${viewMode === 'split' ? 'active' : ''}">Оба</button>
          <button data-view="preview">Просмотр</button>
        </div>
      </div>` : ''}
      <div class="editor-panes mode-${viewMode}" data-drop-zone>
        <textarea class="markdown-editor" data-editor data-testid="note-content" spellcheck="true" placeholder="Начните писать…\n\nMarkdown поддерживается. Формула: $E = mc^2$. Ссылка на заметку: [[Название]].">${escapeHtml(note.content)}</textarea>
        <article class="markdown-preview" data-preview data-testid="preview"></article>
        ${editing ? '<div class="drop-hint">Перетащите файлы сюда, чтобы прикрепить</div>' : ''}
      </div>
      <footer class="editor-footer">
        <span class="save-status" data-save-status><span class="save-dot"></span><span>Сохранено</span></span>
        <span data-stats>${textStats(note.content)}</span>
        <details class="backlinks">
          <summary>Обратные ссылки · ${backlinks.length}</summary>
          <div class="backlink-menu">${backlinks.length ? backlinks.map((item) => `<button data-backlink="${item.id}">${escapeHtml(item.title)}</button>`).join('') : '<button disabled>Ссылок пока нет</button>'}</div>
        </details>
      </footer>
    </div>`

  const title = required<HTMLInputElement>('[data-title]')
  const editor = required<HTMLTextAreaElement>('[data-editor]')
  const favorite = required<HTMLButtonElement>('[data-favorite]')
  const section = required<HTMLSelectElement>('[data-section]')
  const tags = required<HTMLInputElement>('[data-tags]')
  required<HTMLSelectElement>('[data-language]').addEventListener('change', (event) => {
    mutateSelected((current) => { current.language = (event.target as HTMLSelectElement).value })
  })
  const toolbar = elements.editorHost.querySelector<HTMLElement>('[data-toolbar]')

  updatePreview()
  if (editing) {
    title.addEventListener('input', () => mutateSelected((current) => { current.title = title.value || 'Без названия' }))
    title.addEventListener('blur', () => {
      if (!title.value.trim()) title.value = 'Без названия'
      mutateSelected((current) => { current.title = title.value.trim() })
    })
    editor.addEventListener('input', () => {
      mutateSelected((current) => {
        current.content = editor.value
        if (current.title === 'Новая заметка') {
          const derived = deriveTitle(editor.value)
          if (derived) {
            current.title = derived
            title.value = derived
          }
        }
      }, false)
      const stats = elements.editorHost.querySelector<HTMLElement>('[data-stats]')
      if (stats) stats.textContent = textStats(editor.value)
      clearTimeout(previewTimer)
      previewTimer = setTimeout(updatePreview, 120)
    })
    disposeAutocomplete = attachLatexAutocomplete(editor)
    editor.addEventListener('keydown', (event) => {
      if (!event.defaultPrevented && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'Tab') {
        event.preventDefault()
        replaceSelection(editor, '  ', '', '')
      }
    })
    section.addEventListener('change', () => mutateSelected((current) => { current.sectionId = section.value || null }))
    tags.addEventListener('change', () => mutateSelected((current) => { current.tags = parseTags(tags.value); tags.value = current.tags.join(', ') }))
    toolbar?.addEventListener('click', (event) => handleToolbarClick(event, editor))
    setupAttachmentInput(editor)
  }
  favorite.addEventListener('click', () => {
    mutateSelected((current) => { current.favorite = !current.favorite })
    const current = selectedNote()
    if (current) {
      favorite.textContent = current.favorite ? '★' : '☆'
      favorite.classList.toggle('favorite', current.favorite)
      favorite.title = current.favorite ? 'Убрать из избранного' : 'Добавить в избранное'
    }
  })
  required<HTMLButtonElement>('[data-delete]').addEventListener('click', () => void deleteSelected())
  required<HTMLButtonElement>('[data-close-note]').addEventListener('click', () => void closeSelectedNote())
  elements.editorHost.querySelector<HTMLButtonElement>('[data-start-edit]')?.addEventListener('click', startEditing)
  elements.editorHost.querySelector<HTMLButtonElement>('[data-finish-edit]')?.addEventListener('click', () => void finishEditing())
  elements.editorHost.querySelectorAll<HTMLButtonElement>('[data-backlink]').forEach((button) => {
    button.addEventListener('click', () => button.dataset.backlink && void selectNote(button.dataset.backlink))
  })
  required<HTMLElement>('[data-preview]').addEventListener('click', handlePreviewClick)
}

async function selectTrashNote(trashName: string): Promise<void> {
  await saveSelectedNow()
  const note = trashNotes.find((item) => item.trashName === trashName)
  if (!note) return
  disposeAutocomplete?.()
  selectedId = null
  selectedTrashName = trashName
  elements.emptyState.hidden = true
  elements.editorHost.hidden = false
  renderList()
  elements.editorHost.innerHTML = `
    <div class="editor-layout trash-view" data-testid="trash-view">
      <header class="editor-header">
        <div class="editor-title-row">
          <h1 class="trash-title">${escapeHtml(note.title)}</h1>
          <button class="edit-action done" data-restore-trash data-testid="restore-trash">↶ Восстановить</button>
          <button class="edit-action danger-action" data-delete-trash data-testid="delete-trash-permanently">Удалить навсегда</button>
          <button class="icon-button close-note" data-close-trash title="Закрыть">×</button>
        </div>
        <div class="editor-meta"><span class="updated-label">Удалена ${formatDateTime(note.deletedAt)}</span></div>
      </header>
      <div class="editor-panes mode-preview">
        <article class="markdown-preview" data-preview data-testid="trash-preview">${note.content.trim() ? renderMarkdown(note.content) : '<p style="color:#b3b6c1">Пустая заметка.</p>'}</article>
      </div>
      <footer class="editor-footer"><span>Вложения сохраняются до окончательного удаления</span></footer>
    </div>`
  const preview = required<HTMLElement>('[data-preview]')
  enhanceAttachmentActions(preview)
  preview.addEventListener('click', handlePreviewClick)
  required<HTMLButtonElement>('[data-restore-trash]').addEventListener('click', () => void restoreSelectedTrash())
  required<HTMLButtonElement>('[data-delete-trash]').addEventListener('click', () => void permanentlyDeleteSelectedTrash())
  required<HTMLButtonElement>('[data-close-trash]').addEventListener('click', () => {
    showEmptyState(false, 'Корзина', 'Выберите удалённую заметку для просмотра.', false)
    renderList()
  })
}

async function restoreSelectedTrash(): Promise<void> {
  const item = trashNotes.find((note) => note.trashName === selectedTrashName)
  if (!item) return
  try {
    const restored = await window.locus.restoreTrash(item.trashName)
    trashNotes = trashNotes.filter((note) => note.trashName !== item.trashName)
    notes.unshift(restored)
    activeFilter = { kind: 'all' }
    renderSidebar()
    await selectNote(restored.id, 'preview')
    showToast('Заметка и её вложения восстановлены')
  } catch (error) {
    showToast(`Не удалось восстановить заметку: ${messageOf(error)}`, true)
  }
}

async function permanentlyDeleteSelectedTrash(): Promise<void> {
  const item = trashNotes.find((note) => note.trashName === selectedTrashName)
  if (!item) return
  const confirmed = await askConfirm(
    `Удалить «${item.title}» навсегда?`,
    'Заметка и принадлежащие только ей вложения будут удалены без возможности восстановления.',
    'Удалить навсегда'
  )
  if (!confirmed) return
  try {
    await window.locus.deleteTrashPermanently(item.trashName)
    trashNotes = trashNotes.filter((note) => note.trashName !== item.trashName)
    selectedTrashName = null
    renderSidebar()
    renderList()
    if (trashNotes[0]) await selectTrashNote(trashNotes[0].trashName)
    else showEmptyState(false, 'Корзина пуста', 'Удалённых заметок больше нет.', false)
    showToast('Заметка удалена навсегда')
  } catch (error) {
    showToast(`Не удалось удалить заметку: ${messageOf(error)}`, true)
  }
}

async function renderStorageView(): Promise<void> {
  disposeAutocomplete?.()
  elements.emptyState.hidden = true
  elements.editorHost.hidden = false
  elements.editorHost.innerHTML = '<div class="storage-loading">Считаю размер хранилища…</div>'
  try {
    const stats = await window.locus.getStorageStats()
    elements.editorHost.innerHTML = storageMarkup(stats)
    required<HTMLButtonElement>('[data-open-storage]').addEventListener('click', () => void window.locus.openDataFolder())
    required<HTMLButtonElement>('[data-empty-trash]').addEventListener('click', () => void emptyTrashFromStorage())
    required<HTMLButtonElement>('[data-clean-unused]').addEventListener('click', () => void cleanUnusedAttachments())
  } catch (error) {
    elements.editorHost.innerHTML = `<div class="storage-loading error-text">Не удалось прочитать статистику: ${escapeHtml(messageOf(error))}</div>`
  }
}

function storageMarkup(stats: StorageStats): string {
  const rows: Array<[string, number, string]> = [
    ['Заметки', stats.notesBytes, 'Активные Markdown-файлы'],
    ['Вложения', stats.attachmentsBytes, 'Изображения, PDF, документы и архивы'],
    ['Корзина', stats.trashBytes, 'Markdown удалённых заметок'],
    ['Резервные копии', stats.backupsBytes, 'Последние 30 дневных каталогов'],
    ['Прочее', stats.otherBytes, 'Конфигурация и служебные файлы']
  ]
  return `
    <section class="storage-panel" data-testid="storage-panel">
      <header><span class="storage-icon">▣</span><div><h1>Хранилище</h1><p>Фактическая папка данных Locus Notes</p></div></header>
      <div class="storage-total"><span>Всего данных</span><strong data-testid="storage-total">${formatFileSize(stats.totalBytes)}</strong></div>
      <div class="storage-grid">${rows.map(([label, value, copy]) => `
        <article><span>${escapeHtml(label)}</span><strong>${formatFileSize(value)}</strong><small>${escapeHtml(copy)}</small></article>`).join('')}</div>
      <div class="storage-actions">
        <button data-open-storage data-testid="open-storage-folder">⌂ Открыть папку данных Locus Notes</button>
        <button data-empty-trash data-testid="empty-trash">♲ Очистить корзину</button>
        <button data-clean-unused data-testid="clean-unused">◇ Очистить неиспользуемые вложения</button>
      </div>
      <p class="storage-warning">Очистка выполняется только после подтверждения. Неизвестные или неоднозначные файлы остаются нетронутыми.</p>
    </section>`
}

async function emptyTrashFromStorage(): Promise<void> {
  if (!trashNotes.length) {
    showToast('Корзина уже пуста')
    return
  }
  const confirmed = await askConfirm(
    'Очистить корзину?',
    `Будут окончательно удалены заметки: ${trashNotes.length}, а также принадлежащие только им вложения.`,
    'Очистить корзину'
  )
  if (!confirmed) return
  try {
    const returnToStorage = activeFilter.kind === 'storage'
    const result = await window.locus.emptyTrash()
    trashNotes = await window.locus.listTrash()
    renderSidebar()
    renderList()
    if (returnToStorage) await renderStorageView()
    else showEmptyState(false, 'Корзина пуста', 'Удалённых заметок больше нет.', false)
    showToast(`Удалено заметок: ${result.notes}, вложений: ${result.attachments}`)
  } catch (error) {
    showToast(`Не удалось очистить корзину: ${messageOf(error)}`, true)
  }
}

async function cleanUnusedAttachments(): Promise<void> {
  try {
    const summary = await window.locus.scanUnusedAttachments()
    if (!summary.count) {
      showToast('Неиспользуемых вложений не найдено')
      return
    }
    const confirmed = await askConfirm(
      'Удалить неиспользуемые вложения?',
      `Найдено файлов: ${summary.count}, общий размер: ${formatFileSize(summary.bytes)}. Активные заметки и корзина уже проверены.`,
      'Удалить файлы'
    )
    if (!confirmed) return
    const removed = await window.locus.cleanupUnusedAttachments()
    await renderStorageView()
    showToast(`Удалено неиспользуемых файлов: ${removed.count} (${formatFileSize(removed.bytes)})`)
  } catch (error) {
    showToast(`Безопасная очистка остановлена: ${messageOf(error)}`, true, 7000)
  }
}

function startEditing(): void {
  const note = selectedNote()
  if (!note) return
  viewMode = 'edit'
  renderEditor(note)
  requestAnimationFrame(() => elements.editorHost.querySelector<HTMLTextAreaElement>('[data-editor]')?.focus())
}

async function finishEditing(): Promise<void> {
  await saveSelectedNow()
  const note = selectedNote()
  if (!note) return
  viewMode = 'preview'
  renderEditor(note)
}

async function closeSelectedNote(): Promise<void> {
  await saveSelectedNow()
  showEmptyState(true)
  renderList()
}

function mutateSelected(change: (note: Note) => void, renderNow = true): void {
  const note = selectedNote()
  if (!note) return
  change(note)
  versions.set(note.id, (versions.get(note.id) ?? 0) + 1)
  markSaving('Изменения…', 'saving')
  scheduleSave(note.id)
  if (renderNow) {
    renderList()
    renderSidebar()
  }
}

function scheduleSave(id: string): void {
  const previous = saveTimers.get(id)
  if (previous) clearTimeout(previous)
  saveTimers.set(id, setTimeout(() => void saveNoteById(id), 550))
}

async function saveSelectedNow(): Promise<void> {
  if (selectedId) await saveNoteById(selectedId)
}

async function saveAllPending(): Promise<void> {
  await Promise.all([...inFlightSaves.values()])
  const ids = [...saveTimers.keys()]
  await Promise.all(ids.map((id) => saveNoteById(id)))
  await Promise.all([...inFlightSaves.values()])
}

async function saveNoteById(id: string): Promise<void> {
  const active = inFlightSaves.get(id)
  if (active) await active
  const timer = saveTimers.get(id)
  if (!timer) return
  clearTimeout(timer)
  saveTimers.delete(id)
  const note = notes.find((item) => item.id === id)
  if (!note) return
  const version = versions.get(id) ?? 0
  const snapshot = { ...note, tags: [...note.tags] }
  markSaving('Сохраняю…', 'saving', id)
  const operation = persistSnapshot(id, version, snapshot)
  inFlightSaves.set(id, operation)
  try {
    await operation
  } finally {
    if (inFlightSaves.get(id) === operation) inFlightSaves.delete(id)
  }
}

async function persistSnapshot(id: string, version: number, snapshot: Note): Promise<void> {
  try {
    const result = await window.locus.saveNote({
      id: snapshot.id,
      title: snapshot.title,
      content: snapshot.content,
      sectionId: snapshot.sectionId,
      tags: snapshot.tags,
      favorite: snapshot.favorite,
      language: snapshot.language
    })
    const current = notes.find((item) => item.id === id)
    if (current && (versions.get(id) ?? 0) === version) Object.assign(current, result.note)
    else if (current) {
      current.updatedAt = result.note.updatedAt
      scheduleSave(id)
    }
    markSaving('Сохранено', '', id)
  } catch (error) {
    saveTimers.set(id, setTimeout(() => void saveNoteById(id), 2500))
    markSaving('Ошибка сохранения', 'error', id)
    showToast(`Не удалось сохранить заметку: ${messageOf(error)}`, true, 6000)
  }
}

function markSaving(label: string, state: '' | 'saving' | 'error', id = selectedId): void {
  if (id !== selectedId) return
  const status = elements.editorHost.querySelector<HTMLElement>('[data-save-status]')
  if (!status) return
  status.className = `save-status ${state}`
  const text = status.querySelector('span:last-child')
  if (text) text.textContent = label
}

async function deleteSelected(): Promise<void> {
  const note = selectedNote()
  if (!note) return
  const confirmed = await askConfirm(
    `Удалить «${note.title}»?`,
    'Заметка появится в Корзине. Её вложения останутся на месте и будут доступны после восстановления.',
    'В корзину'
  )
  if (!confirmed) return
  const id = note.id
  try {
    await saveNoteById(id)
    await window.locus.deleteNote(id)
    notes = notes.filter((item) => item.id !== id)
    trashNotes = await window.locus.listTrash()
    selectedId = null
    renderSidebar()
    renderList()
    const next = visibleNotes()[0] ?? notes[0]
    if (next) await selectNote(next.id)
    else showEmptyState()
    showToast('Заметка перемещена в корзину')
  } catch (error) {
    showToast(`Не удалось удалить заметку: ${messageOf(error)}`, true)
  }
}

function handleToolbarClick(event: Event, editor: HTMLTextAreaElement): void {
  const view = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')
  if (view?.dataset.view) {
    if (view.dataset.view === 'preview') {
      void finishEditing()
      return
    }
    viewMode = view.dataset.view as ViewMode
    elements.editorHost.querySelector('.editor-panes')?.classList.remove('mode-edit', 'mode-split', 'mode-preview')
    elements.editorHost.querySelector('.editor-panes')?.classList.add(`mode-${viewMode}`)
    elements.editorHost.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', (button as HTMLElement).dataset.view === viewMode))
    if (viewMode !== 'edit') updatePreview()
    return
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-format]')
  const format = button?.dataset.format
  if (!format) return
  const formats: Record<string, [string, string, string]> = {
    heading: ['## ', '', 'Заголовок'],
    bold: ['**', '**', 'важный текст'],
    italic: ['*', '*', 'курсив'],
    quote: ['> ', '', 'Цитата'],
    bullet: ['- ', '', 'элемент списка'],
    ordered: ['1. ', '', 'элемент списка'],
    link: ['[', '](https://)', 'текст ссылки'],
    table: ['| Столбец 1 | Столбец 2 |\n| --- | --- |\n| Значение | Значение |', '', ''],
    code: ['`', '`', 'код'],
    codeblock: ['```\n', '\n```', 'код'],
    math: ['$$\n', '\n$$', 'E = mc^2']
  }
  const chosen = formats[format]
  if (chosen) replaceSelection(editor, chosen[0], chosen[1], chosen[2])
}

function setupAttachmentInput(editor: HTMLTextAreaElement): void {
  const attachButton = elements.editorHost.querySelector<HTMLButtonElement>('[data-attach]')
  const dropZone = required<HTMLElement>('[data-drop-zone]')

  attachButton?.addEventListener('click', async () => {
    const note = selectedNote()
    if (!note) return
    attachButton.disabled = true
    try {
      const attachments = await window.locus.chooseAttachments(note.id)
      insertAttachments(editor, attachments)
    } catch (error) {
      showToast(`Не удалось прикрепить файл: ${messageOf(error)}`, true)
    } finally {
      attachButton.disabled = false
    }
  })

  for (const eventName of ['dragenter', 'dragover']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault()
      dropZone.classList.add('drag-active')
    })
  }
  for (const eventName of ['dragleave', 'dragend']) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault()
      if (eventName === 'dragleave' && dropZone.contains((event as DragEvent).relatedTarget as Node | null)) return
      dropZone.classList.remove('drag-active')
    })
  }
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault()
    dropZone.classList.remove('drag-active')
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length) void importDroppedFiles(editor, files)
  })

  editor.addEventListener('paste', (event) => {
    const images = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (!images.length) return
    event.preventDefault()
    void importDroppedFiles(editor, images)
  })
}

async function importDroppedFiles(editor: HTMLTextAreaElement, files: File[]): Promise<void> {
  const note = selectedNote()
  if (!note) return
  const imported: AttachmentInfo[] = []
  try {
    for (const file of files) {
      const sourcePath = window.locus.getPathForFile(file)
      if (sourcePath) {
        imported.push(...await window.locus.importAttachmentPaths(note.id, [sourcePath]))
      } else {
        imported.push(await window.locus.saveAttachmentBytes(
          note.id,
          await file.arrayBuffer(),
          file.name || `изображение-${Date.now()}.png`,
          file.type
        ))
      }
    }
    insertAttachments(editor, imported)
  } catch (error) {
    showToast(`Не удалось прикрепить файл: ${messageOf(error)}`, true, 6000)
  }
}

function insertAttachments(editor: HTMLTextAreaElement, attachments: AttachmentInfo[]): void {
  if (!attachments.length) return
  const markdown = attachments.map(attachmentMarkdown).join('\n\n')
  const start = editor.selectionStart
  const end = editor.selectionEnd
  const before = start > 0 && !editor.value.slice(0, start).endsWith('\n') ? '\n\n' : ''
  const after = end < editor.value.length && !editor.value.slice(end).startsWith('\n') ? '\n\n' : '\n'
  editor.setRangeText(`${before}${markdown}${after}`, start, end, 'end')
  editor.focus()
  editor.dispatchEvent(new Event('input', { bubbles: true }))
  showToast(attachments.length === 1 ? `Файл «${attachments[0]?.originalName}» прикреплён` : `Прикреплено файлов: ${attachments.length}`)
}

function attachmentMarkdown(attachment: AttachmentInfo): string {
  const name = escapeMarkdownLabel(attachment.originalName)
  if (attachment.isImage) return `![${name}](${attachment.relativePath})`
  const extension = fileExtension(attachment.originalName)
  return `[📎 ${name} · ${extension} · ${formatFileSize(attachment.size)}](${attachment.relativePath} "attachment")`
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1')
}

function fileExtension(value: string): string {
  const part = value.split('.').pop()
  return part && part !== value ? part.toLocaleUpperCase('ru-RU') : 'ФАЙЛ'
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

function replaceSelection(editor: HTMLTextAreaElement, before: string, after: string, placeholder: string): void {
  const start = editor.selectionStart
  const end = editor.selectionEnd
  const selected = editor.value.slice(start, end) || placeholder
  editor.setRangeText(`${before}${selected}${after}`, start, end, 'end')
  editor.focus()
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function updatePreview(): void {
  const note = selectedNote()
  const preview = elements.editorHost.querySelector<HTMLElement>('[data-preview]')
  if (!note || !preview) return
  preview.innerHTML = note.content.trim()
    ? renderMarkdown(note.content)
    : '<p style="color:#b3b6c1">Предпросмотр появится здесь.</p>'
  enhanceAttachmentActions(preview)
}

function handlePreviewClick(event: Event): void {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-attachment-action]')
  if (action?.dataset.attachmentPath) {
    event.preventDefault()
    const operation = action.dataset.attachmentAction === 'reveal'
      ? window.locus.revealAttachment(action.dataset.attachmentPath)
      : window.locus.openAttachment(action.dataset.attachmentPath)
    void operation
      .then(() => showToast(action.dataset.attachmentAction === 'reveal' ? 'Файл показан в Проводнике' : 'Файл открыт в стандартном приложении Windows'))
      .catch((error) => showToast(`Не удалось выполнить действие: ${messageOf(error)}`, true))
    return
  }
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
  if (!link) return
  const href = link.getAttribute('href') ?? ''
  if (href.startsWith('#attachment/')) {
    event.preventDefault()
    const path = decodeURIComponent(href.slice('#attachment/'.length))
    void window.locus.openAttachment(path)
      .then(() => showToast('Файл открыт в стандартном приложении Windows'))
      .catch((error) => showToast(`Не удалось открыть файл: ${messageOf(error)}`, true))
    return
  }
  if (/^https?:\/\//i.test(href)) {
    event.preventDefault()
    window.open(href, '_blank', 'noopener')
    return
  }
  if (!href.startsWith('#note/')) return
  event.preventDefault()
  const title = decodeURIComponent(href.slice(6))
  const target = notes.find((note) => note.title.toLocaleLowerCase('ru-RU') === title.toLocaleLowerCase('ru-RU'))
  if (target) void selectNote(target.id)
  else showToast(`Заметка «${title}» пока не создана`)
}

function enhanceAttachmentActions(preview: HTMLElement): void {
  preview.querySelectorAll<HTMLElement>('[data-attachment-path]').forEach((element) => {
    if (element.closest('.attachment-with-actions')) return
    const path = element.dataset.attachmentPath
    if (!path) return
    const wrapper = document.createElement(element.tagName === 'IMG' ? 'figure' : 'div')
    wrapper.className = `attachment-with-actions ${element.tagName === 'IMG' ? 'image-actions' : 'file-actions'}`
    element.replaceWith(wrapper)
    wrapper.append(element)
    const actions = document.createElement('div')
    actions.className = 'attachment-actions'
    actions.innerHTML = `
      <button data-attachment-action="open" data-attachment-path="${escapeAttribute(path)}">Открыть</button>
      <button data-attachment-action="reveal" data-attachment-path="${escapeAttribute(path)}" data-testid="reveal-attachment">Показать в проводнике</button>`
    wrapper.append(actions)
  })
}

function getBacklinks(target: Note): Note[] {
  const wanted = target.title.toLocaleLowerCase('ru-RU')
  return notes.filter((note) => note.id !== target.id && extractWikiLinks(note.content).some((title) => title.toLocaleLowerCase('ru-RU') === wanted))
}

function handleGlobalKeys(event: KeyboardEvent): void {
  if (event.isComposing || event.altKey || event.defaultPrevented) return
  if (!event.ctrlKey && !event.metaKey) {
    if (event.key === 'Escape' && !elements.actionDialog.hidden) closeActionDialog(null)
    else if (event.key === 'Escape' && !elements.quickSwitch.hidden) closeQuickSwitch()
    return
  }
  // Physical keys keep Ctrl+N/F/K/S working with a Russian layout as well.
  const key = /^Key[NFKS]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLocaleLowerCase()
  if (key === 'n') {
    event.preventDefault()
    void createNote()
  } else if (key === 'f') {
    event.preventDefault()
    elements.search.focus()
    elements.search.select()
  } else if (key === 'k') {
    event.preventDefault()
    openQuickSwitch()
  } else if (key === 's') {
    event.preventDefault()
    void saveSelectedNow()
  }
}

function openQuickSwitch(): void {
  elements.quickSwitch.hidden = false
  elements.quickInput.value = ''
  quickIndex = 0
  renderQuickResults()
  requestAnimationFrame(() => elements.quickInput.focus())
}

function closeQuickSwitch(): void {
  elements.quickSwitch.hidden = true
}

function renderQuickResults(): void {
  const query = elements.quickInput.value
  quickMatches = notes
    .filter((note) => noteMatches(note, query))
    .sort((a, b) => quickScore(a, query) - quickScore(b, query) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 12)
  if (quickIndex >= quickMatches.length) quickIndex = Math.max(0, quickMatches.length - 1)
  elements.quickResults.innerHTML = quickMatches.length
    ? quickMatches.map((note, index) => `<button class="quick-result ${index === quickIndex ? 'active' : ''}" data-quick-id="${note.id}"><span>${escapeHtml(note.title)}</span><small>${escapeHtml(sectionName(note.sectionId))}</small></button>`).join('')
    : '<div class="list-empty" style="padding:28px">Ничего не найдено</div>'
}

function quickScore(note: Note, query: string): number {
  const needle = normalizeSearch(query)
  if (!needle) return 5
  const title = normalizeSearch(note.title)
  if (title === needle) return 0
  if (title.startsWith(needle)) return 1
  if (title.includes(needle)) return 2
  if (note.tags.some((tag) => normalizeSearch(tag).includes(needle))) return 3
  return 4
}

function handleQuickKeys(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeQuickSwitch()
  else if (event.key === 'ArrowDown') {
    event.preventDefault()
    quickIndex = Math.min(quickIndex + 1, quickMatches.length - 1)
    renderQuickResults()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    quickIndex = Math.max(quickIndex - 1, 0)
    renderQuickResults()
  } else if (event.key === 'Enter' && quickMatches[quickIndex]) {
    event.preventDefault()
    const target = quickMatches[quickIndex]
    closeQuickSwitch()
    if (target) void selectNote(target.id)
  }
}

async function exportNotes(): Promise<void> {
  try {
    const result = await window.locus.exportAll()
    if (!result.canceled) showToast(`Экспорт сохранён: ${result.path}`, false, 6000)
  } catch (error) {
    showToast(`Ошибка экспорта: ${messageOf(error)}`, true)
  }
}

function askText(title: string, message: string, placeholder: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    dialogResolver = resolve as (value: string | boolean | null) => void
    elements.actionTitle.textContent = title
    elements.actionMessage.textContent = message
    elements.actionInput.hidden = false
    elements.actionInput.value = ''
    elements.actionInput.placeholder = placeholder
    elements.actionConfirm.textContent = confirmLabel
    elements.actionConfirm.classList.remove('danger')
    elements.actionDialog.hidden = false
    requestAnimationFrame(() => elements.actionInput.focus())
  })
}

function askConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    dialogResolver = resolve as (value: string | boolean | null) => void
    elements.actionTitle.textContent = title
    elements.actionMessage.textContent = message
    elements.actionInput.hidden = true
    elements.actionConfirm.textContent = confirmLabel
    elements.actionConfirm.classList.add('danger')
    elements.actionDialog.hidden = false
    requestAnimationFrame(() => elements.actionConfirm.focus())
  })
}

function confirmActionDialog(): void {
  const value = elements.actionInput.hidden ? true : elements.actionInput.value.trim()
  if (!elements.actionInput.hidden && !value) {
    elements.actionInput.focus()
    return
  }
  closeActionDialog(value)
}

function closeActionDialog(value: string | boolean | null): void {
  elements.actionDialog.hidden = true
  const resolver = dialogResolver
  dialogResolver = null
  resolver?.(value)
}

function selectedNote(): Note | undefined {
  return notes.find((note) => note.id === selectedId)
}

function sectionName(id: string | null): string {
  return sections.find((section) => section.id === id)?.name ?? 'Без раздела'
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim().replace(/^#/, '').replace(/\s+/g, '-')).filter(Boolean))].slice(0, 30)
}

function deriveTitle(content: string): string {
  const line = content.split(/\r?\n/).find((item) => item.trim()) ?? ''
  return line.replace(/^#{1,6}\s*/, '').replace(/[*_`[\]]/g, '').trim().slice(0, 80)
}

function snippet(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' фрагмент кода ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' формула ')
    .replace(/[#*_`>\[\]()|$\\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || 'Пустая заметка'
}

function textStats(content: string): string {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0
  return `${words} ${plural(words, 'слово', 'слова', 'слов')} · ${content.length} ${plural(content.length, 'символ', 'символа', 'символов')}`
}

function plural(value: number, one: string, few: string, many: string): string {
  const n = Math.abs(value) % 100
  const n1 = n % 10
  if (n > 10 && n < 20) return many
  if (n1 === 1) return one
  if (n1 >= 2 && n1 <= 4) return few
  return many
}

function formatRelative(value: string): string {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'вчера'
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

function showToast(text: string, error = false, duration = 3200): void {
  const toast = document.createElement('div')
  toast.className = `toast ${error ? 'error' : ''}`
  toast.textContent = text
  elements.toasts.append(toast)
  setTimeout(() => toast.remove(), duration)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character)
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Не найден элемент #${id}`)
  return element as T
}

function required<T extends Element>(selector: string): T {
  const element = elements.editorHost.querySelector(selector)
  if (!element) throw new Error(`Не найден элемент ${selector}`)
  return element as T
}

import { latexCompletion, type LatexCompletion } from '../shared/latex'

export function attachLatexAutocomplete(editor: HTMLTextAreaElement): () => void {
  const host = editor.parentElement!
  const popup = document.createElement('div')
  popup.className = 'latex-autocomplete'
  popup.id = `latex-${editor.closest<HTMLElement>('[data-note-editor]')?.dataset.noteEditor}`
  popup.setAttribute('role', 'listbox')
  popup.setAttribute('aria-label', 'Команды LaTeX')
  popup.dataset.testid = 'latex-autocomplete'
  popup.hidden = true
  host.append(popup)
  editor.setAttribute('aria-autocomplete', 'list')
  editor.setAttribute('aria-controls', popup.id)
  let completion: LatexCompletion | null = null
  let selected = 0
  let dismissed = ''
  let composing = false

  const keyOf = (value: LatexCompletion | null): string => value ? `${value.start}:${value.prefix}` : ''
  function close(suppress = false): void {
    if (suppress) dismissed = keyOf(completion)
    popup.hidden = true
    editor.setAttribute('aria-expanded', 'false')
    editor.removeAttribute('aria-activedescendant')
    completion = null
  }

  function position(): void {
    const caret = textareaCaret(editor)
    const bounds = host.getBoundingClientRect()
    const rect = editor.getBoundingClientRect()
    if (caret.top < rect.top || caret.top > rect.bottom || caret.left < rect.left || caret.left > rect.right) {
      close()
      return
    }
    const width = popup.offsetWidth
    const height = popup.offsetHeight
    const left = Math.max(4, Math.min(caret.left - bounds.left, bounds.width - width - 4))
    const below = caret.top - bounds.top + caret.height + 3
    const top = below + height <= bounds.height - 4 ? below : Math.max(4, caret.top - bounds.top - height - 3)
    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
  }

  function render(): void {
    if (!completion) return
    popup.replaceChildren(...completion.commands.map((command, index) => {
      const option = document.createElement('div')
      option.id = `${popup.id}-${index}`
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', String(index === selected))
      option.className = index === selected ? 'active' : ''
      option.textContent = `\\${command}`
      option.addEventListener('mousedown', (event) => {
        event.preventDefault()
        selected = index
        accept()
      })
      return option
    }))
    popup.hidden = false
    editor.setAttribute('aria-expanded', 'true')
    editor.setAttribute('aria-activedescendant', `${popup.id}-${selected}`)
    position()
  }

  function update(): void {
    if (!editor.isConnected || document.activeElement !== editor || composing) {
      close()
      return
    }
    const next = latexCompletion(editor.value, editor.selectionStart, editor.selectionEnd)
    if (!next || keyOf(next) === dismissed) {
      close()
      return
    }
    if (keyOf(next) !== keyOf(completion)) selected = 0
    completion = next
    render()
  }

  function accept(): void {
    if (!completion) return
    const command = completion.commands[selected]
    if (!command) return
    editor.setRangeText(`\\${command}`, completion.start, completion.end, 'end')
    dismissed = keyOf(latexCompletion(editor.value, editor.selectionStart))
    close()
    // Use the existing input/autosave/preview pipeline.
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }

  editor.addEventListener('input', update)
  editor.addEventListener('click', update)
  editor.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) update()
  })
  editor.addEventListener('select', update)
  // Typing at the end of a long note may scroll the caret into view after the
  // input event. Re-evaluate even when the initial position was off-screen.
  editor.addEventListener('scroll', update)
  editor.addEventListener('blur', () => close())
  editor.addEventListener('compositionstart', () => { composing = true; close() })
  editor.addEventListener('compositionend', () => { composing = false; update() })
  editor.addEventListener('keydown', (event) => {
    if (popup.hidden || !completion || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + completion.commands.length) % completion.commands.length
      render()
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      accept()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  })

  // Observe the editor rather than adding permanent window listeners for each
  // note. Detached editors and their popups can be collected normally.
  const resize = new ResizeObserver(() => {
    if (!editor.isConnected) resize.disconnect()
    else if (!popup.hidden) position()
  })
  resize.observe(editor)
  return () => resize.disconnect()
}

function textareaCaret(editor: HTMLTextAreaElement): { left: number; top: number; height: number } {
  const style = getComputedStyle(editor)
  const rect = editor.getBoundingClientRect()
  const mirror = document.createElement('div')
  for (const property of ['font', 'letter-spacing', 'tab-size', 'padding', 'border', 'box-sizing', 'word-break', 'overflow-wrap']) {
    mirror.style.setProperty(property, style.getPropertyValue(property))
  }
  Object.assign(mirror.style, {
    position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`,
    height: `${rect.height}px`, overflow: 'hidden', whiteSpace: 'pre-wrap'
  })
  // Account for the native textarea scrollbar in wrapped lines.
  mirror.style.width = `${editor.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`
  mirror.textContent = editor.value.slice(0, editor.selectionStart)
  const marker = document.createElement('span')
  marker.textContent = '\u200b'
  mirror.append(marker)
  document.body.append(mirror)
  mirror.scrollTop = editor.scrollTop
  mirror.scrollLeft = editor.scrollLeft
  const caret = marker.getBoundingClientRect()
  mirror.remove()
  return { left: caret.left, top: caret.top, height: parseFloat(style.lineHeight) || caret.height }
}

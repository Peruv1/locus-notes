import MarkdownIt from 'markdown-it'
import texmath from 'markdown-it-texmath'
import katex from 'katex'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import DOMPurify from 'dompurify'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(code: string, language: string): string {
    if (language && hljs.getLanguage(language)) {
      return `<pre><code class="hljs language-${escapeAttribute(language)}">${hljs.highlight(code, { language, ignoreIllegals: true }).value}</code></pre>`
    }
    return `<pre><code class="hljs">${escapeCode(code)}</code></pre>`
  }
})

md.use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false } })

md.inline.ruler.before('link', 'wiki_link', (state: StateInline, silent: boolean) => {
  const start = state.pos
  if (state.src.slice(start, start + 2) !== '[[') return false
  const end = state.src.indexOf(']]', start + 2)
  if (end < 0) return false
  const title = state.src.slice(start + 2, end).trim()
  if (!title || title.includes('\n')) return false
  if (!silent) {
    const open = state.push('link_open', 'a', 1)
    open.attrSet('href', `#note/${encodeURIComponent(title)}`)
    open.attrSet('class', 'wiki-link')
    const text = state.push('text', '', 0)
    text.content = title
    state.push('link_close', 'a', -1)
  }
  state.pos = end + 2
  return true
})

md.renderer.rules.image = (tokens, index, options, env, self) => {
  const source = tokens[index]?.attrGet('src') ?? ''
  if (isAttachmentPath(source)) {
    tokens[index]?.attrSet('src', `locus-attachment://asset?path=${encodeURIComponent(source)}`)
    tokens[index]?.attrSet('class', 'note-image')
    tokens[index]?.attrSet('data-attachment-path', source)
    tokens[index]?.attrSet('loading', 'lazy')
  }
  const token = tokens[index]
  if (token?.children) token.attrSet('alt', self.renderInlineAsText(token.children, options, env))
  return self.renderToken(tokens, index, options)
}

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const href = tokens[index]?.attrGet('href') ?? ''
  if (isAttachmentPath(href)) {
    tokens[index]?.attrSet('href', `#attachment/${encodeURIComponent(href)}`)
    tokens[index]?.attrSet('class', 'attachment-link')
    tokens[index]?.attrSet('data-attachment-path', href)
  }
  return self.renderToken(tokens, index, options)
}

export function renderMarkdown(source: string): string {
  const rendered = md.render(source)
  return DOMPurify.sanitize(rendered, {
    ADD_ATTR: ['target'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|locus-attachment):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })
}

function isAttachmentPath(value: string): boolean {
  return value.startsWith('../attachments/')
}

function escapeCode(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character)
}

function escapeAttribute(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character] ?? character)
}

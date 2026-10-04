import type { Note } from './types'

export function normalizeSearch(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[#*_`>[\](){}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function noteMatches(note: Note, query: string): boolean {
  const needle = normalizeSearch(query)
  if (!needle) return true

  const haystack = normalizeSearch(
    `${note.title}\n${note.content}\n${note.tags.join(' ')}`
  )
  return needle.split(' ').every((term) => haystack.includes(term))
}

export function extractWikiLinks(content: string): string[] {
  const found = new Set<string>()
  for (const match of content.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const title = match[1]?.trim()
    if (title) found.add(title)
  }
  return [...found]
}

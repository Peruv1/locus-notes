import { describe, expect, it } from 'vitest'
import { extractWikiLinks, noteMatches } from '../src/shared/search'
import type { Note } from '../src/shared/types'

const note: Note = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Биофизика мембраны',
  content: 'Потенциал Нернста и расчёт для нейрона. [[Forward model]]',
  createdAt: '2026-09-19T10:00:00.000Z',
  updatedAt: '2026-09-19T10:00:00.000Z',
  sectionId: null,
  tags: ['нейроны', 'учёба'],
  favorite: false,
  language: 'auto'
}

describe('поиск', () => {
  it('ищет по названию, содержимому и тегам без учёта регистра', () => {
    expect(noteMatches(note, 'БИОФИЗИКА')).toBe(true)
    expect(noteMatches(note, 'нернста')).toBe(true)
    expect(noteMatches(note, '#НЕЙРОНЫ')).toBe(true)
    expect(noteMatches(note, 'мембраны расчёт')).toBe(true)
    expect(noteMatches(note, 'квантовая механика')).toBe(false)
  })

  it('считает е и ё эквивалентными', () => {
    expect(noteMatches(note, 'нейрони')).toBe(false)
    expect(noteMatches(note, 'учеба')).toBe(true)
  })
})

describe('wiki-ссылки', () => {
  it('извлекает уникальные названия', () => {
    expect(extractWikiLinks('[[Первая]] и [[Вторая]] и снова [[Первая]]')).toEqual(['Первая', 'Вторая'])
  })
})

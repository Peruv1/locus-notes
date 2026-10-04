import { describe, expect, it } from 'vitest'
import { LATEX_COMMANDS, latexCompletion } from '../src/shared/latex'

describe('LaTeX autocomplete', () => {
  it('filters prefixes and includes all required commands', () => {
    expect(LATEX_COMMANDS).toHaveLength(33)
    expect(latexCompletion('Текст $\\fr', 10)).toMatchObject({ start: 7, prefix: 'fr', commands: ['frac'] })
    expect(latexCompletion('\\s', 2)?.commands).toEqual(['sqrt', 'sum', 'sin', 'sigma'])
    expect(latexCompletion('\\', 1)?.commands.length).toBe(8)
  })
  it('closes for no matches, selections, escaped slashes and ordinary text', () => {
    for (const text of ['обычный текст', '\\unknown', '\\\\fr', '\\frac ', '\\fr1']) {
      expect(latexCompletion(text, text.length)).toBeNull()
    }
    expect(latexCompletion('\\frac', 3)).toBeNull()
    expect(latexCompletion('\\fr', 1, 3)).toBeNull()
  })
  it('updates after Backspace and finds the range next to existing text', () => {
    expect(latexCompletion('a + \\fr', 7)).toMatchObject({ start: 4, end: 7, commands: ['frac'] })
    expect(latexCompletion('\\f', 2)?.commands).toEqual(['frac'])
    expect(latexCompletion('\\sq', 3)?.commands).toEqual(['sqrt'])
  })
})

// Add command names here to extend autocomplete; insertion remains plain LaTeX.
export const LATEX_COMMANDS = [
  'frac', 'sqrt', 'sum', 'int', 'lim', 'sin', 'cos', 'tan', 'log', 'ln',
  'alpha', 'beta', 'gamma', 'delta', 'theta', 'lambda', 'mu', 'pi', 'sigma', 'omega',
  'infty', 'cdot', 'times', 'pm', 'le', 'ge', 'neq', 'approx', 'rightarrow',
  'left', 'right', 'begin', 'end'
] as const

export interface LatexCompletion {
  start: number
  end: number
  prefix: string
  commands: string[]
}

export function latexCompletion(text: string, start: number, end = start): LatexCompletion | null {
  if (start !== end || /[a-zA-Z]/.test(text[start] ?? '')) return null
  const match = text.slice(0, start).match(/\\([a-zA-Z]*)$/)
  if (!match || match.index === undefined) return null
  let slashes = 0
  for (let index = match.index - 1; index >= 0 && text[index] === '\\'; index--) slashes++
  if (slashes % 2 !== 0) return null
  const prefix = match[1] ?? ''
  const commands = LATEX_COMMANDS.filter((command) => command.startsWith(prefix)).slice(0, 8)
  return commands.length ? { start: match.index, end: start, prefix, commands } : null
}

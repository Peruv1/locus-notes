import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { inspect } from 'node:util'
import { dirname, join } from 'node:path'

let logFile: string | null = null

export function configureSafeLogging(packaged: boolean): void {
  const ignoreBrokenPipe = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') safeLog('ERROR', error)
  }
  process.stdout?.on('error', ignoreBrokenPipe)
  process.stderr?.on('error', ignoreBrokenPipe)

  if (!packaged) return

  const base = process.env.LOCALAPPDATA || process.env.TEMP
  if (!base) return
  logFile = join(base, 'Locus Notes', 'logs', 'main.log')
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    if (statSync(logFile, { throwIfNoEntry: false })?.size && statSync(logFile).size > 2_000_000) {
      renameSync(logFile, `${logFile}.previous`)
    }
  } catch {
    logFile = null
  }

  console.log = (...values: unknown[]) => safeLog('INFO', ...values)
  console.warn = (...values: unknown[]) => safeLog('WARN', ...values)
  console.error = (...values: unknown[]) => safeLog('ERROR', ...values)
}

export function safeLog(level: 'INFO' | 'WARN' | 'ERROR', ...values: unknown[]): void {
  if (!logFile) return
  const message = values.map(formatValue).join(' ')
  try {
    appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never be able to crash the notes application.
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  return inspect(value, { depth: 4, breakLength: 160 })
}

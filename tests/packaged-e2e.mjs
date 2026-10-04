import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const executable = resolve('release', 'win-unpacked', 'Locus Notes.exe')
const child = spawn(process.execPath, ['tests/e2e.mjs'], {
  cwd: resolve('.'),
  env: { ...process.env, LOCUS_E2E_EXECUTABLE: executable },
  stdio: 'inherit',
  windowsHide: true
})

const exitCode = await new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code ?? 1)))
if (exitCode !== 0) process.exit(exitCode)

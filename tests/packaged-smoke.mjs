import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'locus-packaged-smoke-'))
const executable = resolve('release', 'win-unpacked', 'Locus Notes.exe')
let child

try {
  await Promise.all([
    mkdir(join(root, 'notes')),
    mkdir(join(root, 'backups')),
    mkdir(join(root, 'trash'))
  ])
  await writeFile(join(root, 'config.json'), '{ повреждённый JSON', 'utf8')

  child = spawn(executable, [`--user-data-dir=${join(root, '.electron-profile')}`], {
    env: { ...process.env, LOCUS_DATA_DIR: root, LOCUS_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  // Emulate a launcher that closes its output pipes immediately after starting the app.
  child.stdout?.destroy()
  child.stderr?.destroy()
  await new Promise((resolveWait) => setTimeout(resolveWait, 5000))

  if (child.exitCode !== null) throw new Error(`Production app exited unexpectedly: ${child.exitCode}`)
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  if (!Array.isArray(config.sections) || config.sections.length !== 5) {
    throw new Error('Corrupted configuration was not recovered')
  }
  const files = await readdir(root)
  if (!files.some((file) => file.startsWith('config.corrupt-'))) {
    throw new Error('Original corrupted configuration was not preserved')
  }
  if (!files.includes('attachments')) {
    throw new Error('Managed attachments directory was not created')
  }

  console.log('Packaged smoke: app stayed open, recovered config, handled closed pipes and created attachments storage.')
} finally {
  child?.kill()
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  await rm(root, { recursive: true, force: true })
}

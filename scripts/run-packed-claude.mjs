import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tgz = join(root, 'claude-code-2.1.88.tgz')
const unpackDir = join(root, '.claude-code-packed')
const cli = join(unpackDir, 'package', 'cli.js')

if (!existsSync(tgz)) {
  console.error(`Missing ${tgz}`)
  process.exit(1)
}

if (!existsSync(cli)) {
  mkdirSync(unpackDir, { recursive: true })
  const extract = spawnSync('tar', ['-xzf', tgz, '-C', unpackDir], {
    stdio: 'inherit',
  })
  if (extract.status !== 0) process.exit(extract.status ?? 1)
}

const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})

process.exit(child.status ?? 1)

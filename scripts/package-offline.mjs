#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const entries = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'README.md',
  'dist',
  'src',
  'scripts',
  'bin',
  'types',
  'vendor',
  'assets',
  '风机故障码',
  'node_modules',
]

const args = parseArgs(process.argv.slice(2))
const manifest = await buildManifest()

if (args.check || !args.outDir) {
  printManifest(manifest)
  process.exit(0)
}

await writeOfflinePackage(args.outDir, manifest)
if (args.tar) {
  await writeTarball(args.outDir)
}

function parseArgs(argv) {
  const parsed = {
    check: false,
    outDir: '',
    tar: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--check') {
      parsed.check = true
      continue
    }
    if (arg === '--tar') {
      parsed.tar = true
      continue
    }
    if (arg === '--out') {
      parsed.outDir = resolve(argv[++index] || '')
      continue
    }
    if (arg.startsWith('--out=')) {
      parsed.outDir = resolve(arg.slice('--out='.length))
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  return parsed
}

async function buildManifest() {
  const items = []
  for (const entry of entries) {
    const path = join(root, entry)
    if (!existsSync(path)) {
      items.push({ entry, exists: false, type: 'missing', bytes: 0 })
      continue
    }
    const info = await stat(path)
    items.push({
      entry,
      exists: true,
      type: info.isDirectory() ? 'directory' : 'file',
      bytes: info.isDirectory() ? 0 : info.size,
    })
  }

  return {
    createdAt: new Date().toISOString(),
    sourceRoot: root,
    packageName: 'claude-code-lmstudio-offline',
    entries: items,
    commands: [
      'npm run smoke:offline',
      'npm run smoke:lmstudio',
      'bin/windrise skills',
      'bin/windrise doctor',
      'bin/windrise 303804',
    ],
  }
}

function printManifest(manifest) {
  const missing = manifest.entries.filter(item => !item.exists)
  console.log('Offline package manifest check')
  console.log(`Source: ${manifest.sourceRoot}`)
  for (const item of manifest.entries) {
    console.log(`- ${item.exists ? 'OK' : 'MISS'} ${item.entry} (${item.type})`)
  }
  if (missing.length > 0) {
    throw new Error(`Missing package entries: ${missing.map(item => item.entry).join(', ')}`)
  }
  console.log('\nPackage check passed.')
}

async function writeOfflinePackage(outDir, manifest) {
  if (existsSync(outDir)) {
    throw new Error(`Output directory already exists: ${outDir}`)
  }

  await mkdir(outDir, { recursive: true })
  for (const item of manifest.entries) {
    if (!item.exists) continue
    await cp(join(root, item.entry), join(outDir, item.entry), {
      recursive: item.type === 'directory',
      verbatimSymlinks: true,
    })
  }

  await writeFile(
    join(outDir, 'OFFLINE_PACKAGE_MANIFEST.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(join(outDir, 'README_OFFLINE.md'), offlineReadme(), 'utf8')
  console.log(`Offline package written to ${outDir}`)
}

async function writeTarball(outDir) {
  const tarball = `${outDir}.tar.gz`
  await execFileAsync('tar', ['-czf', tarball, '-C', resolve(outDir, '..'), basename(outDir)], {
    maxBuffer: 20 * 1024 * 1024,
  })
  console.log(`Offline package tarball written to ${tarball}`)
}

function offlineReadme() {
  return `# Offline Windrise / LM Studio Package

This package is intended to run after dependencies, source, build output, local scripts, and the local fault-code knowledge base have been copied together.

## Quick Checks

\`\`\`bash
npm run smoke:offline
npm run smoke:lmstudio
bin/windrise skills
bin/windrise doctor
\`\`\`

## Requirements

- Node.js compatible with this recovered source tree
- Local LM Studio service on a loopback URL
- The configured model, default: \`qwen3.5:9b\`

No remote Claude, Anthropic, or non-loopback LM Studio endpoint is required for the local workflow.
`
}

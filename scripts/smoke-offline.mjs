#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))

await step('bundled skills are registered', [
  process.execPath,
  [join(root, 'scripts', 'smoke-skills.mjs')],
])
await step('LLMWiki local knowledge works without live model API', [
  process.execPath,
  [join(root, 'scripts', 'smoke-llmwiki.mjs')],
])
await step('fault-code eval set passes', [
  process.execPath,
  [join(root, 'scripts', 'eval-fault-codes.mjs')],
])
await step('offline package manifest is complete', [
  process.execPath,
  [join(root, 'scripts', 'package-offline.mjs'), '--check'],
])
await step('recovered source builds locally', [
  process.execPath,
  [join(root, 'scripts', 'build.mjs')],
])

console.log('\nOffline smoke passed.')

async function step(name, [command, args]) {
  process.stdout.write(`- ${name}... `)
  try {
    await execFileAsync(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ANTHROPIC_MODEL_PROVIDER:
          process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
        SILICONFLOW_BASE_URL: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
        SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
        LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
        LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
      },
      maxBuffer: 30 * 1024 * 1024,
      timeout: 180_000,
    })
    process.stdout.write('OK\n')
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    throw new Error(output || error.message)
  }
}

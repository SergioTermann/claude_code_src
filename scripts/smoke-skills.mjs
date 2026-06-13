#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const windriseBin = join(root, 'bin', 'windrise')

const files = {
  index: await read('src/skills/bundled/index.ts'),
  windFault: await read('src/skills/bundled/windFault.ts'),
  lmstudioLocal: await read('src/skills/bundled/lmstudioLocal.ts'),
  localVerify: await read('src/skills/bundled/localVerify.ts'),
  llmwiki: await read('src/skills/bundled/llmwiki.ts'),
  lmstudioCommand: await read('src/commands/lmstudio/lmstudio.ts'),
}

assertIncludes(files.index, 'registerWindFaultSkill')
assertIncludes(files.index, 'registerLmStudioLocalSkill')
assertIncludes(files.index, 'registerLocalVerifySkill')

assertIncludes(files.windFault, "name: 'windfault'")
assertIncludes(files.windFault, "aliases: ['wind-fault', 'faultcode', 'fault-code']")
assertIncludes(files.windFault, '/llmwiki ask <fault-code>')
assertIncludes(files.windFault, 'Do not invent causes')

assertIncludes(files.lmstudioLocal, "name: 'lmstudiolocal'")
assertIncludes(files.lmstudioLocal, "aliases: ['lmstudio-local', 'offline-lmstudio', 'local-lmstudio']")
assertIncludes(files.lmstudioLocal, 'LMSTUDIO_BASE_URL')
assertIncludes(files.lmstudioLocal, 'loopback only')

assertIncludes(files.localVerify, "name: 'localverify'")
assertIncludes(files.localVerify, "aliases: ['local-verify', 'offline-verify', 'local-smoke']")
assertIncludes(files.localVerify, 'smoke:offline')
assertIncludes(files.localVerify, 'smoke:lmstudio')
assertIncludes(files.localVerify, 'eval:faults')
assertIncludes(files.localVerify, 'package:offline')

assertIncludes(files.llmwiki, 'local text knowledge directory')
assertIncludes(files.llmwiki, '/llmwiki ask <query>')

assertIncludes(files.lmstudioCommand, '/lmstudio skills')
assertIncludes(files.lmstudioCommand, '/windfault')
assertIncludes(files.lmstudioCommand, '/localverify')

const { stdout } = await execFileAsync(
  process.execPath,
  [runner, '--print', '--bare', '/lmstudio skills'],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_MODEL_PROVIDER:
        process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  },
)
assertIncludes(stdout, '/windfault')
assertIncludes(stdout, '/lmstudiolocal')
assertIncludes(stdout, '/localverify')
assertIncludes(stdout, 'npm run smoke:offline')

const { stdout: windriseSkills } = await execFileAsync(windriseBin, ['skills'], {
  cwd: root,
  env: {
    ...process.env,
    ANTHROPIC_MODEL_PROVIDER:
      process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
    LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
  },
  maxBuffer: 20 * 1024 * 1024,
  timeout: 120_000,
})
assertIncludes(windriseSkills, '/windfault')
assertIncludes(windriseSkills, '/lmstudiolocal')
assertIncludes(windriseSkills, '/localverify')

const { stdout: doctorOutput } = await execFileAsync(
  process.execPath,
  [runner, '--print', '--bare', '/lmstudio'],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_MODEL_PROVIDER:
        process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  },
)
assertIncludes(doctorOutput, 'Skills:')
assertIncludes(doctorOutput, '/windfault')
assertIncludes(doctorOutput, 'bin/windrise skills')

console.log('Skills smoke passed.')

async function read(relativePath) {
  return readFile(join(root, relativePath), 'utf8')
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)} to be present.`)
  }
}

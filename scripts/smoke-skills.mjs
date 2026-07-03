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
  documentGenerate: await read('src/skills/bundled/documentGenerate.ts'),
  workOrderGenerate: await read('src/skills/bundled/workOrderGenerate.ts'),
  lmstudioLocal: await read('src/skills/bundled/lmstudioLocal.ts'),
  localVerify: await read('src/skills/bundled/localVerify.ts'),
  llmwiki: await read('src/skills/bundled/llmwiki.ts'),
  lmstudioCommand: await read('src/commands/lmstudio/lmstudio.ts'),
}

assertIncludes(files.index, 'registerWindFaultSkill')
assertIncludes(files.index, 'registerDocumentGenerateSkill')
assertIncludes(files.index, 'registerWorkOrderGenerateSkill')
assertIncludes(files.index, 'registerLmStudioLocalSkill')
assertIncludes(files.index, 'registerLocalVerifySkill')

assertIncludes(files.windFault, "name: 'windfault'")
assertIncludes(files.windFault, "aliases: ['wind-fault', 'faultcode', 'fault-code']")
assertIncludes(files.windFault, '/llmwiki ask <fault-code>')
assertIncludes(files.windFault, 'Do not invent causes')

assertIncludes(files.documentGenerate, "name: 'documentgenerate'")
assertIncludes(files.documentGenerate, "aliases: ['document-generate', 'docgen', 'reportgen', 'report-generate']")
assertIncludes(files.documentGenerate, 'generated-knowledge/documents')
assertIncludes(files.documentGenerate, '现场故障处理报告')

assertIncludes(files.workOrderGenerate, "name: 'workordergenerate'")
assertIncludes(files.workOrderGenerate, "workordergen")
assertIncludes(files.workOrderGenerate, 'generated-knowledge/work-orders')
assertIncludes(files.workOrderGenerate, '智能工单')

assertIncludes(files.lmstudioLocal, "name: 'lmstudiolocal'")
assertIncludes(files.lmstudioLocal, "aliases: ['lmstudio-local', 'offline-lmstudio', 'local-lmstudio']")
assertIncludes(files.lmstudioLocal, 'SILICONFLOW_API_KEY')

assertIncludes(files.localVerify, "name: 'localverify'")
assertIncludes(files.localVerify, "aliases: ['local-verify', 'offline-verify', 'local-smoke']")
assertIncludes(files.localVerify, 'smoke:offline')
assertIncludes(files.localVerify, 'smoke:siliconflow')
assertIncludes(files.localVerify, 'eval:faults')
assertIncludes(files.localVerify, 'package:offline')

assertIncludes(files.llmwiki, 'local text knowledge directory')
assertIncludes(files.llmwiki, '/llmwiki ask <query>')

assertIncludes(files.lmstudioCommand, '/lmstudio skills')
assertIncludes(files.lmstudioCommand, '/windfault')
assertIncludes(files.lmstudioCommand, '/docgen')
assertIncludes(files.lmstudioCommand, '/workordergen')
assertIncludes(files.lmstudioCommand, '/localverify')

const { stdout } = await execFileAsync(
  process.execPath,
  [runner, '--print', '--bare', '/lmstudio skills'],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_MODEL_PROVIDER:
        process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
      SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  },
)
assertIncludes(stdout, '/windfault')
assertIncludes(stdout, '/docgen')
assertIncludes(stdout, '/workordergen')
assertIncludes(stdout, '/lmstudiolocal')
assertIncludes(stdout, '/localverify')
assertIncludes(stdout, 'npm run smoke:offline')

const { stdout: windriseSkills } = await execFileAsync(windriseBin, ['skills'], {
  cwd: root,
  env: {
    ...process.env,
    ANTHROPIC_MODEL_PROVIDER:
      process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
    SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
    LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
  },
  maxBuffer: 20 * 1024 * 1024,
  timeout: 120_000,
})
assertIncludes(windriseSkills, '/windfault')
assertIncludes(windriseSkills, '/docgen')
assertIncludes(windriseSkills, '/workordergen')
assertIncludes(windriseSkills, '/lmstudiolocal')
assertIncludes(windriseSkills, '/localverify')

const { stdout: workOrderOutput } = await execFileAsync(
  process.execPath,
  [
    runner,
    '--print',
    '--bare',
    '/workordergen 基于故障：变桨24V主电源开关反馈丢失；现场反馈：24V电压正常，但是主电源开关反馈还是丢失。生成智能工单摘要，不需要保存文件。',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_MODEL_PROVIDER:
        process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
      SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  },
)
assertIncludes(workOrderOutput, '# 智能工单')
assertIncludes(workOrderOutput, '首个现场动作')
assertIncludes(workOrderOutput, '主电源开关辅助触点')

const { stdout: doctorOutput } = await execFileAsync(
  process.execPath,
  [runner, '--print', '--bare', '/lmstudio skills'],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_MODEL_PROVIDER:
        process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
      SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
      LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  },
)
assertIncludes(doctorOutput, 'Windrise skills')
assertIncludes(doctorOutput, '/windfault')
assertIncludes(doctorOutput, '/docgen')
assertIncludes(doctorOutput, '/workordergen')

console.log('Skills smoke passed.')

async function read(relativePath) {
  return readFile(join(root, relativePath), 'utf8')
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)} to be present.`)
  }
}

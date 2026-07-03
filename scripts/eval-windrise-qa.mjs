#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const windriseBin = join(root, 'bin', 'windrise')

const baseEnv = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
  SILICONFLOW_BASE_URL: process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
  SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B',
  LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'https://api.siliconflow.cn/v1',
  LMSTUDIO_CHAT_MODEL: process.env.LMSTUDIO_CHAT_MODEL || 'Qwen/Qwen3.6-35B-A3B',
  LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'Qwen/Qwen3.6-35B-A3B',
}

const cases = [
  {
    name: 'model command shows SiliconFlow model',
    args: ['model'],
    expects: ['model=Qwen/Qwen3.6-35B-A3B'],
  },
  {
    name: 'date question is handled as ordinary chat',
    args: ['今天是什么日子'],
    expects: ['今天是'],
    rejects: ['通用现场排查', '报警原文'],
  },
  {
    name: 'principle question is answered by local model without raw retrieval',
    args: ['变桨系统的工作原理是什么'],
    expects: ['变桨', '叶片', '功率'],
    rejects: ['Matches for "', '系统上下文：', '本地答案：'],
  },
  {
    name: 'fault-code question uses local knowledge and gives action',
    args: ['303804是什么故障，怎么处理'],
    expects: ['303804', '24V', '主电源开关', '手动', '来源：'],
    rejects: ['Matches for "', '<LLMWiki检索>'],
  },
  {
    name: 'wind farm model mapping answers from table',
    args: ['华能四平三期对应什么机型'],
    expects: ['华能四平风电场三期', '上海电气 W2000C-93-80', '湘电 XE82-2000'],
    rejects: ['没有在内置风场机型表中找到匹配项'],
  },
]

for (const testCase of cases) {
  process.stdout.write(`- ${testCase.name}... `)
  const stdout = await runWindrise(testCase.args)
  for (const expected of testCase.expects) {
    if (!stdout.includes(expected)) {
      throw new Error(
        `Expected ${JSON.stringify(expected)} for ${testCase.args.join(' ')}\n\n${stdout}`,
      )
    }
  }
  for (const rejected of testCase.rejects ?? []) {
    if (stdout.includes(rejected)) {
      throw new Error(
        `Did not expect ${JSON.stringify(rejected)} for ${testCase.args.join(' ')}\n\n${stdout}`,
      )
    }
  }
  process.stdout.write('OK\n')
}

console.log('\nWindrise QA eval passed.')

async function runWindrise(args) {
  try {
    const { stdout, stderr } = await execFileAsync(windriseBin, args, {
      cwd: root,
      env: baseEnv,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240_000,
    })
    return `${stdout}${stderr}`
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
  }
}

#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

const cases = [
  {
    name: 'structured fault index exists',
    command: '/llmwiki read fault-index-summary.json',
    expects: ['"recordCount"', '"byBrand"', '"华仪"'],
  },
  {
    name: 'structured exact code answer',
    command: '/llmwiki ask 303804 --limit 2',
    expects: ['本地答案：303804', '24V主电源开关故障', '来源：'],
  },
  {
    name: 'short exact code 200 resolves by fault-code field',
    command: '/llmwiki ask 200 --limit 4',
    expects: ['本地答案：200', '不同含义', '200：'],
    rejects: ['20007'],
  },
  {
    name: 'short ask 320 reports ambiguity without suffix-code pollution',
    command: '/llmwiki ask 320 --limit 8',
    expects: ['不同含义', '冰传感器运行不正常', '变桨位置比较偏差大'],
    rejects: ['5320：', 'T_320：'],
  },
  {
    name: 'brand-qualified short code resolves directly',
    command: '/llmwiki ask 歌美飒 320 --limit 4',
    expects: ['结论：320 为「冰传感器运行不正常」', '歌美飒'],
    rejects: ['不同含义', '变频器检测到故障(EMS)'],
  },
  {
    name: 'short exact code 320 outranks contextual cabinet text',
    command: '/llmwiki search 320 --limit 3',
    expects: ['不同含义', '冰传感器运行不正常'],
    rejects: ['320柜风扇接触器输出与反馈不一致'],
  },
  {
    name: 'short exact code 504 returns exact grouped meanings',
    command: '/llmwiki ask 504 --limit 4',
    expects: ['不同含义', '504：无功电量超出量程', '504：3#变桨91°限位开关损坏'],
    rejects: ['6504：', '5043：', '5044：', '5047：', '5048：'],
  },
  {
    name: 'descriptive query reranks 303804 first',
    command: '/llmwiki search 变桨24V开关 --limit 1',
    expects: ['303804', '24V主电源开关故障'],
  },
  {
    name: 'multi-term yaw motor query',
    command: '/llmwiki search 偏航 电机 --limit 1',
    expects: ['偏航', '电机'],
  },
  {
    name: 'simple sensor query',
    command: '/llmwiki search 风速仪 --limit 1',
    expects: ['Matches for "风速仪"', '风速仪'],
  },
]

for (const testCase of cases) {
  process.stdout.write(`- ${testCase.name}... `)
  const stdout = await runLlmwiki(testCase.command)
  for (const expected of testCase.expects) {
    if (!stdout.includes(expected)) {
      throw new Error(
        `Expected ${JSON.stringify(expected)} for ${testCase.command}\n\n${stdout}`,
      )
    }
  }
  for (const rejected of testCase.rejects ?? []) {
    if (stdout.includes(rejected)) {
      throw new Error(
        `Did not expect ${JSON.stringify(rejected)} for ${testCase.command}\n\n${stdout}`,
      )
    }
  }
  process.stdout.write('OK\n')
}

console.log('\nFault-code eval passed.')

async function runLlmwiki(command) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [runner, '--print', '--bare', command],
      {
        cwd: root,
        env: {
          ...process.env,
          ANTHROPIC_MODEL_PROVIDER:
            process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
          LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
          LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    return stdout
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
  }
}

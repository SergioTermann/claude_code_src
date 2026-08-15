#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const cliPath = join(root, 'dist', 'claude.js')
const baseUrl = (
  process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234'
).replace(/\/$/, '')
const model = process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b'

const baseEnv = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
  LMSTUDIO_BASE_URL: baseUrl,
  LMSTUDIO_MODEL: model,
}

await step('Claude Code version is preserved', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--version'], {
    cwd: root,
    env: baseEnv,
  })
  if (!stdout.includes('2.1.88')) {
    throw new Error(stdout)
  }
})

await step('LM Studio API is local and reachable', async () => {
  if (!isLoopbackUrl(baseUrl)) {
    throw new Error(`Refusing non-local LMSTUDIO_BASE_URL: ${baseUrl}`)
  }
  const response = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  const names = (data.data ?? [])
    .map(item => item.id)
    .filter(Boolean)
  if (!names.includes(model)) {
    throw new Error(`Model ${model} not installed. Installed: ${names.join(', ') || 'none'}`)
  }
})

await step('/lmstudio doctor passes', async () => {
  const { stdout } = await runRunner(['/lmstudio'])
  if (
    !stdout.includes('[OK] LM Studio is reachable') &&
    !stdout.includes('[OK] LM Studio is reachable')
  ) {
    throw new Error(stdout)
  }
})

await step('LM Studio generation returns OK', async () => {
  const { stdout } = await runRunner(['只回答 OK'])
  if (!/\bOK\b/.test(stdout)) {
    throw new Error(stdout)
  }
  if (/LLMWiki|Matches for|本地答案/.test(stdout)) {
    throw new Error(`Normal prompt unexpectedly looked like a knowledge-base command:\n${stdout}`)
  }
})

await step('Plain identity chat is not truncated by tool schemas', async () => {
  const { stdout } = await runRunner(['你是什么模型'])
  const text = stdout.trim()
  if (text === '我是' || text.length < 12) {
    throw new Error(`Plain chat looked truncated:\n${stdout}`)
  }
  if (!/(Windrise|LM Studio|本地|模型)/i.test(text)) {
    throw new Error(`Plain identity answer did not identify local model path:\n${stdout}`)
  }
})

await step('Wind-domain principle chat can use local context without raw markers', async () => {
  const { stdout } = await runRunner(['变桨系统的工作原理是什么'])
  if (/<LLMWiki检索>|Matches for|No matches/.test(stdout)) {
    throw new Error(`Principle prompt leaked raw knowledge retrieval text:\n${stdout}`)
  }
  if (!/(变桨|桨距|叶片|控制|系统)/.test(stdout)) {
    throw new Error(`Principle prompt did not produce a wind-domain answer:\n${stdout}`)
  }
})

await step('Wind farm model mapping uses built-in table', async () => {
  const { stdout } = await runRunner(['华能四平三期对应什么机型'])
  for (const expected of ['华能四平', '三期', '上海电气 W2000C-93-80', '湘电 XE82-2000']) {
    if (!stdout.includes(expected)) {
      throw new Error(`Missing ${JSON.stringify(expected)}:\n${stdout}`)
    }
  }
})

await step('Fault-code chat automatically uses LLMWiki', async () => {
  const { stdout } = await runRunner(['SC01_03_001是什么故障，怎么处理'])
  for (const expected of [
    '轮毂温度超出最大限制',
  ]) {
    if (!stdout.includes(expected)) {
      throw new Error(`Missing ${JSON.stringify(expected)}:\n${stdout}`)
    }
  }
  if (!/轮毂.*1\s*分钟平均温度.*(>|\u8d85\u8fc7|\u9ad8\u4e8e)\s*60°C/s.test(stdout)) {
    throw new Error(`Missing temperature trigger:\n${stdout}`)
  }
  if (!/(SC01_03_001|SC0103\s*001)/.test(stdout)) {
    throw new Error(`Missing fault name:\n${stdout}`)
  }
  if (/SC04_03_001|Teached操作未完成/.test(stdout)) {
    throw new Error(`Matched wrong SC suffix code:\n${stdout}`)
  }
})

await step('Core tools remain available in JSON output', async () => {
  const { stdout } = await runRunner([
    '--output-format',
    'json',
    '--verbose',
    '只回答 OK',
  ])
  const events = JSON.parse(stdout)
  const init = events.find(
    event => event?.type === 'system' && event?.subtype === 'init',
  )
  if (!init) throw new Error(stdout)
  for (const tool of ['Bash', 'Edit', 'Read']) {
    if (!init.tools?.includes(tool)) {
      throw new Error(`Missing core tool ${tool}: ${stdout}`)
    }
  }
  for (const command of ['lmstudio', 'llmwiki']) {
    if (!init.slash_commands?.includes(command)) {
      throw new Error(`Missing slash command ${command}: ${stdout}`)
    }
  }
})

await step('Remote LM Studio URL is rejected', async () => {
  const result = await runRunner(['hi'], {
    ...baseEnv,
    LMSTUDIO_BASE_URL: 'http://8.8.8.8:11434',
  }, false)
  const output = `${result.stdout}${result.stderr}`
  if (
    result.code === 0 ||
    !/outside localhost\/private LAN|Refusing non-local LM Studio URL/.test(output)
  ) {
    throw new Error(output || `Expected rejection, got exit ${result.code}`)
  }
})

console.log('\nLM Studio smoke passed.')

async function step(name, fn) {
  process.stdout.write(`- ${name}... `)
  await fn()
  process.stdout.write('OK\n')
}

async function runRunner(args, env = baseEnv, reject = true) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [runner, '--print', '--bare', ...args],
      {
        cwd: root,
        env,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    return { ...result, code: 0 }
  } catch (error) {
    const result = {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      code: error.code ?? 1,
    }
    if (reject) {
      throw new Error(`${result.stdout}${result.stderr}` || error.message)
    }
    return result
  }
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

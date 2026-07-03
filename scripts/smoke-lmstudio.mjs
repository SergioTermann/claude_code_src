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
  process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1'
).replace(/\/$/, '')
const model = process.env.SILICONFLOW_MODEL || 'Qwen/Qwen3.6-35B-A3B'
const apiKey = process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY || ''

const baseEnv = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER: 'siliconflow',
  SILICONFLOW_BASE_URL: baseUrl,
  SILICONFLOW_MODEL: model,
  LMSTUDIO_BASE_URL: baseUrl,
  LMSTUDIO_MODEL: model,
  LMSTUDIO_CHAT_MODEL: model,
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

await step('SiliconFlow API key is configured', async () => {
  if (!apiKey) {
    throw new Error('Set SILICONFLOW_API_KEY before running this smoke test.')
  }
})

await step('SiliconFlow API is reachable', async () => {
  const response = await fetch(modelsUrl(baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  const names = (data.data ?? [])
    .map(item => item.id)
    .filter(Boolean)
  if (names.length > 0 && !names.includes(model)) {
    throw new Error(`Model ${model} not reported. Reported: ${names.slice(0, 20).join(', ')}`)
  }
})

await step('/lmstudio doctor reports SiliconFlow', async () => {
  const { stdout } = await runRunner(['/lmstudio'])
  if (!stdout.includes('Provider: siliconflow') || !stdout.includes('[OK] SiliconFlow is reachable')) {
    throw new Error(stdout)
  }
})

await step('SiliconFlow generation returns OK', async () => {
  const { stdout } = await runRunner(['只回答 OK'])
  if (!/\bOK\b/.test(stdout)) {
    throw new Error(stdout)
  }
  if (/LLMWiki|Matches for|本地答案/.test(stdout)) {
    throw new Error(`Normal prompt unexpectedly looked like a knowledge-base command:\n${stdout}`)
  }
})

await step('Plain identity chat identifies SiliconFlow route', async () => {
  const { stdout } = await runRunner(['你是什么模型'])
  const text = stdout.trim()
  if (text === '我是' || text.length < 12) {
    throw new Error(`Plain chat looked truncated:\n${stdout}`)
  }
  if (!/(Windrise|SiliconFlow|Qwen|模型)/i.test(text)) {
    throw new Error(`Plain identity answer did not identify SiliconFlow/model route:\n${stdout}`)
  }
})

await step('Fault-code chat automatically uses LLMWiki', async () => {
  const { stdout } = await runRunner(['303804是什么故障，怎么处理'])
  for (const expected of ['303804', '24V', '主电源开关故障', '来源：']) {
    if (!stdout.includes(expected)) {
      throw new Error(`Missing ${JSON.stringify(expected)}:\n${stdout}`)
    }
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
  if (init.model !== model) {
    throw new Error(`Expected init.model ${model}, got ${init.model}`)
  }
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

console.log('\nSiliconFlow smoke passed.')

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
        timeout: 180_000,
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

function modelsUrl(value) {
  return /\/v1$/i.test(value) ? `${value}/models` : `${value}/v1/models`
}

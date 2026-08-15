#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(root, 'dist', 'claude.js')
const llmWikiEnv = resolveLlmWikiEnv()
const modelMode = resolveModelMode()
const modelDefaults = modelDefaultsForMode(modelMode)

const env = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER: 'lmstudio',
  WINDRISE_MODEL_MODE: modelMode,
  LMSTUDIO_CHAT_MODEL:
    process.env.LMSTUDIO_CHAT_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    modelDefaults.model,
  LMSTUDIO_MODEL:
    process.env.LMSTUDIO_MODEL ||
    modelDefaults.model,
  LMSTUDIO_BASE_URL: (
    process.env.LMSTUDIO_BASE_URL || modelDefaults.baseUrl
  ).replace(/\/$/, ''),
  ...llmWikiEnv,
  DISABLE_INSTALLATION_CHECKS: process.env.DISABLE_INSTALLATION_CHECKS || '1',
  MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || '0',
  WINDRISE_ENABLE_THINKING: process.env.WINDRISE_ENABLE_THINKING || '0',
  WINDRISE: '1',
}

const args = process.argv.slice(2)
const launchArgs = args.includes('--thinking')
  ? args
  : ['--thinking', 'disabled', ...args]
const llmwikiIndex = args.findIndex(
  arg => arg === '/llmwiki' || arg === '/wiki' || arg.startsWith('/llmwiki '),
)
const lmstudioIndex = args.findIndex(
  arg =>
    arg === '/lmstudio' ||
    arg === '/windrise' ||
    arg.startsWith('/lmstudio ') ||
    arg.startsWith('/windrise '),
)
const isPrintMode = args.includes('--print') || args.includes('-p')
if (isPrintMode && llmwikiIndex >= 0) {
  await runLlmWikiCommand(args, llmwikiIndex, env)
  process.exit(0)
}
if (isPrintMode && lmstudioIndex >= 0) {
  await runLmStudioCommand(args, lmstudioIndex, env)
  process.exit(0)
}

const localBaseUrl = env.LMSTUDIO_BASE_URL
const localHealthUrl = openAICompatibleUrl(localBaseUrl, 'models')
const providerLabel = modelDefaults.label

if (!isAllowedLocalModelUrl(localBaseUrl)) {
  console.error(
    `Refusing ${providerLabel} URL outside localhost/private LAN: ${localBaseUrl}.`,
  )
  process.exit(1)
}

try {
  const response = await fetch(localHealthUrl, {
    headers: modelApiHeaders(),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
} catch (error) {
  console.error(
    `${providerLabel} is not reachable at ${localBaseUrl}. Start vLLM first, or set LMSTUDIO_BASE_URL.`,
  )
  if (error instanceof Error && error.message) {
    console.error(`Details: ${error.message}`)
  }
  process.exit(1)
}

function resolveModelMode() {
  const raw = String(process.env.WINDRISE_MODEL_MODE || process.env.MODEL_MODE || 'vllm')
    .trim()
    .toLowerCase()
  return raw === 'lmstudio' ? 'lmstudio' : 'vllm'
}

function modelDefaultsForMode(mode) {
  if (mode === 'vllm') {
    return {
      baseUrl: 'http://127.0.0.1:9527',
      model: 'Qwen-30B',
      label: 'vLLM',
    }
  }
  return {
    baseUrl: 'http://127.0.0.1:1234',
    model: 'qwen/qwen3.5-9b',
    label: 'LM Studio',
  }
}

const child = spawn(process.execPath, [cliPath, ...launchArgs], {
  env,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

async function runLlmWikiCommand(args, commandIndex, env) {
  if (env.LLMWIKI_PROJECT) process.env.LLMWIKI_PROJECT = env.LLMWIKI_PROJECT
  if (env.LLMWIKI_DIR) process.env.LLMWIKI_DIR = env.LLMWIKI_DIR
  const commandToken = args[commandIndex]
  const inlineArgs = commandToken.startsWith('/llmwiki ')
    ? commandToken.slice('/llmwiki '.length)
    : ''
  const trailingArgs = args.slice(commandIndex + 1).join(' ')
  const commandArgs = [inlineArgs, trailingArgs].filter(Boolean).join(' ')
  const outfile = join(
    tmpdir(),
    `claude-code-llmwiki-command-${process.pid}.mjs`,
  )
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [join(root, 'src', 'commands', 'llmwiki', 'llmwiki.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  const mod = await import(`${outfile}?t=${Date.now()}`)
  const result = await mod.call(commandArgs)
  if (result.type === 'text') {
    process.stdout.write(result.value.endsWith('\n') ? result.value : `${result.value}\n`)
    return
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

async function runLmStudioCommand(args, commandIndex, env) {
  process.env.ANTHROPIC_MODEL_PROVIDER = env.ANTHROPIC_MODEL_PROVIDER
  process.env.LMSTUDIO_MODEL = env.LMSTUDIO_MODEL
  process.env.LMSTUDIO_BASE_URL = env.LMSTUDIO_BASE_URL
  process.env.WINDRISE = env.WINDRISE
  if (env.LLMWIKI_PROJECT) process.env.LLMWIKI_PROJECT = env.LLMWIKI_PROJECT
  if (env.LLMWIKI_DIR) process.env.LLMWIKI_DIR = env.LLMWIKI_DIR
  const commandToken = args[commandIndex]
  const commandName = commandToken.startsWith('/windrise')
    ? '/windrise'
    : '/lmstudio'
  const inlineArgs = commandToken.startsWith(`${commandName} `)
    ? commandToken.slice(commandName.length + 1)
    : ''
  const trailingArgs = args.slice(commandIndex + 1).join(' ')
  const commandArgs = [inlineArgs, trailingArgs].filter(Boolean).join(' ')
  const outfile = join(tmpdir(), 'claude-code-lmstudio-command.mjs')
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [join(root, 'src', 'commands', 'lmstudio', 'lmstudio.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  const mod = await import(`${outfile}?t=${Date.now()}`)
  const result = await mod.call(commandArgs)
  if (result.type === 'text') {
    process.stdout.write(result.value.endsWith('\n') ? result.value : `${result.value}\n`)
    return
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

function resolveLlmWikiEnv() {
  if (process.env.LLMWIKI_PROJECT || process.env.LLMWIKI_DIR) return {}

  const candidates = [process.cwd(), root]
  for (const candidate of candidates) {
    const projectPath = resolve(candidate)
    if (existsSync(join(projectPath, '.llm-wiki'))) {
      return { LLMWIKI_PROJECT: projectPath }
    }
    const windWikiProject = join(projectPath, 'wind-llmwiki')
    if (existsSync(join(windWikiProject, '.llm-wiki'))) {
      return { LLMWIKI_PROJECT: windWikiProject }
    }
    const windFaultProject = join(projectPath, '风机故障码')
    if (existsSync(windFaultProject)) {
      return { LLMWIKI_PROJECT: windFaultProject }
    }
  }

  return {}
}

function isAllowedLocalModelUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (ipv4) {
      const first = Number(ipv4[1])
      const second = Number(ipv4[2])
      return (
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first === 127
      )
    }
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

function modelApiHeaders() {
  const token =
    process.env.LMSTUDIO_API_KEY ||
    process.env.VLLM_API_KEY ||
    process.env.OPENAI_API_KEY
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function openAICompatibleUrl(baseUrl, path) {
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '')
  const normalizedPath = String(path || '').replace(/^\//, '')
  if (normalizedBase.endsWith('/v1')) {
    return `${normalizedBase}/${normalizedPath}`
  }
  return `${normalizedBase}/v1/${normalizedPath}`
}

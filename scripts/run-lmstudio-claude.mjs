#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(root, 'dist', 'claude.js')
const llmWikiEnv = resolveLlmWikiEnv()

const env = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER: 'lmstudio',
  LMSTUDIO_CODER_MODEL:
    process.env.LMSTUDIO_CODER_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    'qwen3.5-9b-coder',
  LMSTUDIO_CHAT_MODEL:
    process.env.LMSTUDIO_CHAT_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    process.env.LMSTUDIO_CODER_MODEL ||
    'qwen3.5-9b-coder',
  LMSTUDIO_ROUTER_MODEL:
    process.env.LMSTUDIO_ROUTER_MODEL ||
    process.env.LMSTUDIO_CODER_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    'qwen3.5-9b-coder',
  LMSTUDIO_MODEL:
    process.env.LMSTUDIO_MODEL ||
    process.env.LMSTUDIO_CODER_MODEL ||
    'qwen3.5-9b-coder',
  LMSTUDIO_BASE_URL: (
    process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234'
  ).replace(/\/$/, ''),
  ...llmWikiEnv,
  DISABLE_INSTALLATION_CHECKS: process.env.DISABLE_INSTALLATION_CHECKS || '1',
  WINDRISE: '1',
}

const args = process.argv.slice(2)
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
const localHealthUrl = `${localBaseUrl}/v1/models`
const providerLabel = 'LM Studio'

if (!isLoopbackUrl(localBaseUrl)) {
  console.error(
    `Refusing non-local ${providerLabel} URL: ${localBaseUrl}. Use a localhost model server for offline mode.`,
  )
  process.exit(1)
}

try {
  const response = await fetch(localHealthUrl, {
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
} catch (error) {
  console.error(
    `${providerLabel} is not reachable at ${localBaseUrl}. Start the local model server first, or set LMSTUDIO_BASE_URL.`,
  )
  if (error instanceof Error && error.message) {
    console.error(`Details: ${error.message}`)
  }
  process.exit(1)
}

const child = spawn(process.execPath, [cliPath, ...args], {
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
  const outfile = join(tmpdir(), 'claude-code-llmwiki-command.mjs')
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
    const windFaultProject = join(projectPath, '风机故障码')
    if (existsSync(windFaultProject)) {
      return { LLMWIKI_PROJECT: windFaultProject }
    }
  }

  return {}
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

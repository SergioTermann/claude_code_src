#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
loadEnvFile(join(root, '.env'))
const cliPath = join(root, 'dist', 'claude.js')
const llmWikiEnv = resolveLlmWikiEnv()

const env = {
  ...process.env,
  ANTHROPIC_MODEL_PROVIDER:
    process.env.ANTHROPIC_MODEL_PROVIDER || 'siliconflow',
  SILICONFLOW_BASE_URL: (
    process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1'
  ).replace(/\/$/, ''),
  SILICONFLOW_MODEL:
    process.env.SILICONFLOW_MODEL ||
    'Qwen/Qwen3.6-35B-A3B',
  LMSTUDIO_CHAT_MODEL:
    process.env.LMSTUDIO_CHAT_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    process.env.SILICONFLOW_MODEL ||
    'Qwen/Qwen3.6-35B-A3B',
  LMSTUDIO_MODEL:
    process.env.LMSTUDIO_MODEL ||
    process.env.SILICONFLOW_MODEL ||
    'Qwen/Qwen3.6-35B-A3B',
  LMSTUDIO_BASE_URL: (
    process.env.LMSTUDIO_BASE_URL ||
    process.env.SILICONFLOW_BASE_URL ||
    'https://api.siliconflow.cn/v1'
  ).replace(/\/$/, ''),
  ...llmWikiEnv,
  DISABLE_INSTALLATION_CHECKS: process.env.DISABLE_INSTALLATION_CHECKS || '1',
  MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || '0',
  WINDRISE_ENABLE_THINKING: process.env.WINDRISE_ENABLE_THINKING || '0',
  WINDRISE: '1',
}

function loadEnvFile(filePath) {
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (!key || process.env[key] !== undefined) continue
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
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
const workOrderSkillIndex = args.findIndex(isWorkOrderSkillArg)
const isPrintMode = args.includes('--print') || args.includes('-p')
if (isPrintMode && llmwikiIndex >= 0) {
  await runLlmWikiCommand(args, llmwikiIndex, env)
  process.exit(0)
}
if (isPrintMode && lmstudioIndex >= 0) {
  await runLmStudioCommand(args, lmstudioIndex, env)
  process.exit(0)
}
if (isPrintMode && workOrderSkillIndex >= 0) {
  await runWorkOrderCommand(args, workOrderSkillIndex)
  process.exit(0)
}

let effectiveArgs = args

const isSiliconFlow = env.ANTHROPIC_MODEL_PROVIDER === 'siliconflow'
const localBaseUrl = isSiliconFlow ? env.SILICONFLOW_BASE_URL : env.LMSTUDIO_BASE_URL
const localHealthUrl = chatModelsUrl(localBaseUrl)
const providerLabel = isSiliconFlow ? 'SiliconFlow' : 'LM Studio'

if (!isSiliconFlow && !isAllowedLocalModelUrl(localBaseUrl)) {
  console.error(
    `Refusing ${providerLabel} URL outside localhost/private LAN: ${localBaseUrl}.`,
  )
  process.exit(1)
}

if (isSiliconFlow && !process.env.SILICONFLOW_API_KEY && !process.env.OPENAI_COMPAT_API_KEY) {
  console.error('SiliconFlow API key is not set. Set SILICONFLOW_API_KEY first.')
  process.exit(1)
}

try {
  const response = await fetch(localHealthUrl, {
    headers: isSiliconFlow
      ? { Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY}` }
      : undefined,
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
} catch (error) {
  console.error(
    isSiliconFlow
      ? `${providerLabel} is not reachable at ${localBaseUrl}. Check SILICONFLOW_API_KEY, network access, or SILICONFLOW_BASE_URL.`
      : `${providerLabel} is not reachable at ${localBaseUrl}. Start LM Studio first, or set LMSTUDIO_BASE_URL.`,
  )
  if (error instanceof Error && error.message) {
    console.error(`Details: ${error.message}`)
  }
  process.exit(1)
}

const launchArgs = effectiveArgs.includes('--thinking')
  ? effectiveArgs
  : ['--thinking', 'disabled', ...effectiveArgs]

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

async function runWorkOrderCommand(args, commandIndex) {
  const commandArgs = extractSlashCommandArgs(args, commandIndex, [
    '/workordergen',
    '/workorder-gen',
    '/smartworkorder',
    '/smart-workorder',
    '/gongdan',
  ])
  const outfile = join(tmpdir(), 'claude-code-workorder-command.mjs')
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [join(root, 'src', 'skills', 'bundled', 'workOrderBuilder.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  const mod = await import(`${outfile}?t=${Date.now()}`)
  const output = mod.buildSmartWorkOrderMarkdown(commandArgs)
  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
}

function extractSlashCommandArgs(args, commandIndex, commands) {
  const commandToken = args[commandIndex]
  const command = commands.find(item => commandToken === item || commandToken.startsWith(`${item} `))
  const inlineArgs = command && commandToken.startsWith(`${command} `)
    ? commandToken.slice(command.length + 1)
    : ''
  const trailingArgs = args.slice(commandIndex + 1).join(' ')
  return [inlineArgs, trailingArgs].filter(Boolean).join(' ')
}

function isWorkOrderSkillArg(arg) {
  return [
    '/workordergen',
    '/workorder-gen',
    '/smartworkorder',
    '/smart-workorder',
    '/gongdan',
  ].some(command => arg === command || arg.startsWith(`${command} `))
}

async function runLmStudioCommand(args, commandIndex, env) {
  process.env.ANTHROPIC_MODEL_PROVIDER = env.ANTHROPIC_MODEL_PROVIDER
  process.env.SILICONFLOW_BASE_URL = env.SILICONFLOW_BASE_URL
  process.env.SILICONFLOW_MODEL = env.SILICONFLOW_MODEL
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

function chatModelsUrl(baseUrl) {
  return /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`
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

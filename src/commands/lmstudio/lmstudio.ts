import { stat } from 'fs/promises'
import { join } from 'path'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import {
  LLMWIKI_APP_STATE_PATH,
  isConfiguredLLMWikiPathPresent,
  loadLLMWikiProjectsFromAppState,
  resolveLLMWikiProject,
} from '../../utils/llmwikiDiscovery.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { assertOnlineOrLoopbackUrl } from '../../utils/offline.js'

type LmStudioModelsResponse = {
  data?: Array<{ id?: string }>
}

const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234'
const DEFAULT_LMSTUDIO_MODEL = 'qwen3.5-9b-coder'

export const call: LocalCommandCall = async args => {
  const command = args.trim().toLowerCase() || 'doctor'
  if (command === 'help' || command === '--help' || command === '-h') {
    return text(helpText())
  }
  if (command === 'skills') {
    return text(renderSkills())
  }
  if (command !== 'doctor') {
    return text(`Unknown lmstudio command: ${command}\n\n${helpText()}`)
  }
  return text(await renderDoctor())
}

function text(value: string): LocalCommandResult {
  return { type: 'text', value }
}

function helpText(): string {
  return [
    'Local model commands:',
    '  /lmstudio doctor',
    '  /lmstudio skills',
    '',
    'Environment:',
    '  LMSTUDIO_BASE_URL    LM Studio server URL',
    '  LMSTUDIO_MODEL       LM Studio model name',
    '  WINDRISE_ENABLE_NETWORK  Enable web search/fetch in Windrise',
    '  WINDRISE_DISABLE_AUTO_LLMWIKI  Disable automatic LLMWiki retrieval',
    '  LLMWIKI_PROJECT      LLMWiki project root or text knowledge directory',
    '  LLMWIKI_DIR          Path to a .llm-wiki directory',
  ].join('\n')
}

function renderSkills(): string {
  return [
    'Local LM Studio / Windrise skills',
    '',
    '- /windfault [fault code or fault description]',
    '  Diagnose wind turbine fault codes using local LLMWiki/fault-code records.',
    '  Aliases: /wind-fault, /faultcode, /fault-code',
    '',
    '- /lmstudiolocal [diagnostic question]',
    '  Diagnose local LM Studio provider, offline mode, loopback URL, and local smoke checks.',
    '  Aliases: /lmstudio-local, /offline-lmstudio, /local-lmstudio',
    '',
    '- /localverify [what changed]',
    '  Choose the right local verification path before handing off changes.',
    '  Aliases: /local-verify, /offline-verify, /local-smoke',
    '',
    '- /llmwiki [question or search terms]',
    '  Search standard .llm-wiki projects or local text knowledge directories.',
    '',
    'Recommended checks:',
    '  npm run smoke:offline',
    '  npm run smoke:lmstudio',
  ].join('\n')
}

async function renderDoctor(): Promise<string> {
  const provider = getAPIProvider()
  const baseUrl = (
    process.env.LMSTUDIO_BASE_URL || DEFAULT_LMSTUDIO_BASE_URL
  ).replace(/\/$/, '')
  const model = process.env.LMSTUDIO_MODEL || DEFAULT_LMSTUDIO_MODEL
  const providerName = 'LM Studio'
  const lines = [
    'Local model / Windrise doctor',
    '',
    `Provider: ${provider}`,
    `${providerName} URL: ${baseUrl}`,
    `${providerName} model: ${model}`,
    `Windrise network: ${process.env.WINDRISE_ENABLE_NETWORK === '0' ? 'disabled' : 'enabled'}`,
    `Windrise auto LLMWiki: ${process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1' ? 'disabled' : 'enabled'}`,
    '',
  ]

  const localModel = await checkLmStudio(baseUrl, model)
  lines.push(...localModel)
  lines.push('')
  lines.push(...(await checkLLMWiki()))
  lines.push('')
  lines.push(...checkSkills())
  lines.push('')
  lines.push(...(await checkBuildOutput()))

  return lines.join('\n')
}

async function checkLmStudio(baseUrl: string, model: string): Promise<string[]> {
  try {
    assertOnlineOrLoopbackUrl('LM Studio doctor', baseUrl)
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) {
      return [
        fail(`LM Studio API returned ${response.status} ${response.statusText}`),
        hint('Start the LM Studio local server or set LMSTUDIO_BASE_URL to the running server.'),
      ]
    }

    const data = (await response.json()) as LmStudioModelsResponse
    const modelNames = (data.data ?? [])
      .map(item => item.id)
      .filter((name): name is string => Boolean(name))
    const hasModel =
      modelNames.length === 0 || modelNames.some(name => name === model)
    return [
      ok(`LM Studio is reachable (${modelNames.length} model(s) reported).`),
      hasModel
        ? ok(`Model ${model} is available.`)
        : warn(
            `Model ${model} was not found. Reported models: ${modelNames.join(', ') || 'none'}`,
          ),
      ...(hasModel
        ? []
        : [hint('Load the model in LM Studio or set LMSTUDIO_MODEL to the served model ID.')]),
    ]
  } catch (error) {
    return [
      fail(`LM Studio is not reachable at ${baseUrl}.`),
      hint(error instanceof Error ? error.message : String(error)),
    ]
  }
}

async function checkLLMWiki(): Promise<string[]> {
  const lines = ['LLMWiki:']
  if (process.env.LLMWIKI_PROJECT) {
    lines.push(
      envLine('LLMWIKI_PROJECT', process.env.LLMWIKI_PROJECT),
    )
  }
  if (process.env.LLMWIKI_DIR) {
    lines.push(envLine('LLMWIKI_DIR', process.env.LLMWIKI_DIR))
  }

  try {
    const resolution = await resolveLLMWikiProject()
    if (resolution.project) {
      lines.push(
        ok(
          `Resolved project from ${resolution.source}: ${resolution.project.path}`,
        ),
      )
      return lines
    } else {
      lines.push(
        warn(
          `No LLMWiki project found from env, cwd ancestors, or ${LLMWIKI_APP_STATE_PATH}.`,
        ),
      )
      lines.push(
        hint(
          'Set LLMWIKI_PROJECT to a project root containing .llm-wiki, or set LLMWIKI_DIR to that .llm-wiki directory.',
        ),
      )
    }
  } catch (error) {
    lines.push(fail(error instanceof Error ? error.message : String(error)))
  }

  const appProjects = await loadLLMWikiProjectsFromAppState()
  lines.push(
    appProjects.length > 0
      ? ok(`App state contains ${appProjects.length} valid project(s).`)
      : warn(`No valid projects found in ${LLMWIKI_APP_STATE_PATH}.`),
  )
  return lines
}

function checkSkills(): string[] {
  return [
    'Skills:',
    ok('Local skills available: /windfault, /lmstudiolocal, /localverify, /llmwiki.'),
    hint('Run: bin/windrise skills'),
  ]
}

async function checkBuildOutput(): Promise<string[]> {
  const outputPath = join(process.cwd(), 'dist', 'claude.js')
  try {
    const info = await stat(outputPath)
    return [ok(`Build output exists: ${outputPath} (${info.size} bytes).`)]
  } catch {
    return [
      warn(`Build output is missing: ${outputPath}`),
      hint('Run: npm run build'),
    ]
  }
}

function envLine(name: string, value: string): string {
  const status = isConfiguredLLMWikiPathPresent(value) ? 'exists' : 'missing'
  return `- ${name}: ${value} (${status})`
}

function ok(message: string): string {
  return `[OK] ${message}`
}

function warn(message: string): string {
  return `[WARN] ${message}`
}

function fail(message: string): string {
  return `[FAIL] ${message}`
}

function hint(message: string): string {
  return `  Hint: ${message}`
}

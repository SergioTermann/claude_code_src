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

const DEFAULT_LMSTUDIO_BASE_URL = 'http://10.46.161.210:9527'
const DEFAULT_LMSTUDIO_MODEL = 'Qwen-30B'
const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
const DEFAULT_SILICONFLOW_MODEL = 'Qwen/Qwen3.6-35B-A3B'

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
    'SiliconFlow / OpenAI-compatible commands:',
    '  /lmstudio doctor',
    '  /lmstudio skills',
    '',
    'Environment:',
    '  SILICONFLOW_API_KEY  SiliconFlow API key',
    '  SILICONFLOW_BASE_URL SiliconFlow OpenAI-compatible base URL',
    '  SILICONFLOW_MODEL    SiliconFlow model name',
    '  WINDRISE_ENABLE_NETWORK  Enable web search/fetch in Windrise',
    '  WINDRISE_DISABLE_AUTO_LLMWIKI  Disable automatic LLMWiki retrieval',
    '  LLMWIKI_PROJECT      LLMWiki project root or text knowledge directory',
    '  LLMWIKI_DIR          Path to a .llm-wiki directory',
  ].join('\n')
}

function renderSkills(): string {
  return [
    'SiliconFlow / Windrise skills',
    '',
    '- /windfault [fault code or fault description]',
    '  Diagnose wind turbine fault codes using local LLMWiki/fault-code records.',
    '  Aliases: /wind-fault, /faultcode, /fault-code',
    '',
    '- /docgen [document type and source context]',
    '  Generate Windrise reports, work-order summaries, test documents, and PPT outlines.',
    '  Aliases: /document-generate, /reportgen, /report-generate',
    '',
    '- /workordergen [fault context, alarm, or conversation_id]',
    '  Generate smart work orders from alarms, field feedback, and troubleshooting conclusions.',
    '  Aliases: /workorder-gen, /smartworkorder, /smart-workorder, /gongdan',
    '',
    '- /lmstudiolocal [diagnostic question]',
    '  Diagnose SiliconFlow/OpenAI-compatible provider, model URL, and local knowledge checks.',
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
    '  npm run smoke:offline',
  ].join('\n')
}

async function renderDoctor(): Promise<string> {
  const provider = getAPIProvider()
  const usingSiliconFlow = provider === 'siliconflow'
  const baseUrl = (usingSiliconFlow
    ? process.env.SILICONFLOW_BASE_URL || DEFAULT_SILICONFLOW_BASE_URL
    : process.env.LMSTUDIO_BASE_URL || DEFAULT_LMSTUDIO_BASE_URL
  ).replace(/\/$/, '')
  const model = usingSiliconFlow
    ? process.env.SILICONFLOW_MODEL || DEFAULT_SILICONFLOW_MODEL
    : process.env.LMSTUDIO_MODEL || DEFAULT_LMSTUDIO_MODEL
  const providerName = usingSiliconFlow ? 'SiliconFlow' : 'vLLM'
  const lines = [
    'SiliconFlow / Windrise doctor',
    '',
    `Provider: ${provider}`,
    `${providerName} URL: ${baseUrl}`,
    `${providerName} model: ${model}`,
    `Windrise network: ${process.env.WINDRISE_ENABLE_NETWORK === '0' ? 'disabled' : 'enabled'}`,
    `Windrise auto LLMWiki: ${process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1' ? 'disabled' : 'enabled'}`,
    '',
  ]

  const localModel = await checkOpenAICompatible(providerName, baseUrl, model)
  lines.push(...localModel)
  lines.push('')
  lines.push(...(await checkLLMWiki()))
  lines.push('')
  lines.push(...checkSkills())
  lines.push('')
  lines.push(...(await checkBuildOutput()))

  return lines.join('\n')
}

async function checkOpenAICompatible(providerName: string, baseUrl: string, model: string): Promise<string[]> {
  try {
    if (providerName !== 'SiliconFlow') {
      assertOnlineOrLoopbackUrl('vLLM doctor', baseUrl)
    }
    const apiKey = process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY || ''
    const response = await fetch(modelsUrl(baseUrl), {
      headers: providerName === 'SiliconFlow' && apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
      signal: AbortSignal.timeout(3_000),
    })
    if (!response.ok) {
      return [
        fail(`${providerName} API returned ${response.status} ${response.statusText}`),
        hint(providerName === 'SiliconFlow'
          ? 'Set SILICONFLOW_API_KEY and check SILICONFLOW_BASE_URL.'
          : 'Start vLLM or set LMSTUDIO_BASE_URL to the running OpenAI-compatible server.'),
      ]
    }

    const data = (await response.json()) as LmStudioModelsResponse
    const modelNames = (data.data ?? [])
      .map(item => item.id)
      .filter((name): name is string => Boolean(name))
    const hasModel =
      modelNames.length === 0 || modelNames.some(name => name === model)
    return [
      ok(`${providerName} is reachable (${modelNames.length} model(s) reported).`),
      hasModel
        ? ok(`Model ${model} is available.`)
        : warn(
            `Model ${model} was not found. Reported models: ${modelNames.join(', ') || 'none'}`,
          ),
      ...(hasModel
        ? []
        : [hint(providerName === 'SiliconFlow'
          ? 'Set SILICONFLOW_MODEL to an available SiliconFlow model ID.'
          : 'Start vLLM with the model or set LMSTUDIO_MODEL to the served model ID.')]),
    ]
  } catch (error) {
    return [
      fail(`${providerName} is not reachable at ${baseUrl}.`),
      hint(error instanceof Error ? error.message : String(error)),
    ]
  }
}

function modelsUrl(baseUrl: string): string {
  return /\/v1$/i.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`
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
    ok('Local skills available: /windfault, /docgen, /workordergen, /lmstudiolocal, /localverify, /llmwiki.'),
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

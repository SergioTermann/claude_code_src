import { randomUUID } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import { basename, extname, join } from 'path'
import type {
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getCwd } from '../../utils/cwd.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { assertOnlineOrLoopbackUrl } from '../../utils/offline.js'
import {
  createWindFarmModelContext,
  shouldAnswerWindFarmModelQuestion,
} from '../../utils/windFarmModels.js'

type LmStudioMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id?: string
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
}

type LmStudioTool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: unknown
  }
}

type LmStudioChatResponse = {
  model?: string
  message?: {
    content?: string
    tool_calls?: Array<{
      id?: string
      function?: {
        name?: string
        arguments?: Record<string, unknown> | string
      }
    }>
  }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: {
          name?: string
          arguments?: string | Record<string, unknown>
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

type OpenAIChatStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

type OpenAIChatRequest = {
  model: string
  messages: OpenAIMessage[]
  stream: boolean
  tools?: LmStudioTool[]
  response_format?: {
    type: 'json_object' | 'json_schema'
    json_schema?: {
      name: string
      schema: Record<string, unknown>
    }
  }
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
}

type RequestOptions = {
  signal?: AbortSignal
  timeout?: number
}

const DEFAULT_LMSTUDIO_BASE_URL = 'http://127.0.0.1:1234'
const DEFAULT_LMSTUDIO_MODEL = 'qwen3.5-9b-coder'
const DEFAULT_LMSTUDIO_CHAT_MODEL = DEFAULT_LMSTUDIO_MODEL

export function createLmStudioAnthropicClient(): unknown {
  return {
    beta: {
      messages: {
        countTokens(params: {
          messages?: BetaMessageParam[]
          tools?: BetaToolUnion[]
          system?: BetaMessageStreamParams['system']
        }) {
          return Promise.resolve({
            input_tokens: estimateRequestTokens(params),
          })
        },
        create(params: BetaMessageStreamParams, options?: RequestOptions) {
          if (params.stream) {
            return {
              withResponse: async () => {
                const data = streamBufferedLmStudioAsAnthropic(params, options)
                return {
                  data,
                  request_id: randomUUID(),
                  response: new Response(null),
                }
              },
            }
          }

          return createLmStudioMessage(params, options)
        },
      },
    },
  }
}

async function* streamBufferedLmStudioAsAnthropic(
  params: BetaMessageStreamParams,
  options?: RequestOptions,
): AsyncGenerator<BetaRawMessageStreamEvent> {
  const signal = options?.signal ?? AbortSignal.timeout(options?.timeout ?? 120_000)
  const messages = await toLmStudioMessages(params)
  if (!shouldUseLmStudioStreaming(params, messages)) {
    yield* streamBufferedLmStudioMessageAsAnthropic(params, options)
    return
  }

  const chunks = streamLmStudioChatCompletions(params, messages, signal)
  let text = ''

  yield {
    type: 'message_start',
    message: {
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      model: resolveModel(params.model),
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: emptyUsage(),
    },
  } as BetaRawMessageStreamEvent

  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  } as BetaRawMessageStreamEvent

  for await (const chunk of chunks) {
    if (!chunk) continue
    text += chunk
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    } as BetaRawMessageStreamEvent
  }

  yield {
    type: 'content_block_stop',
    index: 0,
  } as BetaRawMessageStreamEvent
  yield {
    type: 'message_delta',
    delta: {
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: estimateTokens(text) },
  } as unknown as BetaRawMessageStreamEvent
  yield { type: 'message_stop' } as BetaRawMessageStreamEvent
}

async function* streamBufferedLmStudioMessageAsAnthropic(
  params: BetaMessageStreamParams,
  options?: RequestOptions,
): AsyncGenerator<BetaRawMessageStreamEvent> {
  const message = await createLmStudioMessage(
    { ...params, stream: false } as BetaMessageStreamParams,
    options,
  )

  yield {
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: emptyUsage(),
    },
  } as BetaRawMessageStreamEvent

  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text') {
      yield {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      } as BetaRawMessageStreamEvent
      yield {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      } as BetaRawMessageStreamEvent
      yield {
        type: 'content_block_stop',
        index,
      } as BetaRawMessageStreamEvent
      continue
    }

    if (block.type === 'tool_use') {
      yield {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      } as BetaRawMessageStreamEvent
      yield {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      } as BetaRawMessageStreamEvent
      yield {
        type: 'content_block_stop',
        index,
      } as BetaRawMessageStreamEvent
    }
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence,
    },
    usage: message.usage,
  } as unknown as BetaRawMessageStreamEvent
  yield { type: 'message_stop' } as BetaRawMessageStreamEvent
}

async function createLmStudioMessage(
  params: BetaMessageStreamParams,
  options?: RequestOptions,
): Promise<BetaMessage> {
  const content: BetaMessage['content'] = []
  const response = await callLmStudio(params, options, false)
  const message = response.message
  if (message?.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      const fn = toolCall.function
      if (!fn?.name) continue
      content.push({
        type: 'tool_use',
        id: toolCall.id || createAnthropicToolUseId(),
        name: fn.name,
        input: normalizeToolArguments(fn.arguments),
      })
    }
  }

  if (message?.content) {
    content.push({ type: 'text', text: message.content } as BetaMessage['content'][number])
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: response.model ?? resolveModel(params.model),
    content,
    stop_reason: content.some(block => block.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.prompt_eval_count ?? 0,
      output_tokens: response.eval_count ?? estimateTokens(message?.content ?? ''),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as BetaMessage
}

async function callLmStudio(
  params: BetaMessageStreamParams,
  options: RequestOptions | undefined,
): Promise<Response & { message?: LmStudioChatResponse['message'] } & LmStudioChatResponse> {
  const controller = new AbortController()
  const timeoutMs =
    options?.timeout ?? parseInt(process.env.API_TIMEOUT_MS || '600000', 10)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  options?.signal?.addEventListener('abort', () => controller.abort(), {
    once: true,
  })

  try {
    const messages = await toLmStudioMessages(params)
    const directWindFarmAnswer = directWindFarmModelAnswer(messages)
    if (directWindFarmAnswer) {
      return lmStudioTextResponse(directWindFarmAnswer, resolveModel(params.model))
    }
    const directRetrievalAnswer = directWindriseRetrievalAnswer(messages)
    if (directRetrievalAnswer) {
      return lmStudioTextResponse(directRetrievalAnswer, resolveModel(params.model))
    }
    return await callLmStudioChatCompletions(params, messages, controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

function directWindFarmModelAnswer(
  messages: LmStudioMessage[],
): string | undefined {
  if (process.env.WINDRISE !== '1') return undefined
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content
  if (!lastUser?.includes('<风场机型映射>')) return undefined

  const mapping = lastUser.match(/<风场机型映射>\n([\s\S]*?)\n<\/风场机型映射>/)
  const content = mapping?.[1]?.trim()
  if (!content) return undefined

  return content
    .split(/\r?\n/)
    .filter(line => !line.startsWith('下面是系统内置的风场与风机型号对应关系'))
    .join('\n')
    .trim()
}

function directWindriseRetrievalAnswer(
  messages: LmStudioMessage[],
): string | undefined {
  if (process.env.WINDRISE !== '1') return undefined
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content
  if (!lastUser?.includes('<LLMWiki检索>')) return undefined

  const retrieval = lastUser.match(/<LLMWiki检索>\n([\s\S]*?)\n<\/LLMWiki检索>/)
  const content = retrieval?.[1]?.trim()
  if (!content || content.includes('No matches.')) return undefined
  if (!/^检索词：\s*[a-z0-9_/-]+\s*$/im.test(content)) return undefined
  if (!/^本地答案：/m.test(content) || !/^结论：/m.test(content)) return undefined

  return content.slice(content.search(/^本地答案：/m)).trim()
}

function lmStudioTextResponse(
  value: string,
  model: string,
): Response & LmStudioChatResponse {
  return Object.assign(new Response(null), {
    model,
    message: { content: value },
    done: true,
    prompt_eval_count: 0,
    eval_count: estimateTokens(value),
  }) as Response & LmStudioChatResponse
}

async function callLmStudioChatCompletions(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
  signal: AbortSignal,
): Promise<Response & LmStudioChatResponse> {
  const route = await selectLmStudioModel(params, messages, signal)
  const body: OpenAIChatRequest = {
    model: route.model,
    messages: toOpenAIMessages(messages),
    stream: false,
  }

  const tools = shouldSendLmStudioTools(params, messages)
    ? toLmStudioTools(params)
    : undefined
  if (tools?.length) body.tools = tools

  const format = toLmStudioFormat(
    (params as BetaMessageStreamParams & { output_config?: unknown })
      .output_config,
  )
  if (format) body.response_format = toOpenAIResponseFormat(format)

  const explicitMaxTokens = process.env.LMSTUDIO_MAX_TOKENS
    ? parseInt(process.env.LMSTUDIO_MAX_TOKENS, 10)
    : process.env.LMSTUDIO_NUM_PREDICT
      ? parseInt(process.env.LMSTUDIO_NUM_PREDICT, 10)
      : undefined
  if (Number.isFinite(explicitMaxTokens)) {
    body.max_tokens = explicitMaxTokens
  } else if (process.env.WINDRISE === '1') {
    body.max_tokens = 2048
  } else if (params.max_tokens !== undefined) {
    body.max_tokens = params.max_tokens
  }
  if (params.temperature !== undefined) {
    body.temperature = params.temperature
  } else if (process.env.WINDRISE === '1') {
    body.temperature = 0.3
  }
  if (process.env.WINDRISE !== '1' && params.stop_sequences?.length) {
    body.stop = params.stop_sequences
  }

  const baseUrl = getLmStudioBaseUrl()
  assertOnlineOrLoopbackUrl('LmStudio provider', baseUrl)
  if (process.env.LMSTUDIO_DEBUG_REQUEST === '1') {
    process.stderr.write(
      `[lmstudio-debug] ${JSON.stringify({
        model: body.model,
        route: route.decision,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        tools: body.tools?.map(tool => tool.function.name) ?? [],
        messages: body.messages.map(message => ({
          role: message.role,
          content: message.content.slice(0, 500),
        })),
      })}\n`,
    )
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `LM Studio request failed: ${response.status} ${await response.text()}`,
    )
  }

  const data = (await response.json()) as OpenAIChatResponse
  return openAIResponseToLmStudioResponse(data, body.model)
}

function shouldUseLmStudioStreaming(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
): boolean {
  if (process.env.LMSTUDIO_STREAM === '0') return false
  if (shouldSendLmStudioTools(params, messages)) return false
  if (
    toLmStudioFormat(
      (params as BetaMessageStreamParams & { output_config?: unknown })
        .output_config,
    )
  ) {
    return false
  }
  return true
}

async function* streamLmStudioChatCompletions(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const route = await selectLmStudioModel(params, messages, signal)
  const body: OpenAIChatRequest = {
    model: route.model,
    messages: toOpenAIMessages(messages),
    stream: true,
  }

  const explicitMaxTokens = process.env.LMSTUDIO_MAX_TOKENS
    ? parseInt(process.env.LMSTUDIO_MAX_TOKENS, 10)
    : process.env.LMSTUDIO_NUM_PREDICT
      ? parseInt(process.env.LMSTUDIO_NUM_PREDICT, 10)
      : undefined
  if (Number.isFinite(explicitMaxTokens)) {
    body.max_tokens = explicitMaxTokens
  } else if (process.env.WINDRISE === '1') {
    body.max_tokens = 2048
  } else if (params.max_tokens !== undefined) {
    body.max_tokens = params.max_tokens
  }
  if (params.temperature !== undefined) {
    body.temperature = params.temperature
  } else if (process.env.WINDRISE === '1') {
    body.temperature = 0.3
  }
  if (process.env.WINDRISE !== '1' && params.stop_sequences?.length) {
    body.stop = params.stop_sequences
  }

  const baseUrl = getLmStudioBaseUrl()
  assertOnlineOrLoopbackUrl('LmStudio provider', baseUrl)
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `LM Studio streaming request failed: ${response.status} ${await response.text()}`,
    )
  }
  if (!response.body) return

  yield* parseOpenAIChatSse(response.body)
}

async function* parseOpenAIChatSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const delta = parseOpenAIChatSsePart(part)
        if (delta === undefined) continue
        yield delta
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const delta = parseOpenAIChatSsePart(buffer)
      if (delta !== undefined) yield delta
    }
  } finally {
    reader.releaseLock()
  }
}

function parseOpenAIChatSsePart(part: string): string | undefined {
  const payload = part
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()
  if (!payload || payload === '[DONE]') return undefined
  const chunk = JSON.parse(payload) as OpenAIChatStreamChunk
  return chunk.choices?.map(choice => choice.delta?.content ?? '').join('') ?? ''
}

function toOpenAIMessages(messages: LmStudioMessage[]): OpenAIMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length
      ? {
          tool_calls: message.tool_calls.map(toolCall => ({
            id: toolCall.id || createAnthropicToolUseId(),
            type: 'function' as const,
            function: {
              name: toolCall.function.name,
              arguments: JSON.stringify(toolCall.function.arguments ?? {}),
            },
          })),
        }
      : {}),
  }))
}

function toOpenAIResponseFormat(
  format: 'json' | Record<string, unknown>,
): NonNullable<OpenAIChatRequest['response_format']> {
  if (format === 'json') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'response',
      schema: format,
    },
  }
}

function openAIResponseToLmStudioResponse(
  data: OpenAIChatResponse,
  model?: string,
): Response & LmStudioChatResponse {
  const message = data.choices?.[0]?.message
  return {
    model,
    message: {
      content: message?.content ?? '',
      tool_calls: message?.tool_calls?.map(toolCall => ({
        id: toolCall.id,
        function: {
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments,
        },
      })),
    },
    done: true,
    prompt_eval_count: data.usage?.prompt_tokens,
    eval_count: data.usage?.completion_tokens,
  } as Response & LmStudioChatResponse
}

async function toLmStudioMessages(
  params: BetaMessageStreamParams,
): Promise<LmStudioMessage[]> {
  const messages: LmStudioMessage[] = []
  const forcedToolName = getForcedToolName(
    (params as BetaMessageStreamParams & { tool_choice?: unknown }).tool_choice,
  )
  const system = appendForcedToolInstruction(
    contentToText(params.system),
    forcedToolName,
  )
  if (system) messages.push({ role: 'system', content: system })

  const windriseRetrieval = await maybeCreateWindriseRetrievalContext(
    params.messages as BetaMessageParam[],
  )
  const inputMessages = params.messages as BetaMessageParam[]
  const lastUserIndex = windriseRetrieval
    ? findLastUserMessageIndex(inputMessages)
    : -1

  const toolUseNamesById = new Map<string, string>()
  for (const [index, message] of inputMessages.entries()) {
    rememberToolUseNames(message.content, toolUseNamesById)
    const toolResults = contentToLmStudioToolResults(
      message.content,
      toolUseNamesById,
    )
    const content = stripClaudeSystemReminders(contentToText(message.content))
    const retrievalSuffix =
      process.env.WINDRISE === '1' && index === lastUserIndex
        ? windriseRetrieval?.context ?? ''
        : ''
    const baseMessage: LmStudioMessage = {
      role: message.role,
      content: retrievalSuffix ? `${content}\n\n${retrievalSuffix}` : content,
      ...(message.role === 'assistant'
        ? { tool_calls: contentToLmStudioToolCalls(message.content) }
        : {}),
    }
    if (baseMessage.content || baseMessage.tool_calls?.length) {
      messages.push(baseMessage)
    }
    messages.push(...toolResults)
  }

  return messages
}

function appendForcedToolInstruction(
  system: string,
  forcedToolName: string | undefined,
): string {
  const baseSystem = process.env.WINDRISE === '1' ? getWindriseSystemPrompt() : system
  if (!forcedToolName) return baseSystem
  const instruction = `You must call the "${forcedToolName}" tool. Do not answer directly before calling it.`
  return baseSystem ? `${baseSystem}\n\n${instruction}` : instruction
}

function stripClaudeSystemReminders(value: string): string {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .trim()
}

function getWindriseSystemPrompt(): string {
  const llmWikiInstruction =
    process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1'
      ? '不要自动检索 LLMWiki；只有用户明确使用 /llmwiki 命令或上下文已经包含 LLMWiki 检索结果时，才基于 LLMWiki 回答。'
      : '当用户明确输入 /llmwiki、询问故障码/报警码、或问题明显涉及具体风机故障、报警、复位、处理、排查时，根据本地 LLMWiki 检索上下文回答。'
  return [
    '你是 Windrise，本地中文对话助手，由本机模型服务提供推理。',
    '默认使用中文完整回答，回答应自然、完整，不要只输出半句话、单个词或不完整英文。',
    '不要自称 Claude，不要提 Anthropic 或 Claude Code。',
    llmWikiInstruction,
    '当用户咨询工作原理、机理、组成、作用、控制逻辑、运行逻辑等概念问题，且没有明确故障码或现场处置意图时，按普通原理咨询回答，不要自动检索。',
    '如果上下文中包含 LLMWiki 检索结果，必须基于检索结果回答，保留关键故障码、名称、原因、处理方法和来源路径；不要编造检索结果中没有的信息。',
  ].join('\n')
}

type WindriseRetrievalContext = {
  query: string
  context: string
}

type LmStudioModelRoute = {
  model: string
  decision: 'coder' | 'chat'
}

async function maybeCreateWindriseRetrievalContext(
  messages: BetaMessageParam[],
): Promise<WindriseRetrievalContext | undefined> {
  if (process.env.WINDRISE !== '1') return undefined
  const lastUserMessage = [...messages].reverse().find(message => message.role === 'user')
  const text = stripClaudeSystemReminders(
    contentToText(lastUserMessage?.content),
  ).trim()
  if (shouldAnswerWindFarmModelQuestion(text)) {
    const context = createWindFarmModelContext(text)
    if (context) return { query: text, context }
  }
  if (shouldCreateWindriseWeatherContext(text)) {
    const context = await createWindriseWeatherContext(text)
    return { query: text, context }
  }

  const retrieval = getWindriseRetrievalRequest(text)
  if (!retrieval.shouldRetrieve && shouldCreateWindriseProjectOverview(text)) {
    const context = await createWindriseProjectOverviewContext()
    return { query: text, context }
  }

  if (!retrieval.shouldRetrieve) return undefined

  const query = retrieval.query
  if (!query) {
    return {
      query,
      context:
        '<LLMWiki检索>\n用户的问题看起来需要检索本地知识库，但缺少明确的故障码或关键词。请让用户补充要检索的故障码、故障名称或设备关键词。\n</LLMWiki检索>',
    }
  }

  const hits = await runWindriseLlmWikiSearch(query)
  return {
    query,
    context: [
      '<LLMWiki检索>',
      `检索词：${query}`,
      '下面是本地 LLMWiki 检索结果，是本次故障知识回答的唯一事实来源。',
      '回答时先给结论，再给处理建议，并引用来源路径。',
      '回答最后必须包含一行“来源：...”，来源只能使用检索结果里的来源路径。',
      '不要把相似故障、其它机型或模型常识当作本条记录；检索结果没有的信息请明确说未提供。',
      hits || 'No matches.',
      '</LLMWiki检索>',
    ].join('\n'),
  }
}

function shouldCreateWindriseWeatherContext(text: string): boolean {
  return /(天气|气温|降雨|下雨|空气质量|aqi|预报)/i.test(text)
}

async function createWindriseWeatherContext(text: string): Promise<string> {
  try {
    const location = extractWindriseWeatherLocation(text)
    const offset = getWindriseWeatherDayOffset(text)
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`
    const geo = await fetchJsonWithTimeout(geoUrl)
    const place = Array.isArray(geo.results) ? geo.results[0] : undefined
    if (!place || typeof place !== 'object') {
      return [
        '<天气查询>',
        `用户问题：${text}`,
        `未找到地点：${location}`,
        '请告诉用户无法识别地点，并让用户补充城市名称。',
        '</天气查询>',
      ].join('\n')
    }

    const typedPlace = place as Record<string, unknown>
    const latitude = typedPlace.latitude
    const longitude = typedPlace.longitude
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      throw new Error('Weather geocoding result is missing coordinates')
    }

    const timezone =
      typeof typedPlace.timezone === 'string'
        ? typedPlace.timezone
        : 'Asia/Shanghai'
    const days = Math.max(3, offset + 1)
    const forecastUrl =
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
      `&timezone=${encodeURIComponent(timezone)}&forecast_days=${days}`
    const forecast = await fetchJsonWithTimeout(forecastUrl)
    const daily =
      forecast.daily && typeof forecast.daily === 'object'
        ? (forecast.daily as Record<string, unknown>)
        : {}
    const time = Array.isArray(daily.time) ? daily.time : []
    const maxTemps = Array.isArray(daily.temperature_2m_max)
      ? daily.temperature_2m_max
      : []
    const minTemps = Array.isArray(daily.temperature_2m_min)
      ? daily.temperature_2m_min
      : []
    const rain = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max
      : []
    const codes = Array.isArray(daily.weather_code) ? daily.weather_code : []
    const index = Math.min(offset, Math.max(0, time.length - 1))
    const dayLabel = offset === 1 ? '明天' : offset === 2 ? '后天' : '今天'
    const name = String(typedPlace.name ?? location)
    const admin = typedPlace.admin1 ? `（${String(typedPlace.admin1)}）` : ''

    return [
      '<天气查询>',
      `用户问题：${text}`,
      `地点：${name}${admin}`,
      `日期：${String(time[index] ?? '')}`,
      `相对日期：${dayLabel}`,
      `天气：${weatherCodeToChinese(Number(codes[index]))}`,
      `最低气温：${String(minTemps[index] ?? '未知')}°C`,
      `最高气温：${String(maxTemps[index] ?? '未知')}°C`,
      `最高降水概率：${String(rain[index] ?? '未知')}%`,
      '来源：Open-Meteo',
      '请基于这些天气数据直接回答用户，不要说无法访问实时天气。',
      '</天气查询>',
    ].join('\n')
  } catch (error) {
    return [
      '<天气查询>',
      `用户问题：${text}`,
      `天气查询失败：${error instanceof Error ? error.message : String(error)}`,
      '请说明天气查询暂时失败，并建议用户稍后重试或提供更明确的城市名。',
      '</天气查询>',
    ].join('\n')
  }
}

function extractWindriseWeatherLocation(text: string): string {
  const normalized = text
    .replace(/^\s*(帮我|给我|请)?\s*(搜索一下|搜一下|搜索|查询|查一下|查|联网|weather)\s*/i, '')
    .replace(/(今天|明天|后天|天气|气温|降雨|下雨|空气质量|aqi|预报|的|怎么样|如何|多少|一下|[？?。!！,，])/gi, ' ')
    .trim()
  return normalized || '北京'
}

function getWindriseWeatherDayOffset(text: string): number {
  if (/后天/.test(text)) return 2
  if (/明天|tomorrow/i.test(text)) return 1
  return 0
}

function weatherCodeToChinese(code: number): string {
  const map: Record<number, string> = {
    0: '晴',
    1: '大部晴朗',
    2: '局部多云',
    3: '阴',
    45: '雾',
    48: '霜雾',
    51: '小毛毛雨',
    53: '中等毛毛雨',
    55: '大毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    80: '小阵雨',
    81: '中等阵雨',
    82: '强阵雨',
    95: '雷暴',
  }
  return map[code] || `天气代码 ${code}`
}

async function fetchJsonWithTimeout(url: string): Promise<Record<string, unknown>> {
  if (process.env.WINDRISE_ENABLE_NETWORK === '0') {
    throw new Error('Windrise network access is disabled')
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return (await response.json()) as Record<string, unknown>
}

function shouldCreateWindriseProjectOverview(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false

  return /(这个|当前|本|这)?\s*(项目|目录|文件夹|仓库).*(做了什么|是什么|干什么|有什么|内容|概览|介绍|总结|说明|分析)|((做了什么|是什么|干什么|有什么|内容|概览|介绍|总结|说明|分析).*(这个|当前|本|这)?\s*(项目|目录|文件夹|仓库))|读.*(项目|目录|文件夹|仓库)/i.test(
    normalized,
  )
}

async function createWindriseProjectOverviewContext(): Promise<string> {
  const cwd = getCwd()
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    const visibleEntries = entries
      .filter(entry => !entry.name.startsWith('.'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      })
      .slice(0, 80)

    const fileLines: string[] = []
    const previewFiles: string[] = []

    for (const entry of visibleEntries) {
      const path = join(cwd, entry.name)
      let size = ''
      try {
        const info = await stat(path)
        size = entry.isFile() ? ` (${formatBytes(info.size)})` : ''
      } catch {
        size = ''
      }

      fileLines.push(`${entry.isDirectory() ? '目录' : '文件'}: ${entry.name}${size}`)
      if (entry.isFile() && shouldPreviewProjectFile(entry.name)) {
        previewFiles.push(entry.name)
      }
    }

    const previews = await Promise.all(
      previewFiles.slice(0, 6).map(name => previewProjectFile(cwd, name)),
    )

    return [
      '<项目目录摘要>',
      `当前目录：${cwd}`,
      `目录名：${basename(cwd)}`,
      '下面是当前目录的文件清单和少量文本预览。请基于这些信息回答这个项目/目录大概做了什么；不要声称已经读取二进制 Excel/PDF 的内部内容，除非预览里确实包含其文本。',
      '',
      '文件清单：',
      fileLines.length ? fileLines.join('\n') : '(当前目录没有可见文件)',
      previews.filter(Boolean).length ? '\n文本预览：' : '',
      ...previews.filter(Boolean),
      '</项目目录摘要>',
    ]
      .filter(Boolean)
      .join('\n')
  } catch (error) {
    return [
      '<项目目录摘要>',
      `当前目录：${cwd}`,
      `读取当前目录失败：${error instanceof Error ? error.message : String(error)}`,
      '请告诉用户无法读取目录，并建议检查路径或权限。',
      '</项目目录摘要>',
    ].join('\n')
  }
}

function shouldPreviewProjectFile(name: string): boolean {
  return [
    '.csv',
    '.json',
    '.jsonl',
    '.log',
    '.md',
    '.mjs',
    '.js',
    '.ts',
    '.tsx',
    '.py',
    '.txt',
    '.yaml',
    '.yml',
  ].includes(extname(name).toLowerCase())
}

async function previewProjectFile(cwd: string, name: string): Promise<string> {
  try {
    const content = await readFile(join(cwd, name), 'utf8')
    const preview = content
      .replace(/\u0000/g, '')
      .split(/\r?\n/)
      .slice(0, 30)
      .join('\n')
      .slice(0, 1600)
      .trim()
    if (!preview) return ''
    return [`--- ${name} ---`, preview].join('\n')
  } catch {
    return ''
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type WindriseRetrievalRequest = {
  shouldRetrieve: boolean
  query: string
}

function getWindriseRetrievalRequest(text: string): WindriseRetrievalRequest {
  const explicitLlmWikiQuery = parseExplicitWindriseLlmWikiRequest(text)
  if (explicitLlmWikiQuery !== undefined) {
    return {
      shouldRetrieve: true,
      query: explicitLlmWikiQuery,
    }
  }

  if (process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1') {
    return { shouldRetrieve: false, query: '' }
  }

  if (shouldWindriseRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: trimWindriseRetrievalTrigger(text),
    }
  }

  if (shouldAutoRetrieveFromLlmWiki(text)) {
    return {
      shouldRetrieve: true,
      query: normalizeWindriseRetrievalQuery(text),
    }
  }

  return { shouldRetrieve: false, query: '' }
}

function parseExplicitWindriseLlmWikiRequest(text: string): string | undefined {
  const match = text.match(/^\/?(?:llmwiki|wiki)\b\s*(.*)$/i)
  if (!match) return undefined
  return match[1]?.trim() || ''
}

function shouldWindriseRetrieve(text: string): boolean {
  if (isWindrisePrincipleConsultation(text) && !hasWindriseFaultKnowledgeSignal(text)) {
    return false
  }
  return /^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)(\s|一下|下|[:：]|$)/i.test(
    text,
  )
}

function trimWindriseRetrievalTrigger(text: string): string {
  return text
    .replace(
      /^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)\s*(一下|下)?[:：]?\s*/i,
      '',
    )
    .trim()
}

function shouldAutoRetrieveFromLlmWiki(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (
    isWindrisePrincipleConsultation(normalized) &&
    !hasWindriseFaultKnowledgeSignal(normalized)
  ) {
    return false
  }

  if (/^\s*(故障码|代码|fault\s*code)?\s*[0-9]{3,}\s*([是什么啥含义原因处理复位报警故障逻辑怎么如何？?，,。.、\s]*)?$/i.test(normalized)) {
    return true
  }

  if (
    /[0-9]{3,}/.test(normalized) &&
    /(故障|报警|告警|停机|复位|原因|处理|排查|检查|维修|逻辑|怎么|如何|为什么|是什么|含义)/i.test(
      normalized,
    )
  ) {
    return true
  }

  if (/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(normalized)) {
    return true
  }

  const hasWindDomainTerm =
    /(风机|风电|变桨|偏航|风速仪|风向仪|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|24v|plc|hw2s|华仪)/i.test(
      normalized,
    )
  const hasFaultIntent =
    /(故障|报警|告警|停机|复位|不可复位|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|短路|断路|丢失|怎么|如何|为什么|是什么|啥意思|含义)/i.test(
      normalized,
    )

  return hasWindDomainTerm && hasFaultIntent
}

function isWindrisePrincipleConsultation(text: string): boolean {
  return /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|怎么工作|如何工作|为什么能|为什么会|怎样实现|怎么实现|如何实现|结构|组成|作用|用途|区别|关系|解释一下|讲一下|介绍一下|科普|控制逻辑|运行逻辑)/i.test(
    text,
  )
}

function hasWindriseFaultKnowledgeSignal(text: string): boolean {
  return (
    /[a-z]?_?[0-9]{3,}/i.test(text) ||
    /(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(text) ||
    /(怎么处理|如何处理|处理方法|处置|排查|检查|维修|复位|短路|断路|丢失|不可复位|停机|报警|告警|报错)/i.test(
      text,
    )
  )
}

function normalizeWindriseRetrievalQuery(text: string): string {
  const cleaned = text
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/[？?。!！]+$/g, '')
    .trim()
  const code = cleaned.match(/[0-9]{3,}/)?.[0]
  if (code && isBareWindriseFaultCodeQuery(cleaned, code)) return code
  return cleaned
}

function isBareWindriseFaultCodeQuery(text: string, code: string): boolean {
  const withoutCode = text
    .replace(code, '')
    .replace(/(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|为什么|的|为|是)/gi, '')
    .replace(/[？?，,。.、:：\s]/g, '')
  return withoutCode.length === 0
}

async function runWindriseLlmWikiSearch(query: string): Promise<string> {
  const code = query.match(/[0-9]{3,}/)?.[0]
  try {
    const { call } = await import('../../commands/llmwiki/llmwiki.js')
    const result = await call(
      code ? `ask ${code} --limit 4` : `search ${query} --limit 6`,
      {} as never,
    )
    if (result.type === 'text') return result.value
    return JSON.stringify(result)
  } catch (error) {
    return `LLMWiki error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function selectLmStudioModel(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
  signal: AbortSignal,
): Promise<LmStudioModelRoute> {
  if (isExplicitLmStudioModelOverride(params.model)) {
    return {
      model: params.model!,
      decision: params.model === getLmStudioChatModel() ? 'chat' : 'coder',
    }
  }

  if (process.env.LMSTUDIO_FORCE_CHAT === '1') {
    return { model: getLmStudioChatModel(), decision: 'chat' }
  }
  if (process.env.LMSTUDIO_FORCE_CODER === '1') {
    return { model: getLmStudioCoderModel(params.model), decision: 'coder' }
  }
  if (process.env.WINDRISE !== '1' || process.env.WINDRISE_MODEL_ROUTER !== '1') {
    const model = process.env.WINDRISE === '1'
      ? fallbackLmStudioModelRoute(
          [...messages]
            .reverse()
            .find(message => message.role === 'user')
            ?.content ?? '',
          params.model,
        ).model
      : resolveModel(params.model)
    return { model, decision: model === getLmStudioChatModel() ? 'chat' : 'coder' }
  }

  const text = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''

  const fallback = fallbackLmStudioModelRoute(text, params.model)
  const routerModel = getLmStudioRouterModel()
  try {
    const decision = await callLmStudioRouter(routerModel, text, signal)
    if (decision === 'coder') {
      return { model: getLmStudioCoderModel(params.model), decision }
    }
    if (decision === 'chat') {
      return { model: getLmStudioChatModel(), decision }
    }
  } catch {
    return fallback
  }

  return fallback
}

async function callLmStudioRouter(
  routerModel: string,
  text: string,
  signal: AbortSignal,
): Promise<'coder' | 'chat' | undefined> {
  const body: OpenAIChatRequest = {
    model: routerModel,
    messages: [
      {
        role: 'system',
        content:
          '你是本地模型路由器。只输出 coder 或 chat。默认输出 chat。只有用户明确要求修改/创建/删除文件、运行命令、执行测试或构建、调试报错、生成补丁、调用工具处理代码仓库时输出 coder。普通问答、解释、总结、故障知识库回答、现场处理建议、概念说明、项目概览都输出 chat。',
      },
      {
        role: 'user',
        content: `用户输入：${text}\n\n可选模型：coder=${getLmStudioCoderModel()}，chat=${getLmStudioChatModel()}\n只输出一个词：coder 或 chat。`,
      },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 4,
  }

  const baseUrl = getLmStudioBaseUrl()
  assertOnlineOrLoopbackUrl('LmStudio provider', baseUrl)
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `LM Studio router request failed: ${response.status} ${await response.text()}`,
    )
  }

  const data = (await response.json()) as OpenAIChatResponse
  const decision =
    data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? ''
  if (decision.includes('coder')) return 'coder'
  if (decision.includes('chat')) return 'chat'
  return undefined
}

function fallbackLmStudioModelRoute(
  text: string,
  requestedModel?: string,
): LmStudioModelRoute {
  if (isLmStudioCoderTask(text)) {
    return { model: getLmStudioCoderModel(requestedModel), decision: 'coder' }
  }
  return { model: getLmStudioChatModel(), decision: 'chat' }
}

function isLmStudioCoderTask(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/(^|\n)```/.test(normalized)) return true
  if (/^\s*(npm|pnpm|yarn|node|git|bash|sh|python|python3|cargo|go|make)\b/i.test(normalized)) {
    return true
  }

  const hasActionCue =
    /(\bedit\b|\bwrite\b|\brun\b|\btest\b|\bbuild\b|\bgrep\b|\bbash\b|\bnpm\b|\bgit\b|\bfix\b|\bdebug\b|修改|编辑|写入|创建|删除|运行|执行|测试|构建|修复|调试|安装|替换|重构|补丁|排错)/i.test(
      normalized,
    )
  const hasCodeContext =
    /(\bcode\b|\bfile\b|\bscript\b|\bpath\b|\brepo\b|\bproject\b|代码|文件|脚本|路径|仓库|模块|函数|类|命令|终端)/i.test(
      normalized,
    )

  return hasActionCue && hasCodeContext
}

function isExplicitLmStudioModelOverride(model?: string): boolean {
  if (!model) return false
  return model !== getLmStudioCoderModel() && model !== process.env.LMSTUDIO_MODEL
}

function findLastUserMessageIndex(messages: BetaMessageParam[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as Record<string, unknown>
      if (typed.type === 'text') return String(typed.text ?? '')
      if (typed.type === 'tool_result') {
        return contentToToolResultText(typed.content)
      }
      if (typed.type === 'tool_use') {
        return `[tool_use ${String(typed.name ?? 'tool')}: ${JSON.stringify(typed.input ?? {})}]`
      }
      if (typed.type === 'image' || typed.type === 'document') {
        return `[${typed.type} omitted: local text adapter]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function contentToLmStudioToolCalls(content: unknown): LmStudioMessage['tool_calls'] {
  if (!Array.isArray(content)) return undefined
  const toolCalls = content
    .filter(
      block =>
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_use',
    )
    .map(block => {
      const typed = block as Record<string, unknown>
      return {
        ...(typeof typed.id === 'string' ? { id: typed.id } : {}),
        function: {
          name: String(typed.name ?? ''),
          arguments: normalizeToolArguments(typed.input),
        },
      }
    })
    .filter(call => call.function.name)

  return toolCalls.length > 0 ? toolCalls : undefined
}

function rememberToolUseNames(
  content: unknown,
  toolUseNamesById: Map<string, string>,
): void {
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const typed = block as Record<string, unknown>
    if (typed.type !== 'tool_use') continue
    if (typeof typed.id !== 'string' || typeof typed.name !== 'string') {
      continue
    }
    toolUseNamesById.set(typed.id, typed.name)
  }
}

function contentToLmStudioToolResults(
  content: unknown,
  toolUseNamesById: Map<string, string>,
): LmStudioMessage[] {
  if (!Array.isArray(content)) return []
  return content
    .filter(
      block =>
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_result',
    )
    .map(block => {
      const typed = block as Record<string, unknown>
      const toolUseId =
        typeof typed.tool_use_id === 'string' ? typed.tool_use_id : undefined
      const toolName =
        toolUseId && toolUseNamesById.has(toolUseId)
          ? toolUseNamesById.get(toolUseId)!
          : String(typed.name ?? toolUseId ?? 'tool')
      return {
        role: 'tool' as const,
        name: toolName,
        tool_name: toolName,
        ...(toolUseId ? { tool_call_id: toolUseId } : {}),
        content: contentToToolResultText(typed.content),
      }
    })
    .filter(message => message.content)
}

function toLmStudioTools(params: BetaMessageStreamParams): LmStudioTool[] | undefined {
  if (process.env.WINDRISE_DISABLE_TOOLS === '1') return undefined
  const forcedToolName = getForcedToolName(
    (params as BetaMessageStreamParams & { tool_choice?: unknown }).tool_choice,
  )
  const tools = params.tools
  if (!tools?.length) return undefined
  const converted: LmStudioTool[] = []
  for (const tool of tools) {
    const typed = tool as BetaToolUnion & {
      input_schema?: unknown
      description?: string
      name?: string
    }
    if (forcedToolName && typed.name !== forcedToolName) continue
    if (!typed.name) continue
    converted.push({
      type: 'function',
      function: {
        name: typed.name,
        description: typed.description,
        parameters: typed.input_schema,
      },
    })
  }
  return converted
}

function getForcedToolName(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  const typed = toolChoice as Record<string, unknown>
  return typed.type === 'tool' && typeof typed.name === 'string'
    ? typed.name
    : undefined
}

function shouldSendLmStudioTools(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
): boolean {
  if (process.env.LMSTUDIO_ENABLE_TOOLS === '1') return true
  if (process.env.LMSTUDIO_ENABLE_TOOLS === '0') return false

  const forcedToolName = getForcedToolName(
    (params as BetaMessageStreamParams & { tool_choice?: unknown }).tool_choice,
  )
  if (forcedToolName) return true

  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content
  if (!lastUser) return false
  if (
    lastUser.includes('<LLMWiki检索>') ||
    lastUser.includes('<项目目录摘要>') ||
    lastUser.includes('<风场机型映射>')
  ) {
    return false
  }

  return /(\bcode\b|\bfile\b|\bedit\b|\bread\b|\bwrite\b|\brun\b|\btest\b|\bbuild\b|\bgrep\b|\bbash\b|\bnpm\b|\bgit\b|\bfix\b|\bdebug\b|代码|文件|读取|查看|修改|编辑|写入|创建|运行|执行|命令|终端|测试|构建|修复|调试|项目)/i.test(
    lastUser.toLowerCase(),
  )
}

function toLmStudioFormat(
  outputConfig: unknown,
): 'json' | Record<string, unknown> | undefined {
  if (!outputConfig || typeof outputConfig !== 'object') return undefined
  const format = (outputConfig as Record<string, unknown>).format
  if (!format || typeof format !== 'object') return undefined
  const typed = format as Record<string, unknown>
  if (typed.type !== 'json_schema') return undefined
  return typeof typed.schema === 'object' && typed.schema !== null
    ? (typed.schema as Record<string, unknown>)
    : 'json'
}

function normalizeToolArguments(input: unknown): Record<string, unknown> {
  if (!input) return {}
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input)
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function contentToToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyToolResultValue(content)

  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return stringifyToolResultValue(block)
      }
      const typed = block as Record<string, unknown>
      if (typed.type === 'text') return String(typed.text ?? '')
      if (typed.type === 'image' || typed.type === 'document') {
        return `[${typed.type} omitted: local text adapter]`
      }
      return stringifyToolResultValue(typed)
    })
    .filter(Boolean)
    .join('\n\n')
}

function stringifyToolResultValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function createAnthropicToolUseId(): string {
  return `toolu_${randomUUID().replace(/-/g, '')}`
}

function resolveModel(model: string | undefined): string {
  return model || getLmStudioCoderModel()
}

function getLmStudioCoderModel(model?: string): string {
  return (
    model ||
    process.env.LMSTUDIO_CODER_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    DEFAULT_LMSTUDIO_MODEL
  )
}

function getLmStudioChatModel(): string {
  return process.env.LMSTUDIO_CHAT_MODEL || DEFAULT_LMSTUDIO_CHAT_MODEL
}

function getLmStudioRouterModel(): string {
  return (
    process.env.LMSTUDIO_ROUTER_MODEL ||
    process.env.WINDRISE_ROUTER_MODEL ||
    getLmStudioCoderModel()
  )
}

function getLmStudioBaseUrl(): string {
  return (process.env.LMSTUDIO_BASE_URL || DEFAULT_LMSTUDIO_BASE_URL).replace(
    /\/$/,
    '',
  )
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

function estimateRequestTokens(params: {
  messages?: BetaMessageParam[]
  tools?: BetaToolUnion[]
  system?: BetaMessageStreamParams['system']
}): number {
  let total = estimateTokens(contentToText(params.system))
  for (const message of params.messages ?? []) {
    total += estimateTokens(contentToText(message.content))
  }
  if (params.tools?.length) {
    total += estimateTokens(JSON.stringify(params.tools))
  }
  return Math.max(0, total)
}

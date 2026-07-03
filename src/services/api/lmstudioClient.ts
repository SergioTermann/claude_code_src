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

const WIND_DOMAIN_PATTERN =
  /(风机|风电|机组|变桨|偏航|主控|变流|变频|发电机|齿轮箱|液压|制动|刹车|安全链|电网|箱变|变压器|通信|通讯|水冷|冷却|传动|主轴|主轴承|叶片|轮毂|塔筒|机舱|传感器|风速仪|风向仪|振动|温度|润滑|油脂|SCADA|HMI|PLC|24v|hw2s|华仪)/i

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
  think?: boolean
  enable_thinking?: boolean
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | string
  reasoning?: {
    effort?: 'none' | 'low' | 'medium' | 'high' | string
    exclude?: boolean
  }
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

const DEFAULT_LMSTUDIO_BASE_URL = 'http://10.46.161.210:9527'
const DEFAULT_LMSTUDIO_MODEL = 'Qwen-30B'
const DEFAULT_LMSTUDIO_CHAT_MODEL = 'Qwen-30B'
const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'
const DEFAULT_SILICONFLOW_MODEL = 'Qwen/Qwen3.6-35B-A3B'

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
    const directAnswer = directLocalMetaAnswer(params, messages)
    if (directAnswer) return lmStudioTextResponse(directAnswer, selectLmStudioModel(params))
    return await callLmStudioChatCompletions(params, messages, controller.signal)
  } finally {
    clearTimeout(timeout)
  }
}

function directLocalMetaAnswer(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
): string {
  const model = selectLmStudioModel(params)
  const dateAnswer = localDateTimeAnswer(lastUserMessageText(messages))
  if (dateAnswer) return dateAnswer
  if (isOkHealthCheckQuestion(messages)) return 'OK'
  if (isLocalModelIdentityQuestion(messages)) return localModelIdentityAnswer(model)
  return ''
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
  const model = selectLmStudioModel(params)
  const body: OpenAIChatRequest = {
    model,
    messages: toOpenAIMessages(messages),
    stream: false,
  }
  applyNoThinkingOptions(body)

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
  if (getAPIProvider() !== 'siliconflow') {
    assertOnlineOrLoopbackUrl('LmStudio provider', baseUrl)
  }
  if (process.env.LMSTUDIO_DEBUG_REQUEST === '1') {
    process.stderr.write(
      `[lmstudio-debug] ${JSON.stringify({
        model: body.model,
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        thinking: body.think === false ? 'disabled' : 'default',
        tools: body.tools?.map(tool => tool.function.name) ?? [],
        messages: body.messages.map(message => ({
          role: message.role,
          content: message.content.slice(0, 500),
        })),
      })}\n`,
    )
  }

  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOpenAICompatibleApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `vLLM request failed: ${response.status} ${await response.text()}`,
    )
  }

  const data = (await response.json()) as OpenAIChatResponse
  const result = openAIResponseToLmStudioResponse(data, body.model)
  if (!result.message?.content && isLocalModelIdentityQuestion(messages)) {
    result.message = {
      ...result.message,
      content: localModelIdentityAnswer(body.model),
    }
  } else if (!result.message?.content && isOkHealthCheckQuestion(messages)) {
    result.message = {
      ...result.message,
      content: 'OK',
    }
  } else if (!result.message?.content && isWindrisePrincipleQuestion(messages)) {
    result.message = {
      ...result.message,
      content: windrisePrincipleFallback(messages),
    }
  } else if (!result.message?.content) {
    const windFarmAnswer = windFarmMappingFallback(messages)
    const retrievalAnswer = windriseRetrievalFallback(messages)
    if (windFarmAnswer || retrievalAnswer) {
      result.message = {
        ...result.message,
        content: windFarmAnswer || retrievalAnswer,
      }
    }
  }
  if (result.message?.content) {
    const retrievalAnswer = windriseRetrievalFallback(messages)
    const normalizedContent = normalizeWindriseSourceLabel(result.message.content)
    result.message = {
      ...result.message,
      content:
        retrievalAnswer && !hasCompleteWindriseRetrievalAnswer(normalizedContent)
          ? retrievalAnswer
          : normalizedContent,
    }
  }
  return result
}

function shouldUseLmStudioStreaming(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
): boolean {
  if (process.env.WINDRISE === '1') return false
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

function applyNoThinkingOptions(body: OpenAIChatRequest): void {
  if (process.env.WINDRISE_ENABLE_THINKING === '1') return
  body.think = false
  body.enable_thinking = false
  body.reasoning_effort = 'none'
  body.reasoning = { effort: 'none', exclude: true }
}

function isLocalModelIdentityQuestion(messages: LmStudioMessage[]): boolean {
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
  return /(你是什么模型|你是谁|什么模型|当前模型|本地模型|model)/i.test(lastUser)
}

function isOkHealthCheckQuestion(messages: LmStudioMessage[]): boolean {
  return /^\s*(只回答|仅回答|回复|输出)?\s*OK\s*$/i.test(
    lastUserMessageText(messages),
  )
}

function localModelIdentityAnswer(model: string): string {
  return `我是 Windrise，本地中文助手；当前通过 vLLM 使用 ${model}。`
}

function localDateTimeAnswer(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  if (/(风机|风电|故障|报警|告警|停机|复位|处理|排查|维修|变桨|偏航|主控|变流|发电机|齿轮箱)/i.test(normalized)) {
    return ''
  }
  const now = new Date()
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now)
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)
  if (/^(今天)?(是)?(什么日子|几号|日期|星期几|周几)[？?。!！\s]*$/.test(normalized) || /(今天是什么日子|今天几号|今天日期|今天星期几|今天周几)/.test(normalized)) {
    return `今天是 ${date}。`
  }
  if (/^(现在|当前)?(几点|什么时间|时间)[？?。!！\s]*$/.test(normalized) || /(现在几点|当前时间|现在时间)/.test(normalized)) {
    return `现在是 ${date} ${time}。`
  }
  return ''
}

function isWindrisePrincipleQuestion(messages: LmStudioMessage[]): boolean {
  const text = lastUserMessageText(messages)
  return (
    WIND_DOMAIN_PATTERN.test(text) &&
    /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|为什么|怎么工作|如何工作|是什么)/i.test(text)
  )
}

function windrisePrincipleFallback(messages: LmStudioMessage[]): string {
  const text = lastUserMessageText(messages)
  if (/变桨/.test(text)) {
    return [
      '变桨系统通过调节叶片桨距角来控制风轮吸收的气动功率和载荷。',
      '低风速时，叶片通常保持较小桨距角以提高捕风效率；接近或超过额定风速时，控制器驱动变桨电机或液压执行机构增大桨距角，使叶片逐步失速或减小迎角，从而限制输出功率。',
      '同时，变桨系统还参与超速保护、停机和紧急顺桨：当检测到超速、故障或安全链动作时，叶片会向安全角度顺桨，降低风轮扭矩和结构载荷。',
    ].join('\n')
  }
  return [
    '这个系统的核心逻辑是采集现场状态，经过控制器判断后驱动执行机构动作，使风机在安全边界内稳定运行。',
    '回答这类原理问题时，需要结合具体品牌、机型和控制策略；如果要给现场处置建议，还需要补充风场、机型、报警码和实时状态。',
  ].join('\n')
}

function lastUserMessageText(messages: LmStudioMessage[]): string {
  return [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
}

function windFarmMappingFallback(messages: LmStudioMessage[]): string {
  const text = lastUserMessageText(messages)
  const mapping = text.match(/<风场机型映射>\n([\s\S]*?)\n<\/风场机型映射>/)
  const content = mapping?.[1]?.trim()
  if (!content) return ''
  return content
    .split(/\r?\n/)
    .filter(line => !line.startsWith('下面是系统内置的风场与风机型号对应关系'))
    .join('\n')
    .trim()
}

function windriseRetrievalFallback(messages: LmStudioMessage[]): string {
  const text = lastUserMessageText(messages)
  const retrieval = text.match(/<LLMWiki检索>\n([\s\S]*?)\n<\/LLMWiki检索>/)
  const content = retrieval?.[1]?.trim()
  if (!content || content.includes('No matches.')) return ''
  const structuredAnswerIndex = content.search(/^本地答案：/m)
  if (structuredAnswerIndex >= 0) {
    return content.slice(structuredAnswerIndex).trim()
  }
  return ''
}

function normalizeWindriseSourceLabel(value: string): string {
  return value.replace(/来源路径[:：]/g, '来源：')
}

function hasCompleteWindriseRetrievalAnswer(value: string): boolean {
  return /来源[:：]/.test(value) && /(处理方法|处理建议|检查|手动|复位)/.test(value)
}

async function* streamLmStudioChatCompletions(
  params: BetaMessageStreamParams,
  messages: LmStudioMessage[],
  signal: AbortSignal,
): AsyncGenerator<string> {
  const model = selectLmStudioModel(params)
  const body: OpenAIChatRequest = {
    model,
    messages: toOpenAIMessages(messages),
    stream: true,
  }
  applyNoThinkingOptions(body)

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
  if (getAPIProvider() !== 'siliconflow') {
    assertOnlineOrLoopbackUrl('LmStudio provider', baseUrl)
  }
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOpenAICompatibleApiKey()}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `vLLM streaming request failed: ${response.status} ${await response.text()}`,
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
  const content = message?.content ?? ''
  const reasoningContent = (message as { reasoning_content?: string | null } | undefined)
    ?.reasoning_content?.trim() ?? ''
  return {
    model,
    message: {
      content:
        content ||
        (reasoningContent && !looksLikeInternalLmStudioReasoning(reasoningContent)
          ? reasoningContent
          : ''),
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

function looksLikeInternalLmStudioReasoning(value: string): boolean {
  return /Thinking Process|We need answer|我们需要|用户问/.test(value.slice(0, 300))
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
    const messageContent = retrievalSuffix
      ? [
          retrievalSuffix,
          '',
          `用户问题：${content}`,
          '请直接回答用户问题，不要原样复述上面的资料。',
        ].join('\n')
      : content
    const baseMessage: LmStudioMessage = {
      role: message.role,
      content: messageContent,
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
      ? '只有用户消息明确附带本地资料时才基于资料回答。'
      : '有 LLMWiki、本地资料、风场机型、天气或项目上下文时基于资料回答；否则直接回答。'
  return [
    '你是 Windrise，本地中文助手。直接回答用户问题，不输出推理过程。',
    llmWikiInstruction,
    '资料不足时说明缺口和下一步需要补充的信息。',
  ].join('\n')
}

type WindriseRetrievalContext = {
  query: string
  context: string
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
      '下面是本地 LLMWiki 检索到的相关资料。请结合用户问题组织成可执行的中文回答；涉及故障处理时保留关键故障码、名称、原因、处理方法和来源路径。',
      '如果检索结果不足以确认结论，请明确说明需要补充的风场、品牌、机型、故障码或现场现象。',
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

  const hasWindDomainTerm = WIND_DOMAIN_PATTERN.test(normalized)
  const hasKnowledgeIntent =
    /(故障|报警|告警|停机|复位|不可复位|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|短路|断路|丢失|原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|区别|关系|解释|介绍|怎么|如何|为什么|是什么|啥意思|含义)/i.test(
      normalized,
    )

  return hasWindDomainTerm && hasKnowledgeIntent
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
    const mechanismSummary = buildWindriseMechanismSummaryForQuery(query)
    const result = await call(
      code ? `ask ${code} --limit 4` : `search ${query} --limit 6`,
      {} as never,
    )
    const primary = result.type === 'text' ? result.value : JSON.stringify(result)
    const systemPath = systemWikiPathForWindriseQuery(query)
    const mechanismContext =
      shouldAttachWindriseMechanismContext(query) && !code
        ? await readWindriseLlmWikiFile(call, 'wiki/fault-mechanisms.md')
        : ''
    if (!systemPath || code) {
      return [
        mechanismSummary,
        mechanismContext && !/^LLMWiki error:/i.test(mechanismContext)
          ? [`机理图谱上下文：wiki/fault-mechanisms.md`, mechanismContext, ''].join('\n')
          : '',
        primary,
      ].filter(Boolean).join('\n')
    }

    const systemContext = await readWindriseLlmWikiFile(call, systemPath)
    const contexts: string[] = []
    if (mechanismContext && !/^LLMWiki error:/i.test(mechanismContext)) {
      contexts.push(`机理图谱上下文：wiki/fault-mechanisms.md`, mechanismContext, '')
    }
    if (!systemContext || /^LLMWiki error:/i.test(systemContext)) {
      return [mechanismSummary, ...(contexts.length ? contexts : []), primary]
        .filter(Boolean)
        .join('\n')
    }
    contexts.push(
      `系统上下文：${systemPath}`,
      systemContext,
      '',
      primary,
    )
    return [mechanismSummary, contexts.join('\n')].filter(Boolean).join('\n')
  } catch (error) {
    return `LLMWiki error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function readWindriseLlmWikiFile(
  call: (command: string, options: never) => Promise<{ type: string; value?: string }>,
  path: string,
): Promise<string> {
  const result = await call(`read ${path}`, {} as never)
  return result.type === 'text' ? String(result.value || '') : JSON.stringify(result)
}

function shouldAttachWindriseMechanismContext(text: string): boolean {
  return (
    WIND_DOMAIN_PATTERN.test(text) &&
    /(故障|报警|告警|停机|复位|原因|处理|排查|检查|维修|下一步|原理|机理|机制|为什么|怎么|如何|是什么|跳变|掉线|压力|温度|振动|通信|通讯|水冷|传感器|SCADA|HMI)/i.test(
      text,
    )
  )
}

function buildWindriseMechanismSummaryForQuery(text: string): string {
  const matches = genericWindriseMechanismRules()
    .filter(rule => rule.pattern.test(text))
    .slice(0, 3)
  if (!matches.length) return ''
  return [
    '通用机理图谱命中：',
    ...matches.map(rule =>
      [
        `- 机理：${rule.label}`,
        `  系统/部件：${rule.system} / ${rule.component}`,
        `  最可能下一步：${rule.nextAction}`,
        `  需要反馈：${rule.feedback}`,
      ].join('\n'),
    ),
    '使用要求：即使没有精确故障码，也先按上述通用机理给一个现场验证动作，不要只回答资料不足。',
    '',
  ].join('\n')
}

function genericWindriseMechanismRules(): Array<{
  pattern: RegExp
  label: string
  system: string
  component: string
  nextAction: string
  feedback: string
}> {
  return [
    {
      pattern: /传感器|测量.*跳变|跳变|漂移|风速仪|风向仪|压力传感器|温度传感器|振动传感器/i,
      label: '传感器测量回路漂移、断线或干扰',
      system: '传感器/主控系统',
      component: '传感器供电、线缆、屏蔽接地、AI/DI通道',
      nextAction: '用独立仪表或相邻测点先做交叉比对，确认是真实物理量变化还是测量回路异常。',
      feedback: '现场实测值、SCADA/HMI显示值、传感器供电或回路电阻。',
    },
    {
      pattern: /水冷|冷却液|水泵|换热器|进阀压力|流量.*低|水压|冷却.*压力/i,
      label: '水冷回路流量、压力或散热能力不足',
      system: '水冷系统',
      component: '水泵、换热器、冷却液、流量/压力开关',
      nextAction: '先确认水泵运行反馈和冷却液液位，不要先改参数。',
      feedback: '水泵是否运行、液位是否正常、当前压力/流量值。',
    },
    {
      pattern: /通信|通讯|CAN|Profibus|EtherCAT|Modbus|光纤|交换机|掉线|超时|节点丢失/i,
      label: '机组通信网络或现场总线中断',
      system: '通信系统',
      component: '总线线缆、终端电阻、光纤、交换机、从站模块',
      nextAction: '先看掉线设备和通讯灯/总线状态，定位是单台设备掉线还是整段总线异常。',
      feedback: '掉线设备、通讯灯状态、总线错误计数。',
    },
    {
      pattern: /变桨.*24\s*V|24\s*V.*变桨|变桨.*主电源|变桨.*开关反馈|变桨.*控制电源/i,
      label: '变桨 24V 控制电源或开关反馈丢失',
      system: '变桨系统',
      component: '24V电源、主电源开关、辅助触点、PLC输入点',
      nextAction: '先量变桨 24V 控制电源输出，再核对主电源开关实际位置和 PLC 反馈。',
      feedback: '24V 实测值、主电源开关位置、辅助触点或 PLC 输入点状态。',
    },
    {
      pattern: /主轴|主轴承|轴承.*剥落|油脂.*金属|低频振动|BPFI|BPFO/i,
      label: '主轴轴承润滑、载荷或密封失效',
      system: '传动系统',
      component: '主轴轴承、密封、润滑脂',
      nextAction: '先看主轴承温度趋势和低频振动，不要只按单点告警判断。',
      feedback: '轴承温度、振动频谱或趋势、油脂状态。',
    },
    {
      pattern: /发电机.*轴承|发电机.*温度|发电机.*过热|轴承温度.*发电机/i,
      label: '发电机轴承温度、润滑或冷却异常',
      system: '发电机系统',
      component: '发电机轴承、PT100、冷却风道、润滑脂',
      nextAction: '先对齐发电机轴承温度趋势和振动趋势，再看冷却通风是否正常。',
      feedback: '发电机轴承温度趋势、振动趋势、冷却风道/风扇状态。',
    },
    {
      pattern: /齿轮箱|齿轮油|油温|滤芯|过滤器.*压差|润滑油.*压差|油冷/i,
      label: '齿轮箱温升或润滑过滤异常',
      system: '齿轮箱系统',
      component: '油冷系统、润滑油、滤芯、油位、油样',
      nextAction: '先确认油冷风扇或水冷是否运行，再看油位、滤芯压差和油样状态。',
      feedback: '油冷运行状态、齿轮箱油位、滤芯压差、油样外观。',
    },
    {
      pattern: /安全链|急停|安全继电器|保护链|塔筒门|机舱门|限位.*安全/i,
      label: '安全链或急停保护链断开',
      system: '安全链系统',
      component: '急停按钮、安全继电器、门锁、限位开关',
      nextAction: '先看急停是否复位，再从安全继电器输入端逐点找第一个断开的安全点。',
      feedback: '急停状态、安全继电器状态、第一个断开的安全点。',
    },
    {
      pattern: /雷击|浪涌|SPD|防雷|接地电阻|屏蔽接地|接地异常/i,
      label: '雷击、浪涌或接地屏蔽异常',
      system: '防雷接地/电气系统',
      component: 'SPD、24V电源、接地排、屏蔽层、通讯模块',
      nextAction: '先查 SPD 指示、24V 电源输出和电柜接地连接，判断是不是保护回路先失效。',
      feedback: 'SPD 指示状态、24V 输出、电柜接地连接、异常模块范围。',
    },
    {
      pattern: /箱变|变压器|并网|电网|频率|电压|断路器|接触器|孤岛|接地/i,
      label: '电网、箱变或并网保护异常',
      system: '电网/变压器系统',
      component: '箱变、断路器、并网接触器、电能质量',
      nextAction: '先核对三相电压频率和断路器/接触器反馈，判断是外部电网还是并网执行回路。',
      feedback: '三相电压频率、断路器反馈、伴随保护记录。',
    },
    {
      pattern: /SCADA|HMI|趋势|数据质量|伴随告警|状态量|阈值|报警关联/i,
      label: 'SCADA数据质量、报警关联或工况边界异常',
      system: '主控系统',
      component: 'SCADA采集、报警逻辑、状态量',
      nextAction: '先导出报警前后趋势和伴随告警，按时间线对齐现场动作。',
      feedback: '报警时间、前后趋势、伴随告警列表。',
    },
  ]
}

function systemWikiPathForWindriseQuery(text: string): string {
  const normalized = text.replace(/\s+/g, '')
  const aliasPath: Array<[RegExp, string]> = [
    [/箱变|变压器/, '变压器系统'],
    [/传感器|风速仪|风向仪|测量|跳变/, '主控系统'],
    [/主轴|主轴承/, '传动系统'],
    [/润滑|油脂|油位|滤芯/, '液压系统'],
    [/塔筒|机舱|振动|加速度/, '机舱与塔架系统'],
    [/冷却|水冷|换热器|水泵/, '水冷系统'],
    [/通讯|通信|CAN|Profibus|EtherCAT|光纤|交换机/i, '通信系统'],
  ]
  const alias = aliasPath.find(([pattern]) => pattern.test(normalized))
  if (alias) return `wiki/systems/${alias[1]}.md`
  const systems = [
    '变桨系统',
    '偏航系统',
    '主控系统',
    '变流系统',
    '发电机系统',
    '齿轮箱系统',
    '液压系统',
    '制动系统',
    '安全链系统',
    '电网系统',
    '通信系统',
    '水冷系统',
    '电池系统',
    '传动系统',
    '温度系统',
    '变压器系统',
    '机舱与塔架系统',
  ]
  const system = systems.find(name => normalized.includes(name.replace(/\s+/g, '')))
  return system ? `wiki/systems/${system}.md` : ''
}

function selectLmStudioModel(params: BetaMessageStreamParams): string {
  if (isExplicitLmStudioModelOverride(params.model)) {
    return params.model!
  }
  return getLmStudioChatModel()
}

function isExplicitLmStudioModelOverride(model?: string): boolean {
  if (!model) return false
  return model !== getLmStudioChatModel() && model !== process.env.LMSTUDIO_MODEL
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
  return model || getLmStudioModel()
}

function getLmStudioModel(model?: string): string {
  if (getAPIProvider() === 'siliconflow') {
    return model || process.env.SILICONFLOW_MODEL || DEFAULT_SILICONFLOW_MODEL
  }
  return (
    model ||
    process.env.LMSTUDIO_MODEL ||
    DEFAULT_LMSTUDIO_MODEL
  )
}

function getLmStudioChatModel(): string {
  if (getAPIProvider() === 'siliconflow') {
    return process.env.SILICONFLOW_MODEL || DEFAULT_SILICONFLOW_MODEL
  }
  return (
    process.env.LMSTUDIO_CHAT_MODEL ||
    process.env.LMSTUDIO_MODEL ||
    DEFAULT_LMSTUDIO_CHAT_MODEL
  )
}

function getLmStudioBaseUrl(): string {
  if (getAPIProvider() === 'siliconflow') {
    return (
      process.env.SILICONFLOW_BASE_URL || DEFAULT_SILICONFLOW_BASE_URL
    ).replace(/\/$/, '')
  }
  return (process.env.LMSTUDIO_BASE_URL || DEFAULT_LMSTUDIO_BASE_URL).replace(
    /\/$/,
    '',
  )
}

function getOpenAICompatibleApiKey(): string {
  if (getAPIProvider() === 'siliconflow') {
    return process.env.SILICONFLOW_API_KEY || process.env.OPENAI_COMPAT_API_KEY || ''
  }
  return process.env.LMSTUDIO_API_KEY || 'lm-studio'
}

function chatCompletionsUrl(baseUrl: string): string {
  return /\/v1$/i.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`
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

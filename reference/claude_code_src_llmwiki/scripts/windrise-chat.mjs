#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { stdin as input, stdout as output } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNNER = join(ROOT, 'scripts', 'run-lmstudio-claude.mjs')
const PROVIDER = 'lmstudio'
const CHAT_MODEL =
  process.env.LMSTUDIO_CHAT_MODEL ||
  process.env.LMSTUDIO_MODEL ||
  'qwen3.5-9b-coder'
const ENABLE_NETWORK = process.env.WINDRISE_ENABLE_NETWORK !== '0'
const DISABLE_AUTO_LLMWIKI = process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1'
const LOCAL_BASE_URL = (
  process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234'
).replace(/\/$/, '')
const PROVIDER_LABEL = 'LM Studio'
const BASE_WIND_FARM_MODEL_ENTRIES = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', 'windFarmModels.json'), 'utf8'),
)
const WIND_FARM_MODEL_ENTRIES = mergeWindFarmModelEntries([
  ...BASE_WIND_FARM_MODEL_ENTRIES,
  ...loadFaultIndexWindFarmModelEntries(),
])
if (process.env.WINDRISE_DEBUG_MAPPING === '1') {
  console.error(`[mapping] entries=${WIND_FARM_MODEL_ENTRIES.length}`)
}
const FAULT_CODE_PATTERN =
  /[a-z]+[a-z0-9_/-]*\d[a-z0-9_/-]*|\d+(?:[ _/-]+\d+)+|\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\d[a-z0-9_/-]*|\d{3,}/i

if (!isAllowedLocalModelUrl(LOCAL_BASE_URL)) {
  console.error(
    `Windrise: 拒绝 localhost/局域网之外的 ${PROVIDER_LABEL} 地址 ${LOCAL_BASE_URL}。`,
  )
  process.exit(1)
}

const history = [
  {
    role: 'system',
    content: DISABLE_AUTO_LLMWIKI
      ? '你是 Windrise，本地中文助手。直接回答用户问题，不输出推理过程。只有用户消息明确附带本地资料时才基于资料回答。'
      : '你是 Windrise，本地中文助手。直接回答用户问题，不输出推理过程。有本地资料上下文时基于资料回答，否则直接回答。',
  },
]
const MAX_HISTORY_MESSAGES = 17
let recentFaultContext = null

function printBanner() {
  console.log(`╭────────────────────────────────────────────╮
│ 🌀  Windrise                               │
│ ⌁⌁⌁ 对话模式 · 按需检索风机故障码知识库      │
╰────────────────────────────────────────────╯
直接输入问题后按回车即可对话。
${DISABLE_AUTO_LLMWIKI ? '自动 LLMWiki 检索已关闭；需要知识库时请输入：llmwiki 303804。' : '风电专业问题、故障码、风机报警、处理建议类问题会自动检索；也可以说：检索 303804。'}
输入 help 查看命令，输入 exit 退出。`)
}

function printHelp() {
  console.log(`命令:
  检索 <内容>       从 LLMWiki 知识库检索并总结
  查询 <内容>       同上
  搜索 <内容>       同上
  查 <内容>         同上
  llmwiki <内容>    明确从 LLMWiki 知识库检索并总结
  read <路径>       读取 LLMWiki 文件
  tree [路径]       查看目录树
  clear             清空对话上下文
  model             查看当前模型路由
  web <关键词>      联网搜索并总结
  fetch <URL>       抓取网页文本
  weather <城市>    查询天气预报
  farm <风场/机型>  查询内置风场与风机型号对应关系
  exit              退出`)
}

function getRetrievalRequest(text) {
  const explicitLlmWiki = parseExplicitLlmWikiRequest(text)
  if (explicitLlmWiki !== undefined) {
    return {
      shouldRetrieve: true,
      query: explicitLlmWiki,
    }
  }

  if (DISABLE_AUTO_LLMWIKI) {
    return { shouldRetrieve: false, query: '' }
  }

  const contextualQuery = contextualFaultFollowupQuery(text)
  if (contextualQuery) {
    return {
      shouldRetrieve: true,
      query: contextualQuery,
    }
  }

  if (shouldRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: trimTrigger(text),
    }
  }

  if (shouldAutoRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: normalizeRetrievalQuery(text),
    }
  }

  return { shouldRetrieve: false, query: '' }
}

function contextualFaultFollowupQuery(text) {
  const normalized = text.trim()
  if (!normalized || !recentFaultContext) return ''
  if (extractCode(normalized)) return ''
  if (!isFaultContextFollowup(normalized)) return ''
  return [
    recentFaultContext.code,
    recentFaultContext.site,
    recentFaultContext.brand,
    recentFaultContext.model,
    normalized,
  ]
    .filter(Boolean)
    .join(' ')
}

function isFaultContextFollowup(text) {
  if (/^(这个|那个|它|该故障|该报警|该问题|上面|前面|刚才)/.test(text)) {
    return true
  }
  return /(是什么故障码|故障码是什么|故障代码是什么|对应什么故障码|对应哪个故障码|对应什么故障|怎么处理|如何处理|处理方法|怎么修|维修|排查|为什么|为何|原因|怎么会|为啥|复位|能不能复位|故障描述|描述|对象|机型|风场|品牌|具体型号|场站|型号|厂家|系列|怎么回事|怎么了|它的故障码|这个故障码|它是什么|还要怎么做|下一步|继续)/.test(text)
}

function parseExplicitLlmWikiRequest(text) {
  const match = text.match(/^\/?(?:llmwiki|wiki)\b\s*(.*)$/i)
  if (!match) return undefined
  return match[1]?.trim() || ''
}

function trimTrigger(text) {
  return text
    .replace(/^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)\s*(一下|下)?[:：]?\s*/i, '')
    .trim()
}

function shouldRetrieve(text) {
  return /^(帮我|给我|请)?\s*(检索|查询|搜索|查找|查|search)(\s|一下|下|[:：]|$)/i.test(
    text,
  )
}

function shouldAutoRetrieve(text) {
  const normalized = text.trim()
  if (!normalized) return false
  if (isPrincipleConsultation(normalized) && !hasFaultKnowledgeSignal(normalized)) {
    return false
  }

  const code = extractCode(normalized)
  if (code && isBareFaultCodeQuery(normalized, code)) {
    return true
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

  if (
    /(场站|风场|厂家|品牌|机型|型号|系列|具体型号)/i.test(normalized) &&
    /(对应|是什么|哪个|哪种|哪家|哪款|查询|查找|关系|匹配|映射|资料|故障)/i.test(normalized)
  ) {
    return true
  }

  const hasWindDomainTerm =
    /(风机|风电|变桨|偏航|风速仪|风向仪|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|24v|plc|hw2s|华仪)/i.test(
      normalized,
    )
  const hasKnowledgeIntent =
    /(故障|报警|告警|停机|复位|不可复位|异常|保护|跳开|跳闸|空开|加热器|超出|超限|限制|最大|最小|过高|过低|高于|低于|温度|压力|电流|电压|频率|转速|功率|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|短路|断路|丢失|原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|区别|关系|解释|介绍|怎么|如何|为什么|是什么|啥意思|含义)/i.test(
      normalized,
    )

  return hasWindDomainTerm && hasKnowledgeIntent
}

function isPrincipleConsultation(text) {
  return /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|怎么工作|如何工作|为什么能|为什么会|怎样实现|怎么实现|如何实现|结构|组成|作用|用途|区别|关系|解释一下|讲一下|介绍一下|科普|控制逻辑|运行逻辑)/i.test(
    text,
  )
}

function hasFaultKnowledgeSignal(text) {
  return (
    FAULT_CODE_PATTERN.test(text) ||
    /(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(text) ||
    /(怎么处理|如何处理|处理方法|处置|排查|检查|维修|复位|短路|断路|丢失|不可复位|停机|报警|告警|报错)/i.test(
      text,
    )
  )
}

function normalizeRetrievalQuery(text) {
  const cleaned = text
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/[？?。!！]+$/g, '')
    .trim()
  const code = extractCode(cleaned)
  if (code && isBareFaultCodeQuery(cleaned, code)) return code
  return cleaned
}

function extractCode(text) {
  return text.match(FAULT_CODE_PATTERN)?.[0] || ''
}

function isBareFaultCodeQuery(text, code) {
  const withoutCode = text
    .replace(code, '')
    .replace(/(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|为什么|的|为|是)/gi, '')
    .replace(/[？?，,。.、:：\s]/g, '')
  return withoutCode.length === 0
}

function isFaultCodeLookupQuery(text) {
  return /(故障码|故障代码|报码|告警码|报警码|状态代码).*(是什么|多少|哪些|有啥|对应|查询|查|找)|(是什么|多少|哪些|有啥|对应|查询|查|找).*(故障码|故障代码|报码|告警码|报警码|状态代码)/i.test(
    text,
  )
}

function isLikelyFaultNameQuery(text) {
  return (
    /(风机|风电|变桨|偏航|风速仪|风向仪|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|24v|plc|hw2s|华仪)/i.test(text) &&
    /(故障|报警|告警|停机|复位|不可复位|异常|超出|超限|限制|最大|最小|过高|过低|高于|低于|温度|压力|电流|电压|频率|转速|功率)/i.test(text)
  )
}

async function runLlmwiki(args) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [RUNNER, '--print', '--bare', args],
    {
      env: {
        ...process.env,
        ...(process.env.LLMWIKI_PROJECT
          ? { LLMWIKI_PROJECT: process.env.LLMWIKI_PROJECT }
          : {}),
        ...(process.env.LLMWIKI_DIR ? { LLMWIKI_DIR: process.env.LLMWIKI_DIR } : {}),
        ANTHROPIC_MODEL_PROVIDER:
          process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
        LMSTUDIO_MODEL: CHAT_MODEL,
        LMSTUDIO_CHAT_MODEL: CHAT_MODEL,
        LMSTUDIO_BASE_URL: LOCAL_BASE_URL,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return stdout.trim()
}

async function searchKnowledge(query) {
  const code = extractCode(query)
  const command = code
    ? isBareFaultCodeQuery(query, code)
      ? `/llmwiki ask ${code} --limit 4`
      : `/llmwiki ask ${query} --limit 8`
    : isFaultCodeLookupQuery(query)
      ? `/llmwiki ask ${query} --limit 20`
      : isLikelyFaultNameQuery(query)
        ? `/llmwiki ask ${query} --limit 8`
        : `/llmwiki search ${query} --limit 6`
  const primary = await runLlmwiki(
    command,
  )
  const systemPath = systemWikiPathForQuery(query)
  if (!systemPath || code) return primary

  const systemContext = await runLlmwiki(`/llmwiki read ${systemPath}`)
  if (!systemContext || /^LLMWiki error:/i.test(systemContext)) return primary
  return [
    `系统上下文：${systemPath}`,
    systemContext,
    '',
    primary,
  ].join('\n')
}

function systemWikiPathForQuery(text) {
  const normalized = text.replace(/\s+/g, '')
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

async function askLocalModel(messages, routeText, forcedModel = '') {
  let answer = ''
  for await (const chunk of streamLocalModel(messages, routeText, forcedModel)) {
    answer += chunk
  }
  return answer.trim()
}

async function* streamLocalModel(messages, routeText, forcedModel = '') {
  const selectedModel = forcedModel || CHAT_MODEL
  if (selectedModel === CHAT_MODEL || process.env.LMSTUDIO_STREAM === '0') {
    const answer = await callLocalModelOnce(selectedModel, messages)
    if (answer) yield answer
    return
  }
  try {
    const response = await fetch(`${LOCAL_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: getLocalMaxTokens(),
        ...noThinkingOptions(),
      }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    if (!response.body) return

    let emitted = false
    for await (const chunk of parseChatCompletionStream(response.body)) {
      if (!chunk) continue
      emitted = true
      yield chunk
    }
    if (!emitted) {
      const answer = await callLocalModelOnce(selectedModel, messages)
      if (answer) yield answer
    }
  } catch (error) {
    const answer = await callLocalModelOnce(selectedModel, messages)
    if (answer) {
      yield answer
      return
    }
    throw error
  }
}

async function callLocalModelOnce(model, messages) {
  const response = await fetch(`${LOCAL_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0.3,
      max_tokens: getLocalMaxTokens(),
      ...noThinkingOptions(),
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  const message = data?.choices?.[0]?.message
  const content = (message?.content || '').trim()
  if (content) return normalizeWindriseSourceLabel(content)
  if (isOkHealthCheckQuestion(messages)) {
    return 'OK'
  }
  if (isLocalModelIdentityQuestion(messages)) {
    return localModelIdentityAnswer(model)
  }
  if (isWindrisePrincipleQuestion(messages)) {
    return windrisePrincipleFallback(messages)
  }
  const reasoning = (message?.reasoning_content || '').trim()
  if (reasoning && !looksLikeInternalReasoning(reasoning) && !looksLikeRawKnowledgeEcho(reasoning)) {
    return reasoning
  }
  return ''
}

function normalizeWindriseSourceLabel(value) {
  return value.replace(/来源路径[:：]/g, '来源：')
}

function isLocalModelIdentityQuestion(messages) {
  const lastUser = [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
  return /(你是什么模型|你是谁|什么模型|当前模型|本地模型|model)/i.test(lastUser)
}

function isOkHealthCheckQuestion(messages) {
  return /^\s*(只回答|仅回答|回复|输出)?\s*OK\s*$/i.test(
    lastUserMessageText(messages),
  )
}

function localModelIdentityAnswer(model) {
  return `我是 Windrise，本地中文助手；当前通过 vLLM 使用 ${model}。`
}

function localDateTimeAnswer(text) {
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

function isWindrisePrincipleQuestion(messages) {
  const text = lastUserMessageText(messages)
  return (
    /(风机|风电|变桨|偏航|主控|变流|发电机|齿轮箱|液压|制动|安全链|电网|通信|水冷|传动|叶片|轮毂)/i.test(text) &&
    /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|为什么|怎么工作|如何工作|是什么)/i.test(text)
  )
}

function windrisePrincipleFallback(messages) {
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

function lastUserMessageText(messages) {
  return [...messages]
    .reverse()
    .find(message => message.role === 'user')
    ?.content ?? ''
}

function getLocalMaxTokens() {
  const value = Number.parseInt(
    process.env.LMSTUDIO_MAX_TOKENS || process.env.LMSTUDIO_NUM_PREDICT || '2048',
    10,
  )
  return Number.isFinite(value) && value > 0 ? value : 2048
}

function noThinkingOptions() {
  if (process.env.WINDRISE_ENABLE_THINKING === '1') return {}
  return {
    think: false,
    enable_thinking: false,
    reasoning_effort: 'none',
    reasoning: { effort: 'none', exclude: true },
  }
}

async function* parseChatCompletionStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() || ''
      for (const part of parts) {
        const chunk = parseChatCompletionStreamPart(part)
        if (chunk !== undefined) yield chunk
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const chunk = parseChatCompletionStreamPart(buffer)
      if (chunk !== undefined) yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

function parseChatCompletionStreamPart(part) {
  const payload = part
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()
  if (!payload || payload === '[DONE]') return undefined
  const data = JSON.parse(payload)
  return data?.choices?.map(choice => choice?.delta?.content || '').join('') || ''
}

async function printStreamedWindriseAnswer(messages, routeText) {
  output.write('Windrise: ')
  let answer = ''
  for await (const chunk of streamLocalModel(messages, routeText)) {
    answer += chunk
    output.write(chunk)
  }
  output.write('\n')
  return answer.trim()
}

function shouldAnswerWindFarmModelQuestion(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return false

  const mappingIntent = hasWindFarmModelMappingIntent(text)
  if (mappingIntent && lookupWindFarmModels(text)) return true

  if (hasFaultLookupSignal(text)) return false

  const hasFaultIntent =
    /(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|空开|加热器|温度|传感器|短路|断路|丢失)/i.test(
      text,
    )
  const hasExplicitMappingIntent = mappingIntent
  if (hasFaultIntent && !hasExplicitMappingIntent) return false

  const hasMappingIntent = mappingIntent
  if (!hasMappingIntent) return false

  return (
    /(风场|风电场|场站).*(机型|型号|风机|品牌|厂家|系列|对应|关系)|(机型|型号|风机|品牌|厂家|系列).*(风场|风电场|场站|对应|属于|哪个|哪些)/i.test(
      text,
    ) ||
    WIND_FARM_MODEL_ENTRIES.some(entry =>
      entrySearchValues(entry).some(value =>
        normalized.includes(normalizeWindFarmModelText(value)),
      ),
    )
  )
}

function hasFaultLookupSignal(text) {
  return (
    FAULT_CODE_PATTERN.test(text) ||
    /(故障码|故障代码|报警码|告警码|报码|状态代码|fault\s*code)/i.test(text) ||
    /(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|空开|加热器|温度|传感器|短路|断路|丢失)/i.test(
      text,
    )
  )
}

function hasWindFarmModelMappingIntent(text) {
  return (
    /(风场|风电场|场站|机型|型号|风机|品牌|厂家|系列|具体型号)/i.test(text) &&
    /(对应|匹配|属于|哪个|哪些|什么|哪家|哪款|查询|查一下|列出|清单|关系|资料|型号)/i.test(
      text,
    )
  )
}

function lookupWindFarmModels(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return null

  if (/(全部|所有|清单|列表|对应关系|关系表|有哪些风场|风场有哪些)/.test(text)) {
    return { kind: 'all', entries: WIND_FARM_MODEL_ENTRIES }
  }

  const siteMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    siteSearchValues(entry).some(value => {
      const normalizedValue = normalizeWindFarmModelText(value)
      return (
        normalizedValue.length >= 2 &&
        (normalized.includes(normalizedValue) ||
          normalized.includes(normalizedValue.replace(/风电场$/u, '')))
      )
    }),
  )
  if (siteMatches.length > 0) {
    const narrowed = narrowWindFarmModelEntries(siteMatches, normalized)
    return {
      kind: narrowed.length > 0 ? 'model' : 'site',
      entries: sortSpecificWindFarmMatches(narrowed.length > 0 ? narrowed : siteMatches),
    }
  }

  const modelMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    modelSearchValues(entry).some(model => {
      const normalizedModel = normalizeWindFarmModelText(model)
      return normalizedModel.length >= 3 && normalized.includes(normalizedModel)
    }),
  )
  if (modelMatches.length > 0) {
    return {
      kind: 'model',
      entries: sortSpecificWindFarmMatches(
        narrowWindFarmModelEntries(modelMatches, normalized),
      ),
    }
  }

  return null
}

function renderWindFarmModelAnswer(lookup) {
  if (!lookup || lookup.entries.length === 0) {
    return '没有在内置风场机型表中找到匹配项。'
  }

  const title =
    lookup.kind === 'all'
      ? '内置风场与风机型号对应关系：'
      : lookup.kind === 'model'
        ? '该机型对应的风场如下：'
        : '查询结果：'

  return [
    title,
    ...lookup.entries.map(entry => `- ${entry.site}：${entry.models.join('、')}`),
  ].join('\n')
}

async function answerWithWindFarmModel(query) {
  const lookup = lookupWindFarmModels(query)
  const context = renderWindFarmModelAnswer(lookup)
  console.log(`Windrise: ${context}`)
}

function sortSpecificWindFarmMatches(entries) {
  return [...entries].sort(
    (a, b) =>
      longestWindFarmSearchValue(b).length - longestWindFarmSearchValue(a).length ||
      a.site.localeCompare(b.site, 'zh-Hans-CN'),
  )
}

function longestWindFarmSearchValue(entry) {
  return entrySearchValues(entry).sort((a, b) => b.length - a.length)[0] || ''
}

function entrySearchValues(entry) {
  return [...siteSearchValues(entry), ...modelSearchValues(entry)]
}

function siteSearchValues(entry) {
  return [entry.site, ...(entry.aliases || [])]
}

function modelSearchValues(entry) {
  return [
    ...entry.models,
    ...entry.models.map(model => model.replace(/^\S+\s+/, '')),
    ...entry.models.map(model =>
      model
        .replace(/（具体型号[:：][^）]+）/u, '')
        .replace(/\(具体型号[:：][^)]+\)/u, ''),
    ),
    ...entry.models.map(model =>
      model
        .replace(/（具体型号[:：][^）]+）/u, '')
        .replace(/\(具体型号[:：][^)]+\)/u, '')
        .replace(/^\S+\s+/, ''),
    ),
    ...entry.models.flatMap(model => {
      const specific = model.match(/具体型号[:：]([^）)]+)/u)?.[1] ?? ''
      return specific.split(/[、,，]/u).map(item => item.trim()).filter(Boolean)
    }),
  ].filter(Boolean)
}

function narrowWindFarmModelEntries(entries, normalizedQuery) {
  return entries
    .map(entry => {
      const models = entry.models.filter(model =>
        modelSearchValues({ ...entry, models: [model] }).some(value => {
          const normalizedValue = normalizeWindFarmModelText(value)
          return normalizedValue.length >= 3 && normalizedQuery.includes(normalizedValue)
        }),
      )
      return models.length > 0 ? { ...entry, models } : null
    })
    .filter(Boolean)
}

function mergeWindFarmModelEntries(entries) {
  const bySite = new Map()
  for (const entry of entries) {
    const key = normalizeWindFarmModelText(entry.site)
    const current = bySite.get(key) ?? {
      site: entry.site,
      aliases: [],
      models: [],
    }
    for (const alias of entry.aliases || []) pushUniqueText(current.aliases, alias)
    for (const model of entry.models || []) pushUniqueText(current.models, model)
    bySite.set(key, current)
  }
  return [...bySite.values()]
}

function loadFaultIndexWindFarmModelEntries() {
  const indexPath = join(ROOT, '风机故障码', 'fault-index.jsonl')
  let content = ''
  try {
    content = readFileSync(indexPath, 'utf8')
  } catch {
    return []
  }

  const bySite = new Map()
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const source = String(record.source || '')
    if (!source.startsWith('故障码0610/') && !source.startsWith('故障信息整理/')) continue
    const siteLabels = splitMappingValues(record.site)
    const brand = String(record.brand || '').trim()
    const series = String(record.model || '').trim()
    const standardModels = splitModelValues(record.standardModel)
    if (siteLabels.length === 0 || !brand || !series || standardModels.length === 0) {
      continue
    }
    const modelText = `${brand} ${series}（具体型号：${standardModels.join('、')}）`
    for (const site of siteLabels) {
      const siteName = site.endsWith('风电场') ? site : `${site}风电场`
      const key = normalizeWindFarmModelText(siteName)
      const entry = bySite.get(key) ?? {
        site: siteName,
        aliases: [site],
        models: [],
      }
      pushUniqueText(entry.aliases, site)
      pushUniqueText(entry.models, modelText)
      bySite.set(key, entry)
    }
  }
  return [...bySite.values()]
}

function splitMappingValues(value) {
  return String(value || '')
    .split(/[、,，/]/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function splitModelValues(value) {
  return String(value || '')
    .split(/[、,，]/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function pushUniqueText(values, value) {
  const normalized = String(value || '').trim()
  if (!normalized || values.includes(normalized)) return
  values.push(normalized)
}

function normalizeWindFarmModelText(text) {
  return String(text)
    .toLowerCase()
    .replace(/[（）]/g, match => (match === '（' ? '(' : ')'))
    .replace(/[.\s_\-—–/\\()（）]/g, '')
    .replace(/风力发电场/g, '风电场')
    .trim()
}

function isNetworkQuery(text) {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^(web|search|fetch|url)\b/i.test(normalized)) return true
  if (/(天气|气温|降雨|下雨|空气质量|aqi|预报|新闻|最新|current|latest|today|tomorrow)/i.test(normalized)) {
    return true
  }
  if (
    /^(帮我|给我|请)?\s*(搜索|搜一下|查一下|查找|查|查询)\s*/i.test(normalized) &&
    !shouldAutoRetrieve(normalized)
  ) {
    return true
  }
  return /^(联网|网络|搜索网络|上网|查资料|抓取|打开网页|访问网页)/i.test(
    normalized,
  )
}

function isWeatherQuery(text) {
  return /(天气|气温|降雨|下雨|空气质量|aqi|预报)/i.test(text)
}

function isUrl(text) {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function extractUrl(text) {
  const match = text.match(/https?:\/\/\S+/i)
  return (match?.[0] || text.trim()).replace(/[。)，,)]+$/g, '')
}

async function fetchText(url) {
  if (!ENABLE_NETWORK) {
    throw new Error('Network access is disabled. Set WINDRISE_ENABLE_NETWORK=1 to enable it.')
  }
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.text()
}

async function fetchJson(url) {
  if (!ENABLE_NETWORK) {
    throw new Error('Network access is disabled. Set WINDRISE_ENABLE_NETWORK=1 to enable it.')
  }
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  return response.json()
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|li|h\d|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function truncateText(text, maxChars) {
  const normalized = text.trim()
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}\n\n[内容过长，已截断]`
    : normalized
}

async function searchWeb(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const html = await fetchText(url)
  const text = stripHtml(html)
  const links = [...html.matchAll(/href="([^"]+)"/gi)]
    .map(match => match[1])
    .filter(Boolean)
    .map(value => decodeURIComponent(value.replace(/^.*uddg=/, '').replace(/&rut=.*$/, '')))
    .filter(value => /^https?:\/\//i.test(value))
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 8)
  return truncateText(
    [
      `联网搜索：${query}`,
      '',
      text,
      links.length ? `\n来源链接：\n${links.map(link => `- ${link}`).join('\n')}` : '',
    ].join('\n'),
    6000,
  )
}

async function fetchWebPage(inputText) {
  const url = extractUrl(inputText)
  if (!isUrl(url)) {
    throw new Error(`Invalid URL: ${url}`)
  }
  const html = await fetchText(url)
  return truncateText([`URL：${url}`, '', stripHtml(html)].join('\n'), 8000)
}

function extractWeatherLocation(text) {
  const normalized = text
    .replace(/^\s*(帮我|给我|请)?\s*(搜索一下|搜一下|搜索|查询|查一下|查|联网|weather)\s*/i, '')
    .replace(/(今天|明天|后天|天气|气温|降雨|下雨|空气质量|aqi|预报|的|怎么样|如何|多少|一下|[？?。!！,，])/gi, ' ')
    .trim()
  return normalized || '北京'
}

function weatherDayOffset(text) {
  if (/后天/.test(text)) return 2
  if (/明天|tomorrow/i.test(text)) return 1
  return 0
}

function weatherCodeText(code) {
  const map = {
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

async function queryWeather(text) {
  const location = extractWeatherLocation(text)
  const offset = weatherDayOffset(text)
  const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`
  const geo = await fetchJson(geoUrl)
  const place = geo?.results?.[0]
  if (!place) {
    throw new Error(`找不到城市：${location}`)
  }

  const days = Math.max(3, offset + 1)
  const forecastUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
    `&timezone=${encodeURIComponent(place.timezone || 'Asia/Shanghai')}&forecast_days=${days}`
  const forecast = await fetchJson(forecastUrl)
  const daily = forecast.daily
  const index = Math.min(offset, Math.max(0, (daily?.time?.length || 1) - 1))

  const date = daily.time[index]
  const max = daily.temperature_2m_max[index]
  const min = daily.temperature_2m_min[index]
  const rain = daily.precipitation_probability_max[index]
  const code = daily.weather_code[index]
  const dayLabel = offset === 1 ? '明天' : offset === 2 ? '后天' : '今天'
  return [
    `${place.name}${place.admin1 ? `（${place.admin1}）` : ''}${dayLabel}天气（${date}）：`,
    `- 天气：${weatherCodeText(code)}`,
    `- 气温：${min}°C - ${max}°C`,
    `- 最高降水概率：${rain}%`,
    '',
    '来源：Open-Meteo',
  ].join('\n')
}

async function answerWithWeb(text) {
  if (isWeatherQuery(text)) {
    console.log(`Windrise: 正在查询天气...`)
    console.log(`Windrise: ${await queryWeather(text)}`)
    return
  }

  const fetchTarget = extractUrl(text)
  let webContext
  if (isUrl(fetchTarget)) {
    console.log(`Windrise: 正在抓取 ${fetchTarget} ...`)
    webContext = await fetchWebPage(fetchTarget)
  } else {
    const query = text.replace(/^\s*(帮我|给我|请)?\s*(联网|网络|搜索网络|上网|搜一下|搜索一下|搜索|查一下|查询|查找|查资料|web\s+search|web|search)\s*/i, '').trim()
    console.log(`Windrise: 正在联网搜索「${query || text}」...`)
    webContext = await searchWeb(query || text)
  }

  const prompt = `用户问题：${text}

下面是联网获取的资料。请基于这些资料用中文回答；如果资料不足，请明确说明。回答末尾列出来源链接。

${webContext}`

  const answer = await printStreamedWindriseAnswer([
    {
        role: 'system',
        content:
          '你是 Windrise，负责把联网搜索或网页抓取结果整理成可靠的中文答案。必须说明来源，不要编造资料中没有的信息。',
    },
    { role: 'user', content: prompt },
  ], `联网资料总结：${text}`)
  if (!answer) console.log(`Windrise: ${webContext}`)
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

async function answerNormally(text) {
  const messages = [...history, { role: 'user', content: text }]
  try {
    const answer = await printStreamedWindriseAnswer(messages, text)
    if (!answer) {
      console.log('Windrise: 没有收到模型回复。')
      return
    }
    rememberConversation(text, answer)
  } catch (error) {
    console.log(
      `Windrise: 本地模型暂时不可用。请先启动 ${PROVIDER_LABEL}，或检查 ${LOCAL_BASE_URL}。\n详情：${error.message}`,
    )
  }
}

async function answerWithRetrieval(text) {
  const query = getRetrievalRequest(text).query
  if (!query) {
    console.log('Windrise: 请输入要检索的内容，例如：303804 或 变桨24V主电源开关故障')
    return
  }

  console.log(`Windrise: 正在检索「${query}」...`)
  let hits
  try {
    hits = await searchKnowledge(query)
  } catch (error) {
    console.log(`Windrise: 检索失败：${error.message}`)
    return
  }

  if (!hits || hits.startsWith('No matches')) {
    console.log(`Windrise: 没找到相关内容。\n${hits}`)
    return
  }

  if (shouldReturnStructuredFaultAnswer(query, hits)) {
    console.log(`Windrise: ${hits}`)
    updateRecentFaultContextFromAnswer(hits, query)
    rememberConversation(text, retrievalMemorySummary(query, hits))
    return
  }

  const prompt = `以下是本地 LLMWiki 检索到的相关资料，只作为回答依据，不要原样复述。

${hits}

用户问题：${query}

请直接回答用户问题，组织成现场工程人员能直接使用的中文答案；涉及故障处理时保留关键故障代码、故障名称、原因、处理方法和来源路径。
如果检索结果不足以确认结论，请明确说明需要补充的风场、品牌、机型、故障码或现场现象。`

  try {
    let answer = await askLocalModel([
      {
        role: 'system',
        content:
          '你是 Windrise，负责结合本地风电知识库和自身专业能力回答现场问题。不要原样输出检索结果、系统上下文或 Matches for 列表；必须直接回答用户问题。',
      },
      { role: 'user', content: prompt },
    ], `故障知识库总结：${query}`, CHAT_MODEL)

    if (!answer || looksLikeRawKnowledgeEcho(answer)) {
      answer = await askLocalModel([
        {
          role: 'system',
          content:
            '你是 Windrise，负责结合本地风电知识库和自身专业能力回答现场问题。只输出给客户看的答案，不要输出检索原文。',
        },
        {
          role: 'user',
          content: `本地知识库压缩上下文：\n${compactKnowledgeContext(hits)}\n\n用户问题：${query}\n\n请直接回答用户问题。`,
        },
      ], `故障知识库压缩总结：${query}`, CHAT_MODEL)
    }

    if (answer) console.log(`Windrise: ${answer}`)
    updateRecentFaultContextFromAnswer(hits, query)
    const sourceLine = answer ? missingSourceLine(answer, hits) : ''
    if (sourceLine) console.log(sourceLine)
    if (!answer) {
      const fallback = compactKnowledgeContext(hits)
      console.log(`Windrise: 本地模型没有返回整理答案。下面是压缩后的本地知识摘要：\n${fallback}`)
      rememberConversation(text, retrievalMemorySummary(query, fallback))
    } else {
      rememberConversation(text, retrievalMemorySummary(query, `${answer}\n${sourceLine}`))
    }
  } catch (error) {
    console.log(
      `Windrise: 本地模型暂时不可用，先给你原始检索结果。\n详情：${error.message}\n\n${hits}`,
    )
    updateRecentFaultContextFromAnswer(hits, query)
    rememberConversation(text, retrievalMemorySummary(query, hits))
  }
}

function rememberConversation(userText, assistantText) {
  const answer = String(assistantText || '').trim()
  if (!answer) return
  history.push({ role: 'user', content: userText })
  history.push({ role: 'assistant', content: answer })
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(1, history.length - MAX_HISTORY_MESSAGES)
  }
}

function retrievalMemorySummary(query, answer) {
  const lines = String(answer || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const useful = lines.filter(line =>
    /^(#+\s*)?本地答案[:：]|^\*\*结论[:：]|^结论[:：]|^对象[:：]|^品牌[:：]|^机型[:：]|^具体型号[:：]|^故障代码[:：]|^故障名称[:：]|^风场\/机型[:：]|^-\s*风场[:：]|^故障描述[:：]|^原因[:：]|^处理[:：]|^程序[:：]|^复位|^逻辑[:：]|^来源[:：]/.test(
      line,
    ),
  )
  const body = (useful.length > 0 ? useful : lines.slice(0, 20)).join('\n')
  return [
    `已检索本地知识库：${query}`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000)
}

function updateRecentFaultContextFromAnswer(answer, query = '') {
  const context = extractFaultContextFromAnswer(answer)
  if (!context.code && !context.name) return
  recentFaultContext = {
    ...recentFaultContext,
    ...context,
    query,
  }
}

function extractFaultContextFromAnswer(answer) {
  const text = String(answer || '')
  const code =
    text.match(/标准码[:：]\s*([A-Za-z0-9_./\-]+)/)?.[1]?.trim() ||
    text.match(/故障代码[:：]\s*([A-Za-z0-9_./\-\s]+?)(?:（|\n|$)/)?.[1]?.trim() ||
    text.match(/结论[:：]\**\s*故障码\s*([A-Za-z0-9_./\-]+)/)?.[1]?.trim() ||
    text.match(/结论[:：]\s*([A-Za-z0-9_./\-]+)\s*为「/)?.[1]?.trim() ||
    ''
  const name = text.match(/(?<!\/)故障名称[:：]\s*(.+?)(?=\s+(?:风场|故障描述|原因|处理|来源|程序|复位|对象|品牌|机型|具体型号|故障代码)[:：]|$)/)?.[1]?.trim() || ''
  const brand = text.match(/(?<!\/)品牌[:：]\s*([^\s/]+)/)?.[1]?.trim() || ''
  const model = text.match(/(?<!\/)机型[:：]\s*([^\s/]+)/)?.[1]?.trim() || ''
  const sites = [
    ...text.matchAll(/(?<!\/)风场[:：]\s*([^\s/]+)/g),
  ]
    .map(match => match[1]?.trim())
    .filter(Boolean)
  const uniqueSites = [...new Set(sites)]
  return {
    code,
    name,
    site: uniqueSites.length === 1 ? uniqueSites[0] : '',
    brand,
    model,
  }
}

function looksLikeRawKnowledgeEcho(answer) {
  return /(^|\n)(Windrise:\s*)?(系统上下文：|Matches for "|# wiki\/|LLMWiki commands:)/.test(answer)
}

function shouldReturnExactFaultCodeAnswer(query, hits) {
  return (
    extractCode(query) &&
    /^#+\s*本地答案：|^本地答案：/m.test(hits) &&
    /风场\/机型：/.test(hits)
  )
}

function shouldReturnStructuredFaultAnswer(query, hits) {
  return (
    shouldReturnExactFaultCodeAnswer(query, hits) ||
    (
      (/^#+\s*本地答案：|^本地答案：/m.test(hits)) &&
      /结论：\s*[A-Za-z0-9_./\-~～至到、,，]+\s*为「/.test(hits) &&
      /来源：/.test(hits)
    ) ||
    (
      (/^#+\s*本地答案：|^本地答案：/m.test(hits)) &&
      /结论：\**\s*按名称\/描述/.test(hits) &&
      /风场\/机型：/.test(hits)
    )
  )
}

function looksLikeInternalReasoning(answer) {
  return /Thinking Process|We need answer|我们需要|用户问/.test(answer.slice(0, 300))
}

function compactKnowledgeContext(hits) {
  const lines = hits.split(/\r?\n/)
  const systemLine = lines.find(line => line.startsWith('系统上下文：')) || ''
  const titleLine = lines.find(line => /^#\s+.+系统/.test(line)) || ''
  const faultExamples = lines
    .filter(line => /^-\s*\d+：/.test(line))
    .slice(0, 10)
  const matchedRecords = lines
    .filter(line => /故障代码|故障名称|故障原因|故障处理|故障逻辑|复位/.test(line))
    .slice(0, 8)
  const sources = lines
    .filter(line => /\.md:\d+/.test(line))
    .slice(0, 5)
  return [
    systemLine,
    titleLine,
    faultExamples.length ? `相关故障示例：\n${faultExamples.join('\n')}` : '',
    matchedRecords.length ? `检索命中摘要：\n${matchedRecords.join('\n')}` : '',
    sources.length ? `来源：\n${sources.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000)
}

function missingSourceLine(answer, hits) {
  if (/来源[:：]/.test(answer)) return ''
  const sourceLine = hits.match(/^来源[:：]\s*(.+)$/m)?.[1]
  if (sourceLine) return `来源：${sourceLine}`
  const firstSupplement = hits.match(/^- (.+:\d+)$/m)?.[1]
  return firstSupplement ? `来源：${firstSupplement}` : ''
}

async function handleLine(line) {
  const text = line.trim()
  if (!text) return true

  if (/^(exit|quit|q|退出)$/i.test(text)) return false
  if (/^(help|帮助)$/i.test(text)) {
    printHelp()
    return true
  }
  if (/^clear$/i.test(text)) {
    history.splice(1)
    recentFaultContext = null
    console.log('Windrise: 对话上下文已清空。')
    return true
  }
  if (/^model$/i.test(text)) {
    console.log(`Windrise: model=${CHAT_MODEL}`)
    return true
  }
  const dateAnswer = localDateTimeAnswer(text)
  if (dateAnswer) {
    console.log(`Windrise: ${dateAnswer}`)
    return true
  }
  if (/^farm\b/i.test(text) || shouldAnswerWindFarmModelQuestion(text)) {
    const query = text.replace(/^farm\s*/i, '').trim() || text
    await answerWithWindFarmModel(query)
    return true
  }
  if (/^(web|search)\s+/i.test(text) || isNetworkQuery(text) || isUrl(text)) {
    try {
      await answerWithWeb(text)
    } catch (error) {
      console.log(`Windrise: 联网功能失败：${error.message}`)
    }
    return true
  }
  if (/^tree\b/i.test(text)) {
    const path = text.replace(/^tree\s*/i, '').trim()
    console.log(
      await runLlmwiki(
        path
          ? `/llmwiki tree ${path} --depth 2 --limit 50`
          : '/llmwiki tree --depth 2 --limit 50',
      ),
    )
    return true
  }
  if (/^read\b/i.test(text)) {
    const path = text.replace(/^read\s*/i, '').trim()
    if (!path) {
      console.log('Windrise: 用法：read <LLMWiki路径>')
      return true
    }
    console.log(await runLlmwiki(`/llmwiki read ${path}`))
    return true
  }
  if (getRetrievalRequest(text).shouldRetrieve) {
    await answerWithRetrieval(text)
    return true
  }

  await answerNormally(text)
  return true
}

printBanner()

const rl = createInterface({ input, output, prompt: '\nwindrise> ' })
try {
  if (input.isTTY) rl.prompt()
  for await (const line of rl) {
    const keepGoing = await handleLine(line)
    if (!keepGoing) break
    if (input.isTTY) rl.prompt()
  }
} finally {
  rl.close()
}

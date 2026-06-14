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
const CODER_MODEL =
  process.env.LMSTUDIO_CODER_MODEL ||
  process.env.LMSTUDIO_MODEL ||
  'qwen3.5-9b-coder'
const CHAT_MODEL =
  process.env.LMSTUDIO_CHAT_MODEL ||
  process.env.LMSTUDIO_MODEL ||
  CODER_MODEL
const ROUTER_MODEL =
  process.env.LMSTUDIO_ROUTER_MODEL ||
  process.env.WINDRISE_ROUTER_MODEL ||
  CODER_MODEL
const ENABLE_NETWORK = process.env.WINDRISE_ENABLE_NETWORK !== '0'
const DISABLE_AUTO_LLMWIKI = process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1'
const LOCAL_BASE_URL = (
  process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234'
).replace(/\/$/, '')
const PROVIDER_LABEL = 'LM Studio'
const WIND_FARM_MODEL_ENTRIES = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', 'windFarmModels.json'), 'utf8'),
)

if (!isLoopbackUrl(LOCAL_BASE_URL)) {
  console.error(
    `Windrise: 拒绝非本机 ${PROVIDER_LABEL} 地址 ${LOCAL_BASE_URL}。离线模式只允许 localhost/127.0.0.1/::1。`,
  )
  process.exit(1)
}

const history = [
  {
    role: 'system',
    content: DISABLE_AUTO_LLMWIKI
      ? '你是 Windrise，一个面向风机故障码、本地知识库和工程问题的中文助手。正常对话时简洁回答。不要假装已经检索本地知识库；只有用户明确使用 llmwiki 或 /llmwiki 命令时，才使用本地知识库。'
      : '你是 Windrise，一个面向风机故障码、本地知识库和工程问题的中文助手。正常对话时简洁回答。不要假装已经检索本地知识库；当用户询问故障码或明显的风机故障/报警/处理问题时，程序会自动检索 LLMWiki。',
  },
]

function printBanner() {
  console.log(`╭────────────────────────────────────────────╮
│ 🌀  Windrise                               │
│ ⌁⌁⌁ 对话模式 · 按需检索风机故障码知识库      │
╰────────────────────────────────────────────╯
直接输入问题后按回车即可对话。
${DISABLE_AUTO_LLMWIKI ? '自动 LLMWiki 检索已关闭；需要知识库时请输入：llmwiki 303804。' : '故障码、风机报警、处理建议类问题会自动检索；也可以说：检索 303804。'}
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
  if (isPrincipleConsultation(text) && !hasFaultKnowledgeSignal(text)) {
    return false
  }
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

function isPrincipleConsultation(text) {
  return /(原理|机理|机制|工作方式|工作过程|运行方式|运行过程|怎么工作|如何工作|为什么能|为什么会|怎样实现|怎么实现|如何实现|结构|组成|作用|用途|区别|关系|解释一下|讲一下|介绍一下|科普|控制逻辑|运行逻辑)/i.test(
    text,
  )
}

function hasFaultKnowledgeSignal(text) {
  return (
    /[a-z]?_?[0-9]{3,}/i.test(text) ||
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
  const code = cleaned.match(/[0-9]{3,}/)?.[0]
  if (code && isBareFaultCodeQuery(cleaned, code)) return code
  return cleaned
}

function extractCode(text) {
  return text.match(/[0-9]{3,}/)?.[0] || ''
}

function isBareFaultCodeQuery(text, code) {
  const withoutCode = text
    .replace(code, '')
    .replace(/(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|为什么|的|为|是)/gi, '')
    .replace(/[？?，,。.、:：\s]/g, '')
  return withoutCode.length === 0
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
        LMSTUDIO_MODEL: CODER_MODEL,
        LMSTUDIO_CODER_MODEL: CODER_MODEL,
        LMSTUDIO_CHAT_MODEL: CHAT_MODEL,
        LMSTUDIO_ROUTER_MODEL: ROUTER_MODEL,
        LMSTUDIO_BASE_URL: LOCAL_BASE_URL,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  )
  return stdout.trim()
}

async function searchKnowledge(query) {
  const code = extractCode(query)
  return runLlmwiki(
    code ? `/llmwiki ask ${code} --limit 4` : `/llmwiki search ${query} --limit 6`,
  )
}

async function askLocalModel(messages, routeText) {
  let answer = ''
  for await (const chunk of streamLocalModel(messages, routeText)) {
    answer += chunk
  }
  return answer.trim()
}

async function* streamLocalModel(messages, routeText) {
  const selectedModel = await selectResponseModel(routeText, messages)
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
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  if (!response.body) return

  yield* parseChatCompletionStream(response.body)
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

async function selectResponseModel(routeText, messages) {
  if (process.env.LMSTUDIO_FORCE_CHAT === '1') return CHAT_MODEL
  if (process.env.LMSTUDIO_FORCE_CODER === '1') return CODER_MODEL
  if (process.env.WINDRISE_MODEL_ROUTER !== '1') {
    return fallbackRouteModel(routeText)
  }

  const text = routeText || lastUserText(messages)
  try {
    const response = await fetch(`${LOCAL_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY || 'lm-studio'}`,
      },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是本地模型路由器。只输出 coder 或 chat。默认输出 chat。只有用户明确要求修改/创建/删除文件、运行命令、执行测试或构建、调试报错、生成补丁、调用工具处理代码仓库时输出 coder。普通问答、解释、总结、故障知识库回答、现场处理建议、概念说明、项目概览都输出 chat。',
          },
          {
            role: 'user',
            content: `用户输入：${text}\n\n可选模型：coder=${CODER_MODEL}，chat=${CHAT_MODEL}\n只输出一个词：coder 或 chat。`,
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: 4,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    const decision =
      data?.choices?.[0]?.message?.content?.trim().toLowerCase() || ''
    if (decision.includes('coder')) return CODER_MODEL
    if (decision.includes('chat')) return CHAT_MODEL
  } catch {
    // Fall through to the deterministic router when the route model is unavailable.
  }

  return fallbackRouteModel(text)
}

function fallbackRouteModel(text) {
  return isCoderTask(text || '') ? CODER_MODEL : CHAT_MODEL
}

function isCoderTask(text) {
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

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return messages[index].content || ''
  }
  return ''
}

function shouldAnswerWindFarmModelQuestion(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return false
  const hasMappingIntent =
    /(风场|风电场|机型|型号|风机|品牌|对应|匹配|属于|哪个|哪些|什么|查询|查一下|列出|清单|关系)/i.test(
      text,
    )
  if (!hasMappingIntent) return false

  return (
    /(风场|风电场).*(机型|型号|风机|品牌|对应|关系)|(机型|型号|风机|品牌).*(风场|风电场|对应|属于|哪个|哪些)/i.test(
      text,
    ) ||
    WIND_FARM_MODEL_ENTRIES.some(entry =>
      entrySearchValues(entry).some(value =>
        normalized.includes(normalizeWindFarmModelText(value)),
      ),
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
    return { kind: 'site', entries: sortSpecificWindFarmMatches(siteMatches) }
  }

  const modelMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    modelSearchValues(entry).some(model => {
      const normalizedModel = normalizeWindFarmModelText(model)
      return normalizedModel.length >= 3 && normalized.includes(normalizedModel)
    }),
  )
  if (modelMatches.length > 0) {
    return { kind: 'model', entries: sortSpecificWindFarmMatches(modelMatches) }
  }

  return null
}

function renderWindFarmModelAnswer(lookup) {
  if (!lookup || lookup.entries.length === 0) {
    return 'Windrise: 没有在内置风场机型表中找到匹配项。'
  }

  const title =
    lookup.kind === 'all'
      ? 'Windrise: 内置风场与风机型号对应关系：'
      : lookup.kind === 'model'
        ? 'Windrise: 该机型对应的风场如下：'
        : 'Windrise: 查询结果：'

  return [
    title,
    ...lookup.entries.map(entry => `- ${entry.site}：${entry.models.join('、')}`),
  ].join('\n')
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
  ].filter(Boolean)
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
  if (/(天气|气温|降雨|下雨|空气质量|aqi|预报|新闻|最新|current|latest|today|tomorrow|明天|后天|今天|昨天)/i.test(normalized)) {
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

async function answerNormally(text) {
  const messages = [...history, { role: 'user', content: text }]
  try {
    const answer = await printStreamedWindriseAnswer(messages, text)
    if (!answer) {
      console.log('Windrise: 没有收到模型回复。')
      return
    }
    history.push({ role: 'user', content: text })
    history.push({ role: 'assistant', content: answer })
    if (history.length > 17) {
      history.splice(1, history.length - 17)
    }
    console.log(`Windrise: ${answer}`)
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

  if (isExactFaultCodeAnswer(query, hits)) {
    console.log(`Windrise: ${hits}`)
    return
  }

  const prompt = `用户问题：${query}

以下是本地 LLMWiki 检索结果，是本次故障知识回答的唯一事实来源。
请基于这些结果用中文总结，先给结论，再给处理建议。必须保留关键故障代码、故障名称、原因、处理方法和来源路径。
回答最后必须包含一行“来源：...”，来源只能使用检索结果里的来源路径。
不要把相似故障、其它机型或模型常识当作本条记录；检索结果没有的信息请明确说未提供。

${hits}`

  try {
    const answer = await printStreamedWindriseAnswer([
      {
        role: 'system',
        content:
          '你是 Windrise，负责把风机故障码知识库检索结果整理成现场工程人员能直接使用的中文答案。',
      },
      { role: 'user', content: prompt },
    ], `故障知识库总结：${query}`)
    const sourceLine = answer ? missingSourceLine(answer, hits) : ''
    if (sourceLine) console.log(sourceLine)
    if (!answer) console.log(`Windrise: ${hits}`)
  } catch {
    console.log(`Windrise: 本地模型暂时不可用，先给你原始检索结果：\n\n${hits}`)
  }
}

function isExactFaultCodeAnswer(query, hits) {
  return (
    /^[a-z0-9_/-]+$/i.test(query) &&
    /^本地答案：/m.test(hits) &&
    /^结论：/m.test(hits)
  )
}

function ensureSourceLine(answer, hits) {
  if (/来源[:：]/.test(answer)) return answer
  const sourceLine = hits.match(/^来源[:：]\s*(.+)$/m)?.[1]
  if (sourceLine) return `${answer}\n\n来源：${sourceLine}`
  const firstSupplement = hits.match(/^- (.+:\d+)$/m)?.[1]
  if (firstSupplement) return `${answer}\n\n来源：${firstSupplement}`
  return answer
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
    console.log('Windrise: 对话上下文已清空。')
    return true
  }
  if (/^model$/i.test(text)) {
    console.log(
      `Windrise: coder=${CODER_MODEL}\nWindrise: chat=${CHAT_MODEL}\nWindrise: router=${ROUTER_MODEL}`,
    )
    return true
  }
  if (/^farm\b/i.test(text) || shouldAnswerWindFarmModelQuestion(text)) {
    const query = text.replace(/^farm\s*/i, '').trim() || text
    console.log(renderWindFarmModelAnswer(lookupWindFarmModels(query)))
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

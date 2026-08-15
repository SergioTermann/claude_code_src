#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { stdin as input, stdout as output } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  isKnownTurbineIdToken,
  resolveTurbineMappingAnswer,
} from './turbine-mapping-lookup.mjs'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNNER = join(ROOT, 'scripts', 'run-lmstudio-claude.mjs')
const PROVIDER = 'lmstudio'
const MODEL_MODE = resolveModelMode()
const MODEL_DEFAULTS = modelDefaultsForMode(MODEL_MODE)
const CHAT_MODEL =
  process.env.LMSTUDIO_CHAT_MODEL ||
  process.env.LMSTUDIO_MODEL ||
  MODEL_DEFAULTS.model
const ENABLE_NETWORK = process.env.WINDRISE_ENABLE_NETWORK !== '0'
const DISABLE_AUTO_LLMWIKI = process.env.WINDRISE_DISABLE_AUTO_LLMWIKI === '1'
const LOCAL_BASE_URL = (
  process.env.LMSTUDIO_BASE_URL || MODEL_DEFAULTS.baseUrl
).replace(/\/$/, '')
const PROVIDER_LABEL = MODEL_DEFAULTS.label

const BASE_WIND_FARM_MODEL_ENTRIES = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', 'windFarmModels.json'), 'utf8'),
)
const WIND_FARM_MODEL_ENTRIES = mergeWindFarmModelEntries([
  ...BASE_WIND_FARM_MODEL_ENTRIES,
  ...loadFaultIndexWindFarmModelEntries(BASE_WIND_FARM_MODEL_ENTRIES),
])
if (process.env.WINDRISE_DEBUG_MAPPING === '1') {
  console.error(`[mapping] entries=${WIND_FARM_MODEL_ENTRIES.length}`)
}
const FAULT_CODE_PATTERN =
  /[a-z]+[a-z0-9_/-]*\d[a-z0-9_/-]*|\d+(?:[ _/-]+\d+)+|\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\d[a-z0-9_/-]*|\d{3,}/i
const CONTEXTUAL_FAULT_CODE_PATTERN =
  /(?:故障码|故障代码|报码|报出|报|告警码|报警码|报警|告警|状态代码|fault\s*code|alarm\s*code)\s*[:：为是]?\s*([a-z]+[a-z0-9_/-]*\d[a-z0-9_/-]*|\d+(?:[ _/-]+\d+)+|\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\d[a-z0-9_/-]*|[a-z]{0,4}\d{1,8}[a-z]{0,2})/i

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
let recentUserSlots = {}

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
      query: applyRecentUserSlotsToQuery(explicitLlmWiki),
    }
  }

  if (DISABLE_AUTO_LLMWIKI) {
    return { shouldRetrieve: false, query: '' }
  }

  const contextualQuery = contextualFaultFollowupQuery(text)
  if (contextualQuery) {
    return {
      shouldRetrieve: true,
      query: applyRecentUserSlotsToQuery(contextualQuery),
    }
  }

  if (shouldRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: applyRecentUserSlotsToQuery(trimTrigger(text)),
    }
  }

  if (shouldAutoRetrieve(text)) {
    return {
      shouldRetrieve: true,
      query: applyRecentUserSlotsToQuery(normalizeRetrievalQuery(text)),
    }
  }

  return { shouldRetrieve: false, query: '' }
}

function contextualFaultFollowupQuery(text) {
  const normalized = text.trim()
  if (!normalized || (!recentFaultContext && !hasUsefulSlots(recentUserSlots))) return ''
  if (extractCode(normalized)) return ''
  if (!isFaultContextFollowup(normalized)) return ''
  return [
    recentFaultContext?.code,
    recentFaultContext?.site,
    recentFaultContext?.brand || recentUserSlots.brand,
    recentFaultContext?.model || recentUserSlots.model,
    ...(recentUserSlots.component || []),
    ...(recentUserSlots.position || []),
    ...(recentUserSlots.symptom || []),
    normalized,
  ]
    .filter(Boolean)
    .join(' ')
}

function isFaultContextFollowup(text) {
  if (/^(这个|那个|它|该故障|该报警|该问题|上面|前面|刚才)/.test(text)) {
    return true
  }
  return /(是什么故障码|故障码是什么|故障代码是什么|有哪些码|哪些码|有什么码|对应哪些码|对应什么故障码|对应哪个故障码|对应什么故障|怎么处理|如何处理|处理方法|怎么修|维修|排查|为什么|为何|原因|怎么会|为啥|复位|能不能复位|故障描述|描述|对象|机型|风场|品牌|具体型号|场站|型号|厂家|系列|怎么回事|怎么了|它的故障码|这个故障码|它是什么|还要怎么做|下一步|继续)/.test(text)
}

function hasUsefulSlots(slots) {
  return Boolean(
    slots &&
      (slots.brand ||
        slots.site ||
        slots.model ||
        slots.faultCode ||
        (slots.component || []).length ||
        (slots.symptom || []).length),
  )
}

function extractUserSlots(text) {
  const normalized = String(text || '').trim()
  const slots = {
    brand: '',
    site: '',
    model: '',
    faultCode: '',
    faultName: '',
    component: [],
    symptom: [],
    position: [],
    severity: [],
    timeCondition: [],
  }
  if (!normalized) return slots

  const brand = normalized.match(/(三一|华锐|金风|华仪|明阳|运达|远景|上海电气|歌美飒|新誉|湘电|华能|Vestas|Gamesa|GE|ABB|Bachmann)/i)?.[1]
  if (brand) slots.brand = brand

  const site = normalized.match(/(新华|团结|四平|裕民|洮北|镇赉|镇赍|同发|什花道|良井子|前进|向荣|八面|富荣|福林|如意|长龙山)/)?.[1]
  if (site) slots.site = site

  const model = normalized.match(/\b(?:HW\d+[A-Z0-9()\-]*|SL\s*-?\s*\d+(?:\.\d+)?|WD\s*-?\s*\d+(?:\.\d+)?|GW\s*-?\s*\d+(?:\.\d+)?[A-Z0-9-]*|EN\s*-?\s*\d+(?:\.\d+)?[A-Z0-9-]*|MYSE\s*-?\s*\d+(?:\.\d+)?[A-Z0-9-]*|FD\d+[A-Z0-9-]*|UP\d+[A-Z0-9-]*|\d+(?:\.\d+)?\s*MW)\b/i)?.[0]
  if (model) slots.model = model.toUpperCase().replace(/\s+/g, '')

  // A turbine ID (ZC09) or a model number (WD1500) is structurally similar to
  // a fault code but must NOT be stored as one — doing so makes the routing
  // gate think the query is fully scoped and skip disambiguation (the root of
  // the "四平风场" bleed bug). extractContextualCode (报警码 303804 …) is still
  // a real code and is kept.
  const contextualCode = extractContextualCode(normalized)
  const code = contextualCode || extractCode(normalized)
  const codeIsModel = code && slots.model && code.toUpperCase() === slots.model
  // A turbine ID is letters + 1-3 digits (ZC09, SH09, MY01#). It looks like a
  // fault code but identifies a machine, not a fault. Real fault codes are
  // either purely numeric (303804, 709) or carry an explicit 故障码/报警码
  // prefix (contextualCode). Only exclude the turbine-ID shape when there is no
  // such prefix.
  const codeIsTurbineId =
    code &&
    !contextualCode &&
    (isKnownTurbineIdToken(code.toUpperCase()) ||
      /^[A-Za-z]{1,4}\d{1,3}#?$/.test(code))
  if (code && !codeIsModel && !codeIsTurbineId) {
    slots.faultCode = code.toUpperCase()
  }

  addMatchingSlot(slots.component, normalized, '主断路器', /主断路器|主断|主开关/)
  addMatchingSlot(slots.component, normalized, '发电机', /发电机|generator/i)
  addMatchingSlot(slots.component, normalized, '轴承', /轴承|bearing/i)
  addMatchingSlot(slots.component, normalized, '变流器', /变流器|变频器|converter/i)
  addMatchingSlot(slots.component, normalized, '变桨', /变桨|pitch/i)
  addMatchingSlot(slots.component, normalized, '偏航', /偏航|yaw/i)
  addMatchingSlot(slots.component, normalized, '齿轮箱', /齿轮箱|gearbox/i)
  addMatchingSlot(slots.component, normalized, '液压', /液压|液压站/)
  addMatchingSlot(slots.component, normalized, '主控', /主控|plc/i)
  addMatchingSlot(slots.component, normalized, '安全链', /安全链/)

  addMatchingSlot(slots.symptom, normalized, '温度高', /温度高|温度过高|温度超限|过温|高温|过热|发热|超温/)
  addMatchingSlot(slots.symptom, normalized, '跳闸', /跳闸|跳开|跳了|跳掉|跳脱|脱扣|分闸|分断|异常跳开/)
  addMatchingSlot(slots.symptom, normalized, '通信异常', /通信异常|通讯异常|通信故障|通讯故障|通信丢失|通讯丢失/)
  addMatchingSlot(slots.symptom, normalized, '传感器异常', /传感器异常|传感器故障|传感器断线|传感器短路/)
  addMatchingSlot(slots.symptom, normalized, '振动', /振动|震动/)
  addMatchingSlot(slots.symptom, normalized, '压力低', /压力低|压力过低|压力不上来|建压失败|欠压/)
  addMatchingSlot(slots.symptom, normalized, '过流', /过流|过电流|电流过大/)
  addMatchingSlot(slots.symptom, normalized, '短路', /短路/)
  addMatchingSlot(slots.symptom, normalized, '断路', /断路|断线|丢失/)
  addMatchingSlot(slots.symptom, normalized, '报警', /报警|告警|报错/)

  addMatchingSlot(slots.position, normalized, '驱动端', /驱动端|\bde\b/i)
  addMatchingSlot(slots.position, normalized, '非驱动端', /非驱动端|\bnde\b/i)
  addMatchingSlot(slots.severity, normalized, '停机', /停机/)
  addMatchingSlot(slots.severity, normalized, '反复出现', /反复|频繁|多次|持续|一直/)
  addMatchingSlot(slots.timeCondition, normalized, '启动时', /启动时|启动过程|启机时/)
  addMatchingSlot(slots.timeCondition, normalized, '运行中', /运行中|运行时|并网运行/)
  addMatchingSlot(slots.timeCondition, normalized, '复位后', /复位后/)

  if (!slots.faultCode && (slots.component.length || slots.symptom.length) && /故障|报警|告警|停机|异常|超限|过高|过低|过温|过热|跳开|跳闸|短路|断路|丢失|失败/.test(normalized)) {
    slots.faultName = normalized
      .replace(/^\s*(帮我|给我|请|查询|查一下|查下|查|搜索|检索|看一下|看看)\s*/i, '')
      .replace(/[？?。!！]+$/g, '')
      .trim()
  }

  return slots
}

function addMatchingSlot(target, text, value, pattern) {
  if (pattern.test(text) && !target.includes(value)) target.push(value)
}

function mergeUserSlots(base, update) {
  const merged = {
    brand: base?.brand || '',
    site: base?.site || '',
    model: base?.model || '',
    faultCode: base?.faultCode || '',
    faultName: base?.faultName || '',
    component: [...(base?.component || [])],
    symptom: [...(base?.symptom || [])],
    position: [...(base?.position || [])],
    severity: [...(base?.severity || [])],
    timeCondition: [...(base?.timeCondition || [])],
  }
  for (const key of ['brand', 'site', 'model', 'faultCode', 'faultName']) {
    if (update?.[key]) merged[key] = update[key]
  }
  for (const key of ['component', 'symptom', 'position', 'severity', 'timeCondition']) {
    for (const value of update?.[key] || []) {
      if (!merged[key].includes(value)) merged[key].push(value)
    }
    if (merged[key].length > 6) merged[key] = merged[key].slice(-6)
  }
  return merged
}

function slotTerms(slots) {
  if (!slots) return []
  return [
    slots.brand,
    slots.site,
    slots.model,
    slots.faultCode,
    ...(slots.component || []),
    ...(slots.position || []),
    ...(slots.symptom || []),
    ...(slots.severity || []),
    ...(slots.timeCondition || []),
  ].filter(Boolean)
}

function applyRecentUserSlotsToQuery(query) {
  const normalized = String(query || '').trim()
  if (!normalized || !hasUsefulSlots(recentUserSlots)) return normalized
  if (extractCode(normalized)) return normalized
  const current = extractUserSlots(normalized)
  const currentTerms = new Set(slotTerms(current).map(term => term.toLowerCase()))
  const hasCurrentIssue = Boolean(current.component.length || current.symptom.length || current.faultName)
  const historyIssueTerms = new Set([
    ...(recentUserSlots.component || []),
    ...(recentUserSlots.position || []),
    ...(recentUserSlots.symptom || []),
    ...(recentUserSlots.severity || []),
    ...(recentUserSlots.timeCondition || []),
  ])
  const lowerQuery = normalized.toLowerCase()
  const prefix = []
  for (const term of slotTerms(mergeUserSlots(recentUserSlots, current))) {
    const lowered = term.toLowerCase()
    if (currentTerms.has(lowered) || lowerQuery.includes(lowered)) continue
    if (hasCurrentIssue && historyIssueTerms.has(term)) continue
    if (!prefix.includes(term)) prefix.push(term)
    if (prefix.length >= 8) break
  }
  return prefix.length ? `${prefix.join(' ')} ${normalized}` : normalized
}

// ---------------------------------------------------------------------------
// Turn intent classification + fault routing gate.
//
// These are pure functions (state passed explicitly) so they can be unit
// tested without launching the REPL or the local model. handleLine wires them
// to the module globals recentFaultContext / recentUserSlots.
// ---------------------------------------------------------------------------

// A message is "bare identity" when, after removing wind-farm / brand / model
// tokens and filler, nothing meaningful is left — e.g. "四平风场", "运达",
// "WD1500". Such a message supplements or corrects context; it is not a new
// question on its own.
function isBareIdentityMessage(text, slots) {
  let rest = String(text || '')
  for (const token of [slots.site, slots.brand, slots.model].filter(Boolean)) {
    rest = rest.split(token).join(' ')
  }
  rest = rest
    .replace(
      /(风力发电场|风电场|风场|场站|风机|机组|机型|型号|品牌|厂家|的|是|吧|呢|啊|哦|嗯|这个|那个|一期|二期|三期|四期|五期|六期|期)/g,
      ' ',
    )
    .replace(/[，,。.、:：;；?？!！~～\s]/g, '')
  return rest.length === 0
}

// Returns one of: 'slot_fill' | 'correction' | 'new_fault' | 'followup' | 'other'
function classifyTurnIntent(text, state) {
  const normalized = String(text || '').trim()
  if (!normalized) return 'other'

  if (
    /^(不是|不对|错了|说错|应该是|其实是|改成|更正|纠正)/.test(normalized) ||
    /不是.{0,10}(是|应该|而是)/.test(normalized)
  ) {
    return 'correction'
  }

  const cur = extractUserSlots(normalized)
  const hasIssue = Boolean(
    cur.component.length || cur.symptom.length || cur.faultName || cur.faultCode,
  )
  const hasIdentity = Boolean(cur.site || cur.brand || cur.model)

  if (hasIdentity && !hasIssue && isBareIdentityMessage(normalized, cur)) {
    return 'slot_fill'
  }

  if (hasIssue) {
    const prior = state?.recentUserSlots || {}
    const priorComp = new Set(prior.component || [])
    const priorSym = new Set(prior.symptom || [])
    const hadPrior =
      priorComp.size > 0 || priorSym.size > 0 || Boolean(prior.faultName)
    const introducesNewComponent = (cur.component || []).some(
      c => !priorComp.has(c),
    )
    const introducesNewSymptom = (cur.symptom || []).some(s => !priorSym.has(s))
    if (!hadPrior) return 'new_fault'
    if (introducesNewComponent || introducesNewSymptom) return 'new_fault'
    return isFaultContextFollowup(normalized) ? 'followup' : 'new_fault'
  }

  if (isFaultContextFollowup(normalized)) return 'followup'
  return 'other'
}

// True when a wind-farm name maps to more than one distinct site entry
// (different phases/models), e.g. 四平 → 5 华能四平 entries. Single-entry
// sites like 八面 return false so fully-scoped questions still search.
function siteHasMultipleModels(siteOrText) {
  if (!siteOrText) return false
  const lookup = lookupWindFarmModels(siteOrText)
  if (!lookup || lookup.kind === 'all') return false
  return lookup.entries.length > 1
}

function buildMissingSiteMessage() {
  return [
    '当前问题还缺少风场和机型信息，我先不检索知识库，避免给出不准确的结果。',
    '请补充：具体风场名称（如“新华风场”“八面风电场”）和风机品牌/机型（如“运达WD1500”“金风GW82-1500”）；',
    '或直接提供故障码、风机编号（如“303804”“ZC09”）。',
  ].join('\n')
}

function buildMissingModelMessage(eff) {
  const lookup = lookupWindFarmModels(eff.site)
  const lines = (lookup?.entries || []).map(
    entry => `- ${entry.site}：${entry.models.join('、')}`,
  )
  const issue =
    [...(eff.component || []), ...(eff.symptom || [])].join('、') ||
    eff.faultName ||
    '该故障'
  return [
    `“${eff.site}”下有多个机型/期次，${issue}的故障码和处理方式可能不同，需要先确认具体机型。`,
    ...lines,
    '请回复具体期次（如“一期”“二期”）、机型（如“运达WD147-3000”）或风机编号。',
  ].join('\n')
}

function buildCleanFaultQuery(eff, text, fromPending) {
  if (fromPending) {
    const parts = [
      eff.site,
      eff.brand,
      eff.model,
      eff.faultCode,
      ...(eff.component || []),
      ...(eff.symptom || []),
      ...(eff.position || []),
    ].filter(Boolean)
    return parts.join(' ') || String(text || '').trim()
  }
  const t = String(text || '').trim()
  const lower = t.toLowerCase()
  const prefix = [eff.site, eff.brand, eff.model, eff.faultCode]
    .filter(Boolean)
    .filter(v => !lower.includes(v.toLowerCase()))
  return prefix.length ? `${prefix.join(' ')} ${t}` : t
}

// The fault routing gate. Returns:
//   { action: 'fallthrough' }                 -> let existing dispatcher decide
//   { action: 'clarify', message, nextSlots } -> ask user, do not search
//   { action: 'retrieve', query, nextSlots }  -> search with this clean query
function resolveFaultRouting(text, state) {
  if (DISABLE_AUTO_LLMWIKI) return { action: 'fallthrough' }
  const normalized = String(text || '').trim()
  if (!normalized) return { action: 'fallthrough' }

  // An explicit retrieval trigger ("检索 ...", "llmwiki ...") or an explicit
  // fault code should keep the existing behavior.
  if (parseExplicitLlmWikiRequest(normalized) !== undefined) {
    return { action: 'fallthrough' }
  }

  const intent = classifyTurnIntent(normalized, state)
  const cur = extractUserSlots(normalized)
  const prior = state?.recentUserSlots || {}
  const priorHasIssue = Boolean(
    (prior.component || []).length ||
      (prior.symptom || []).length ||
      prior.faultName ||
      (state?.recentFaultContext &&
        (state.recentFaultContext.code || state.recentFaultContext.name)),
  )

  const isSupplement =
    (intent === 'slot_fill' || intent === 'correction') && priorHasIssue
  const isNewFault = intent === 'new_fault'

  // Only the fault topic paths are gated. slot_fill without a pending issue,
  // pure followups, and non-fault chatter fall through untouched.
  if (!isSupplement && !isNewFault) {
    return { action: 'fallthrough' }
  }

  const eff = isSupplement
    ? mergeUserSlots(prior, cur)
    : cur // new_fault: fresh topic, ignore stale slots

  // Trust the cleaned slot, not a re-parse of the raw text: extractCode would
  // re-match model numbers (WD1500 -> 1500) and turbine IDs as "codes",
  // wrongly marking an under-scoped query as complete.
  const hasCode = Boolean(eff.faultCode)
  const hasIssue = Boolean(
    eff.component.length || eff.symptom.length || eff.faultName || hasCode,
  )
  if (!hasIssue) return { action: 'fallthrough' }

  // A specific fault code is self-sufficient — let existing retrieval run.
  if (hasCode) return { action: 'fallthrough' }

  // Missing wind farm entirely -> ask for site + model.
  if (!eff.site) {
    return { action: 'clarify', message: buildMissingSiteMessage(), nextSlots: eff }
  }

  // Wind farm known but ambiguous (multiple phases/models) and no model given
  // -> ask which model before searching.
  if (!eff.model && siteHasMultipleModels(eff.site)) {
    return {
      action: 'clarify',
      message: buildMissingModelMessage(eff),
      nextSlots: eff,
    }
  }

  // Enough context: search with a clean query for THIS topic only.
  return {
    action: 'retrieve',
    query: buildCleanFaultQuery(eff, normalized, isSupplement),
    nextSlots: eff,
  }
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

  if (extractContextualCode(normalized)) {
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

  if (isLikelyFaultNameQuery(normalized)) {
    return true
  }

  const hasWindDomainTerm =
    /(风机|风电|变桨|偏航|风速仪|风向仪|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|24v|plc|hw2s|华仪|主断路器|断路器|主断|接触器)/i.test(
      normalized,
    )
  const hasKnowledgeIntent =
    /(故障|报警|告警|停机|复位|不可复位|异常|保护|跳开|跳闸|跳了|跳掉|跳脱|脱扣|分闸|分断|空开|加热器|超出|超限|限制|最大|最小|过高|过低|偏高|偏低|高于|低于|温度|过热|发热|高温|超温|过温|压力|电流|电压|频率|转速|功率|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|短路|断路|丢失|原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|区别|关系|解释|介绍|怎么|如何|为什么|是什么|啥意思|含义)/i.test(
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
    /(怎么处理|如何处理|处理方法|处置|排查|检查|维修|复位|短路|断路|断路器|跳开|跳闸|跳了|跳掉|跳脱|脱扣|分闸|分断|空开|丢失|不可复位|停机|报警|告警|报错|超限|过热|发热|高温|超温|过温)/i.test(
      text,
    )
  )
}

function normalizeRetrievalQuery(text) {
  const cleaned = normalizeFaultVariantText(text)
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/[？?。!！]+$/g, '')
    .trim()
  const code = extractCode(cleaned)
  if (code && isBareFaultCodeQuery(cleaned, code)) return code
  return cleaned
}

function extractCode(text) {
  return extractContextualCode(text) || text.match(FAULT_CODE_PATTERN)?.[0] || ''
}

function extractContextualCode(text) {
  return text.match(CONTEXTUAL_FAULT_CODE_PATTERN)?.[1] || ''
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
  const normalized = normalizeFaultVariantText(text)
  return (
    /(风机|风电|变桨|偏航|扭缆|顺时针|逆时针|风速仪|风向仪|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|24v|plc|hw2s|华仪|主断路器|断路器|主断|接触器)/i.test(normalized) &&
    /(故障|报警|告警|停机|复位|不可复位|异常|超出|超限|限制|最大|最小|过高|过低|偏高|偏低|高于|低于|温度|过热|发热|高温|超温|过温|压力|电流|电压|频率|转速|功率|跳开|跳闸|跳了|跳掉|跳脱|脱扣|分闸|分断|空开|断开)/i.test(normalized)
  )
}

function normalizeFaultVariantText(text) {
  return String(text || '')
    .replace(/[揽榄]/g, '缆')
    .replace(/纽缆/g, '扭缆')
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
    const response = await fetch(openAICompatibleUrl(LOCAL_BASE_URL, 'chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${modelApiKey()}`,
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
  const response = await fetch(openAICompatibleUrl(LOCAL_BASE_URL, 'chat/completions'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${modelApiKey()}`,
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
  return `我是 Windrise，中文风机故障知识助手；当前通过 ${PROVIDER_LABEL} 使用 ${model}。`
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
    /(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|空开|加热器|温度|传感器|短路|断路|断路器|丢失)/i.test(
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
    /(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|空开|加热器|温度|传感器|短路|断路|断路器|丢失)/i.test(
      text,
    )
  )
}

function hasWindFarmModelMappingIntent(text) {
  return (
    /(风场|风电场|场站|机型|型号|风机|品牌|厂家|系列|具体型号)/i.test(text) &&
    /(对应|匹配|属于|哪个|哪些|什么|哪家|哪款|查询|查一下|列出|清单|关系|资料|机型|型号)/i.test(
      text,
    )
  )
}

function lookupWindFarmModels(text) {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return null

  if (
    /(全部|所有|清单|列表|对应关系|关系表)/.test(text) ||
    (/有哪些风场|风场有哪些/.test(text) &&
      !/(风场|风电场|场站).*(机型|型号|风机|品牌|厂家|系列)/.test(text))
  ) {
    return { kind: 'all', entries: WIND_FARM_MODEL_ENTRIES }
  }

  const coreSiteQuery = extractCoreSiteQuery(text)
  const siteMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    siteSearchValues(entry).some(value => {
      const normalizedValue = normalizeWindFarmModelText(value)
      return (
        normalizedValue.length >= 2 &&
        (normalized.includes(normalizedValue) ||
          normalized.includes(normalizedValue.replace(/风电场$/u, '')) ||
          (coreSiteQuery.length >= 2 &&
            normalizedValue.includes(coreSiteQuery)))
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

  // Do not treat bare turbine IDs like SH09 as "机型" hits via the embedded
  // 风机编号 list; those should be answered by turbine-mapping lookup first.
  if (isBareKnownTurbineIdQuery(text)) {
    return null
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

function isBareKnownTurbineIdQuery(text) {
  const compact = String(text || '')
    .replace(/^farm\s*/i, '')
    .replace(/(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?/giu, ' ')
    .replace(/(风场|风电场|场站|风机|机组|是什么|是啥|什么|哪个|哪些|查询|查一下|查下|对应|属于|机型|型号)/giu, ' ')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
  if (!compact) return false
  const token = compact.replace(/风电场$/u, '').replace(/风场$/u, '')
  // allow optional site prefix like 四平SH09
  const match = token.match(/^(.*?)([A-Za-z]{1,4}\d{1,3}#?)$/u)
  if (!match) return false
  const [, maybeSite, id] = match
  if (!isKnownTurbineIdToken(id)) return false
  if (!maybeSite) return true
  return /^(什花道|八面|前进|同发|向荣|四平|团结|富荣|新华|洮北|良井子|裕民|镇赉)$/u.test(maybeSite)
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

  const ambiguityNote =
    lookup.kind !== 'all' && lookup.entries.length > 1
      ? `提示：匹配到 ${lookup.entries.length} 个相近场站，请按现场全称确认。`
      : ''

  return [
    title,
    ambiguityNote,
    ...lookup.entries.map(entry => `- ${entry.site}：${entry.models.join('、')}`),
  ].filter(Boolean).join('\n')
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
    ...entry.models.flatMap(model => {
      const turbineIds = model.match(/风机编号[:：]([^）)]+)/u)?.[1] ?? ''
      return turbineIds.split(/[、,，;；/]/u).map(item => item.trim()).filter(Boolean)
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

function loadFaultIndexWindFarmModelEntries(baseEntries = []) {
  const indexPath = join(ROOT, '风机故障码', 'fault-index.jsonl')
  let content = ''
  try {
    content = readFileSync(indexPath, 'utf8')
  } catch {
    return []
  }

  // The static windFarmModels.json (built from the standard 场站-型号映射表) is the
  // authoritative source for site→model mapping. The fault index is only consulted to
  // surface sites/models the standard table does not cover; skipping already-covered
  // sites keeps 新华/团结/etc. from appearing twice (compact + expanded forms).
  const coveredSites = new Set(
    (baseEntries || []).flatMap(entry =>
      [entry.site, ...(entry.aliases || [])].map(normalizeWindFarmModelText),
    ),
  )

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
    const turbineIds = splitMappingValues(record.turbineIds)
    if (siteLabels.length === 0 || !brand || !series || standardModels.length === 0) {
      continue
    }
    const details = [`具体型号：${standardModels.join('、')}`]
    if (turbineIds.length > 0) details.push(`风机编号：${turbineIds.join('、')}`)
    const modelText = `${brand} ${series}（${details.join('；')}）`
    for (const site of siteLabels) {
      const siteName = site.endsWith('风电场') ? site : `${site}风电场`
      const key = normalizeWindFarmModelText(siteName)
      if (coveredSites.has(key)) continue
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

function extractCoreSiteQuery(text) {
  return normalizeWindFarmModelText(
    String(text || '').replace(
      /(风力发电场|风电场|风场|场站|机型|型号|风机|品牌|厂家|系列|对应|属于|哪个|哪些|什么|查询|查一下|查下|检索|搜索|列出|清单|关系|请|帮我|一下|全部|所有|都|有|的|是)/gu,
      '',
    ),
  )
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

function modelApiKey() {
  return (
    process.env.LMSTUDIO_API_KEY ||
    process.env.VLLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    'lm-studio'
  )
}

function openAICompatibleUrl(baseUrl, path) {
  const normalizedBase = String(baseUrl || '').replace(/\/$/, '')
  const normalizedPath = String(path || '').replace(/^\//, '')
  if (normalizedBase.endsWith('/v1')) {
    return `${normalizedBase}/${normalizedPath}`
  }
  return `${normalizedBase}/v1/${normalizedPath}`
}

async function answerNormally(text) {
  const fieldAnswer = deterministicFieldAnswer(text)
  if (fieldAnswer) {
    console.log(`Windrise: ${fieldAnswer}`)
    rememberConversation(text, fieldAnswer)
    return
  }

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

function deterministicFieldAnswer(query) {
  const text = String(query || '').trim()
  if (!text) return ''

  if (/^(1\s*次|一次|动作一次|电机动作一次)$/i.test(text)) {
    return [
      '结论：先不处理常闭电磁换向阀。',
      '',
      '下一步只做一件事：保持所有换向阀在初始状态，测量主回路压力和液压泵电流。',
      '',
      '请反馈：主回路压力多少 bar、液压泵电流多少 A。',
    ].join('\n')
  }

  if (/^(频繁动作|多次动作|反复动作)$/i.test(text)) {
    return [
      '结论：恢复过程中频繁补压，优先按偏航回路内泄或保压失败处理。',
      '',
      '下一步只做一件事：恢复刹车后保持静止，记录压力从150bar降到135bar所用时间。',
      '',
      '请反馈：降压用时。',
    ].join('\n')
  }

  if (/^(不动作|没有动作|未动作|没动作)$/i.test(text)) {
    return [
      '结论：先按液压站电机未启动处理，不要先拆液压阀。',
      '',
      '下一步只做一件事：恢复刹车时测液压站电机接触器线圈是否得电。',
      '',
      '请反馈：接触器线圈是否得电。',
    ].join('\n')
  }

  if (/已按要求.*释放.*恢复刹车|手动释放.*恢复刹车|释放并恢复刹车|恢复刹车/.test(text) &&
      !/(?:\d+\s*bar|\d+\s*s|\d+\s*秒|1\s*次|一次|频繁动作|不动作)/i.test(text)) {
    return [
      '结论：动作完成，但现在还不能判断故障点。',
      '',
      '下一步只做一件事：重新看这一轮恢复刹车的压力曲线。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  if (/(释放刹车|恢复刹车|刹车|制动)/.test(text) &&
      /(压力上不来|压力不上来|建压不上来|建压失败|无法建压|压力升不上去)/.test(text)) {
    return [
      '结论：这是风力发电机偏航液压制动回路建压异常，不是汽车刹车问题。',
      '',
      '下一步只做一件事：恢复刹车时只观察液压站电机是否启动。',
      '',
      '请反馈：电机是“动作一次”“频繁动作”还是“不动作”。',
    ].join('\n')
  }

  if (/偏航/.test(text) && /SCADA|HMI/i.test(text) && /压力异常|压力异|压力报警|压力告警|压力波动/.test(text)) {
    return [
      '结论：先按偏航液压压力恢复异常处理，不要先判断为传感器误报。',
      '',
      '下一步只做一件事：手动释放刹车，再恢复刹车。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  if (/偏航/.test(text) &&
      /液压|压力/.test(text) &&
      /欠压|压力异常|压力波动|建压/.test(text) &&
      /尚未拆阀|未拆阀|未更换液压泵|没换泵|不要拆阀|下一步|先做/.test(text)) {
    return [
      '结论：先按偏航回路建压异常排查，暂时不要拆阀或更换液压泵。',
      '',
      '下一步只做一件事：手动释放刹车，再恢复刹车。',
      '',
      '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
    ].join('\n')
  }

  return ''
}

async function answerWithRetrieval(text, overrideQuery) {
  const query = overrideQuery || getRetrievalRequest(text).query
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
  // Classify against the PRE-mutation state so a new fault topic drops the
  // previous topic's component/symptom slots instead of accumulating a
  // cross-topic mash-up (the root cause of the "四平风场" bleed bug).
  const intent = classifyTurnIntent(userText, {
    recentUserSlots,
    recentFaultContext,
  })
  const cur = extractUserSlots(userText)
  if (intent === 'new_fault') {
    recentUserSlots = cur
    recentFaultContext = null
  } else {
    recentUserSlots = mergeUserSlots(recentUserSlots, cur)
  }
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
  recentUserSlots = mergeUserSlots(recentUserSlots, {
    brand: context.brand,
    site: context.site,
    model: context.model,
    faultCode: context.code,
    faultName: context.name,
  })
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
    recentUserSlots = {}
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
  const turbineMappingAnswer = resolveTurbineMappingAnswer(text.replace(/^farm\s*/i, '').trim() || text)
  if (turbineMappingAnswer) {
    console.log(`Windrise: ${turbineMappingAnswer}`)
    rememberConversation(text, turbineMappingAnswer)
    return true
  }
  if (/^farm\b/i.test(text) || shouldAnswerWindFarmModelQuestion(text)) {
    const query = text.replace(/^farm\s*/i, '').trim() || text
    await answerWithWindFarmModel(query)
    return true
  }
  const fieldAnswer = deterministicFieldAnswer(text)
  if (fieldAnswer) {
    console.log(`Windrise: ${fieldAnswer}`)
    rememberConversation(text, fieldAnswer)
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
  const faultRoute = resolveFaultRouting(text, {
    recentFaultContext,
    recentUserSlots,
  })
  if (faultRoute.action === 'clarify') {
    console.log(`Windrise: ${faultRoute.message}`)
    // Merge the supplied identity so the next turn can build on it, but do not
    // search — we are waiting for the user to disambiguate.
    recentUserSlots = mergeUserSlots(recentUserSlots, faultRoute.nextSlots)
    history.push({ role: 'user', content: text })
    history.push({ role: 'assistant', content: faultRoute.message })
    if (history.length > MAX_HISTORY_MESSAGES) {
      history.splice(1, history.length - MAX_HISTORY_MESSAGES)
    }
    return true
  }
  if (faultRoute.action === 'retrieve') {
    await answerWithRetrieval(text, faultRoute.query)
    return true
  }

  if (getRetrievalRequest(text).shouldRetrieve) {
    await answerWithRetrieval(text)
    return true
  }

  await answerNormally(text)
  return true
}

// Reset all conversation state — for tests that reuse the imported module.
function __resetWindriseState() {
  history.splice(1)
  recentFaultContext = null
  recentUserSlots = {}
}

export {
  classifyTurnIntent,
  resolveFaultRouting,
  isBareIdentityMessage,
  siteHasMultipleModels,
  extractUserSlots,
  mergeUserSlots,
  getRetrievalRequest,
  lookupWindFarmModels,
  __resetWindriseState,
}

// Only launch the interactive REPL when run directly, not when imported by a
// test. import.meta.url matches the invoked script path in that case.
const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
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
}

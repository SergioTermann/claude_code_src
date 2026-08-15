#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const windrise = join(root, 'bin', 'windrise')
const faultIndexPath = join(root, 'wind-llmwiki', 'fault-index.jsonl')
const farmModelsPath = join(root, 'src', 'data', 'windFarmModels.json')
const webBaseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'
const reportDir = join(root, 'reports')
const reportPath = join(reportDir, `windrise-200-question-test-${timestampForFile()}.md`)
const modelBaseUrl = process.env.LMSTUDIO_BASE_URL || 'http://10.46.161.210:9527'
const modelName = process.env.LMSTUDIO_MODEL || 'Qwen-30B'
const SYSTEM_ERROR_MARKERS = [
  '暂时无法通过大模型提取知识库检索内容',
  'vLLM 当前不可用或响应超时',
  'Error in input stream',
  'NetworkError',
  '连接在传输过程中中断',
]

const faultRecords = await loadFaultRecords()
const farmModels = JSON.parse(await readFile(farmModelsPath, 'utf8'))
const singleDimensionRecords = faultRecords.filter(record =>
  record.code &&
  record.name &&
  record.site &&
  record.brand &&
  isUsefulFaultName(record.name) &&
  isSingleDimension(record.site) &&
  isSingleDimension(record.brand),
)

const faultGroupsByCode = groupRecords(faultRecords, record => record.code)
const faultGroupsByName = groupRecords(
  faultRecords.filter(record => isUsefulFaultName(record.name)),
  record => normalizeName(record.name),
)

const cliCases = [
  ...buildCodeCases(39),
  ...buildNameToCodeCases(35),
  ...buildSiteQualifiedCodeCases(20),
  ...buildBrandQualifiedNameCases(15),
  ...buildRepairCases(15),
  ...buildReasonResetCases(15),
  ...buildFarmCases(25),
]

const webCases = buildWebCases()
const questionCount =
  cliCases.length + webCases.reduce((sum, testCase) => sum + testCase.turns.length, 0)

if (questionCount !== 200) {
  throw new Error(`Expected exactly 200 questions, generated ${questionCount}`)
}

const startedAt = new Date()
const modelProbe = await probeModelService()
const results = []

console.log(`Windrise 200-question eval started. Report: ${reportPath}`)
console.log(`CLI questions: ${cliCases.length}`)
console.log(`Web conversation turns: ${questionCount - cliCases.length}`)

for (const [index, testCase] of cliCases.entries()) {
  const started = Date.now()
  let answer = ''
  let error = null
  try {
    answer = await runWindrise(testCase.args)
  } catch (caught) {
    error = caught
    answer = String(caught?.stdout || caught?.stderr || caught?.message || caught)
  }
  const result = evaluate({
    id: index + 1,
    type: 'CLI',
    name: testCase.name,
    question: testCase.question,
    expects: testCase.expects,
    rejects: testCase.rejects,
    answer,
    error,
    elapsedMs: Date.now() - started,
  })
  results.push(result)
  printProgress(result)
}

let cookie = null
try {
  cookie = await login()
} catch (caught) {
  const startId = results.length + 1
  let turnIndex = 0
  for (const testCase of webCases) {
    for (const turn of testCase.turns) {
      const result = evaluate({
        id: startId + turnIndex,
        type: 'WEB',
        name: testCase.name,
        question: turn,
        expects: testCase.finalExpects,
        rejects: testCase.finalRejects,
        answer: String(caught?.message || caught),
        error: caught,
        elapsedMs: 0,
      })
      results.push(result)
      printProgress(result)
      turnIndex += 1
    }
  }
}

if (cookie) {
  for (const testCase of webCases) {
    const sessionId = await createSession(testCase.name, cookie)
    const conversationAnswers = []
    for (const [turnIndex, turn] of testCase.turns.entries()) {
      const started = Date.now()
      let answer = ''
      let error = null
      try {
        answer = await ask(turn, sessionId, cookie)
      } catch (caught) {
        error = caught
        answer = String(caught?.message || caught)
      }
      conversationAnswers.push({ turn, answer })

      const isFinalTurn = turnIndex === testCase.turns.length - 1
      const result = evaluate({
        id: results.length + 1,
        type: 'WEB',
        name: `${testCase.name}${isFinalTurn ? '' : ' (intermediate)'}`,
        question: turn,
        expects: isFinalTurn ? testCase.finalExpects : testCase.turnExpects?.[turnIndex] || [],
        rejects: isFinalTurn ? testCase.finalRejects : testCase.turnRejects?.[turnIndex] || [],
        answer,
        error,
        elapsedMs: Date.now() - started,
        conversation: conversationAnswers.map(item => item.turn),
        finalTurn: isFinalTurn,
      })
      results.push(result)
      printProgress(result)
    }
  }
}

await writeReport({ startedAt, finishedAt: new Date(), results })

const failed = results.filter(result => !result.ok)
console.log('')
console.log(`Windrise 200-question eval finished: ${results.length - failed.length}/${results.length} passed.`)
console.log(`Report written: ${reportPath}`)

if (failed.length) {
  process.exit(1)
}

function buildCodeCases(count) {
  return pickSpread(
    [...faultGroupsByCode.entries()]
      .map(([code, records]) => ({ code, records }))
      .filter(group =>
        /^[A-Za-z0-9_./-]{1,12}$/.test(group.code) &&
        group.records.some(record => isUsefulFaultName(record.name)),
      ),
    count,
  ).map(group => {
    const record = group.records.find(item => isUsefulFaultName(item.name))
    return {
      name: `故障码正查 ${group.code}`,
      question: `故障码${group.code}是什么`,
      args: ['search', `故障码${group.code}是什么`],
      expects: [group.code, safeExpectName(record.name)],
      rejects: unrelatedCodeRejects(group.code),
    }
  })
}

function buildNameToCodeCases(count) {
  return pickSpread(
    [...faultGroupsByName.entries()]
      .map(([name, records]) => ({ name, records }))
      .filter(group => {
        const codes = uniqueValues(group.records.map(record => record.code))
        const sites = uniqueSites(group.records)
        return codes.length >= 1 && codes.length <= 4 && sites.length >= 1 && sites.length <= 8
      }),
    count,
  ).map(group => {
    const displayName = group.records[0].name
    const codes = uniqueValues(group.records.map(record => record.code)).slice(0, 4)
    const sites = uniqueSites(group.records).slice(0, 6)
    return {
      name: `故障名称反查 ${displayName}`,
      question: `${displayName}是什么故障码，哪些风场有`,
      args: ['search', `${displayName}是什么故障码，哪些风场有`],
      expects: [safeExpectName(displayName), ...codes, ...sites],
    }
  })
}

function buildSiteQualifiedCodeCases(count) {
  return pickSpread(singleDimensionRecords, count).map(record => ({
    name: `风场+故障码 ${record.site} ${record.code}`,
    question: `${record.site}风场${record.code}是什么故障`,
    args: ['search', `${record.site}风场${record.code}是什么故障`],
    expects: [record.code, record.site, safeExpectName(record.name)],
    rejects: unrelatedCodeRejects(record.code),
  }))
}

function buildBrandQualifiedNameCases(count) {
  return pickSpread(
    singleDimensionRecords.filter(record => record.name.length >= 4),
    count,
  ).map(record => ({
    name: `品牌+故障名称 ${record.brand} ${record.name}`,
    question: `${record.brand}${record.name}是什么码`,
    args: ['search', `${record.brand}${record.name}是什么码`],
    expects: [record.code, record.brand, safeExpectName(record.name)],
  }))
}

function buildRepairCases(count) {
  return pickSpread(
    singleDimensionRecords.filter(record => record.solution && record.name.length >= 4),
    count,
  ).map(record => ({
    name: `处理建议 ${record.name}`,
    question: `${record.name}怎么处理`,
    args: ['search', `${record.name}怎么处理`],
    expects: [record.code, safeExpectName(record.name), '处理'],
  }))
}

function buildReasonResetCases(count) {
  return pickSpread(singleDimensionRecords, count).map((record, index) => {
    const question = index % 2 === 0
      ? `${record.code}为什么会报`
      : `${record.code}怎么复位`
    return {
      name: `原因/复位 ${record.code}`,
      question,
      args: ['search', question],
      expects: [record.code, safeExpectName(record.name)],
    }
  })
}

function buildFarmCases(count) {
  return farmModels.slice(0, count).map(farm => {
    const alias = farm.aliases?.[0] || farm.site
    const expectedSite = String(farm.site || alias).replace(/[()（）/].*$/, '')
    const expectedModel = String(farm.models?.[0] || farm.standardModels?.[0] || '').split('（')[0].trim()
    return {
      name: `风场机型 ${farm.site}`,
      question: `${alias}有哪些风机机型`,
      args: ['farm', `${alias}有哪些风机机型`],
      expects: [expectedSite.slice(0, 2), expectedModel].filter(Boolean),
      rejects: ['故障代码：', '故障名称：'],
    }
  })
}

function buildWebCases() {
  return [
    {
      name: '多轮：故障码处理复位保持上下文',
      turns: ['303804是什么故障', '怎么处理', '怎么复位'],
      finalExpects: ['303804', '24V主电源开关故障', '复位'],
      finalRejects: ['参数读取错误', '顺时针扭缆'],
    },
    {
      name: '多轮：短故障码追加风场维度',
      turns: ['80是什么故障', '团结风电场'],
      finalExpects: ['80', '未找到与', '镇赉', '同发'],
      finalRejects: ['5980', '偏航刹车打压超时', '机型清单'],
    },
    {
      name: '多轮：检索结果按风场品牌收敛',
      turns: ['轴承温度过高，且反复报错，或异响，震动噪声过大是什么原因造成的', '新华风场运达风机'],
      finalExpects: ['新华', '运达', 'WD1500', '轴承温度'],
      finalRejects: ['SS-0 保险断开', '查询结果： - 新华风电场'],
    },
    {
      name: '多轮：错别字故障名追问处理',
      turns: ['顺时针扭揽超限停机是什么故障码', '这个怎么处理'],
      finalExpects: ['709', '顺时针扭缆', '解缆'],
      finalRejects: ['2038', '轴承温度', '24V主电源'],
    },
    {
      name: '多轮：新显式故障覆盖旧上下文',
      turns: ['303804是什么故障', '709是什么故障', '怎么处理'],
      finalExpects: ['709', '顺时针', '扭缆'],
      finalRejects: ['303804', '24V主电源开关故障'],
    },
    {
      name: '多轮：相似名称按品牌切换',
      turns: ['运达风速仪故障是什么码', '华仪风速仪故障是什么码', '这个怎么处理'],
      finalExpects: ['170010', '华仪', '风速仪故障'],
      finalRejects: ['5307 为', '运达风速仪'],
    },
    {
      name: '多轮：风场机型查询不覆盖故障上下文',
      turns: ['303804是什么故障', '新华风场有哪些风机机型', '刚才那个故障怎么复位'],
      finalExpects: ['303804', '24V主电源开关故障', '复位'],
      finalRejects: ['同发风电场', '参数读取错误'],
    },
    {
      name: '多轮：未知故障码不借用旧上下文',
      turns: ['303804是什么故障', '999999是什么故障'],
      finalExpects: ['999999'],
      finalRejects: ['24V主电源开关故障', '风场：', '品牌：', '机型：'],
    },
    {
      name: '多轮：无效故障名不过度匹配',
      turns: ['不存在的扭缆超级故障是什么码'],
      finalExpects: ['未找到'],
      finalRejects: ['800017', '709：', '顺时针扭缆超限停机'],
    },
    {
      name: '多轮：故障码覆盖风场追问',
      turns: ['709是什么故障', '这个码哪些风场有', '怎么复位'],
      finalExpects: ['709', '复位'],
      finalRejects: ['303804', '24V主电源'],
    },
    {
      name: '多轮：独立会话无旧故障上下文',
      turns: ['怎么复位'],
      finalExpects: [],
      finalRejects: ['303804', '709', '170010', '24V主电源开关故障'],
    },
    {
      name: '多轮：维护状态短码追问原因',
      turns: ['7是什么故障', '为什么会报'],
      finalExpects: ['7', '风机维护状态'],
      finalRejects: ['303807', '307'],
    },
    {
      name: '多轮：数字前缀名称不误当故障码',
      turns: ['50刹车失败是什么故障码', '哪些风场有'],
      finalExpects: ['431', '刹车失败'],
      finalRejects: ['故障码 50', '参数读取错误'],
    },
    {
      name: '多轮：风场问题独立回答机型',
      turns: ['新华风场有哪些风机机型'],
      finalExpects: ['新华风电场', 'WD1500'],
      finalRejects: ['同发风电场', '故障代码：'],
    },
    {
      name: '多轮：直接处理故障名',
      turns: ['顺时针扭缆超限停机怎么处理'],
      finalExpects: ['709', '顺时针扭缆', '解缆'],
      finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
    },
    {
      name: '多轮：报警名称反查代码再复位',
      turns: ['变桨24V主电源开关故障是什么码', '怎么复位'],
      finalExpects: ['303804', '24V主电源开关故障'],
      finalRejects: ['303809', '303810', '303811'],
    },
    {
      name: '多轮：风场机型后新故障覆盖',
      turns: ['新华风场有哪些风机机型', '709是什么故障', '怎么处理'],
      finalExpects: ['709', '顺时针', '扭缆'],
      finalRejects: ['WD1500', '303804'],
    },
  ]
}

async function loadFaultRecords() {
  const content = await readFile(faultIndexPath, 'utf8')
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(record => record.code && record.name)
}

async function runWindrise(args) {
  const { stdout } = await execFileAsync(windrise, args, {
    cwd: root,
    env: buildEnv(),
    maxBuffer: 40 * 1024 * 1024,
    timeout: 120_000,
  })
  return stdout
}

function buildEnv() {
  return {
    ...process.env,
    LLMWIKI_PROJECT: join(root, 'wind-llmwiki'),
    ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
    WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
    LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
    LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
    LMSTUDIO_CHAT_MODEL:
      process.env.LMSTUDIO_CHAT_MODEL ||
      process.env.LMSTUDIO_MODEL ||
      'qwen/qwen3.5-9b',
    WINDRISE_ENABLE_THINKING: '0',
    MAX_THINKING_TOKENS: '0',
    DISABLE_INSTALLATION_CHECKS: '1',
  }
}

async function login() {
  const response = await fetch(`${webBaseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!response.ok) throw new Error(`login failed: ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('login did not return a session cookie')
  return setCookie.split(';')[0]
}

async function createSession(title, cookie) {
  const response = await fetch(`${webBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) throw new Error(`create session failed: ${response.status}`)
  const payload = await response.json()
  if (!payload.success || !payload.session_id) {
    throw new Error(`create session returned invalid payload: ${JSON.stringify(payload)}`)
  }
  return payload.session_id
}

async function ask(message, sessionId, cookie) {
  const response = await fetch(`${webBaseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      message,
      response_mode: 'blocking',
      user: 'admin',
      session_id: sessionId,
    }),
  })
  if (!response.ok) throw new Error(`chat failed for ${message}: ${response.status}`)
  const payload = await response.json()
  return String(payload.answer || '')
}

function evaluate({ id, type, name, question, expects = [], rejects = [], answer = '', error = null, elapsedMs, conversation = [], finalTurn = true }) {
  const missing = expects.filter(needle => needle && !answer.includes(needle))
  const bad = rejects.filter(needle => needle && answer.includes(needle))
  const systemErrors = SYSTEM_ERROR_MARKERS.filter(marker => answer.includes(marker))
  const ok = !error && missing.length === 0 && bad.length === 0 && systemErrors.length === 0
  return {
    id,
    type,
    name,
    question,
    ok,
    missing,
    bad,
    systemErrors,
    expects,
    rejects,
    answer,
    error: error ? String(error?.message || error) : '',
    elapsedMs,
    conversation,
    finalTurn,
  }
}

function printProgress(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  console.log(`${String(result.id).padStart(3, '0')} ${status} [${result.type}] ${result.question}`)
  if (!result.ok) {
    if (result.error) console.log(`    error: ${result.error}`)
    if (result.missing.length) console.log(`    missing: ${result.missing.join(' | ')}`)
    if (result.bad.length) console.log(`    rejected present: ${result.bad.join(' | ')}`)
    console.log(`    answer: ${clip(result.answer, 360)}`)
  }
}

async function writeReport({ startedAt, finishedAt, results }) {
  await mkdir(reportDir, { recursive: true })
  const failed = results.filter(result => !result.ok)
  const passed = results.length - failed.length
  const byType = [...new Set(results.map(result => result.type))]
    .map(type => {
      const typed = results.filter(result => result.type === type)
      const typedFailed = typed.filter(result => !result.ok)
      return `- ${type}: ${typed.length - typedFailed.length}/${typed.length} 通过`
    })
    .join('\n')

  const lines = [
    '# Windrise 200 问检索与上下文测试报告',
    '',
    `- 测试时间：${formatDate(startedAt)} - ${formatDate(finishedAt)}`,
    `- 测试入口：CLI \`bin/windrise\` + Web \`${webBaseUrl}\``,
    `- vLLM：\`${modelBaseUrl}\` / \`${modelName}\`，探测结果：${modelProbe.ok ? '可访问' : `不可访问（${modelProbe.detail}）`}`,
    `- 知识库：\`wind-llmwiki/fault-index.jsonl\`，当前记录数 ${faultRecords.length}`,
    `- 总问题数：${results.length}`,
    `- 总体结果：${passed}/${results.length} 通过，${failed.length} 失败`,
    '',
    '## 分项结果',
    '',
    byType,
    '',
    '## 失败项',
    '',
    failed.length
      ? failed.map(formatFailure).join('\n\n')
      : '无失败项。',
    '',
    '## 全量问题清单',
    '',
    '| # | 类型 | 结果 | 问题 | 校验点 | 用时 |',
    '|---:|---|---|---|---|---:|',
    ...results.map(result => {
      const checks = [
        result.expects.length ? `应包含：${result.expects.join('、')}` : '',
        result.rejects.length ? `不应包含：${result.rejects.join('、')}` : '',
      ].filter(Boolean).join('<br>')
      return `| ${result.id} | ${result.type} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.question)} | ${escapeTable(checks || '-')} | ${Math.round(result.elapsedMs)}ms |`
    }),
    '',
    '## 完整问题与回答原文',
    '',
    ...results.map(result => [
      `### ${result.id}. ${result.ok ? '通过' : '失败'} ${result.type}：${result.question}`,
      '',
      result.conversation.length ? `对话上下文：${result.conversation.join(' -> ')}` : '',
      '',
      '**问题原文**',
      '',
      '~~~~~~text',
      result.question,
      '~~~~~~',
      '',
      `**回答原文（${result.answer.length} 个字符）**`,
      '',
      '~~~~~~text',
      result.answer,
      '~~~~~~',
      '',
    ].filter(line => line !== '').join('\n')),
  ]

  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8')
}

function formatFailure(result) {
  const lines = [
    `### ${result.id}. ${result.type} ${result.name}`,
    '',
    `- 问题：${result.question}`,
    result.conversation.length ? `- 对话上下文：${result.conversation.join(' -> ')}` : '',
    result.error ? `- 错误：${result.error}` : '',
    result.missing.length ? `- 缺失：${result.missing.join('、')}` : '',
    result.bad.length ? `- 不应出现但出现：${result.bad.join('、')}` : '',
    result.systemErrors.length ? `- 系统异常：${result.systemErrors.join('、')}` : '',
    '',
    '~~~~~~text',
    result.answer,
    '~~~~~~',
  ]
  return lines.filter(Boolean).join('\n')
}

async function probeModelService() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`${modelBaseUrl.replace(/\/$/, '')}/v1/models`, {
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    return { ok: true, detail: `HTTP ${response.status}` }
  } catch (error) {
    return {
      ok: false,
      detail: error?.name === 'AbortError' ? '连接超时' : String(error?.message || error),
    }
  } finally {
    clearTimeout(timer)
  }
}

function groupRecords(records, keyFn) {
  const groups = new Map()
  for (const record of records) {
    const key = keyFn(record)
    if (!key) continue
    const group = groups.get(key) || []
    group.push(record)
    groups.set(key, group)
  }
  return groups
}

function pickSpread(items, count) {
  if (items.length < count) {
    throw new Error(`Could only pick ${items.length}/${count} records`)
  }
  const picked = []
  const step = items.length / count
  const seen = new Set()
  for (let index = 0; picked.length < count && index < count * 3; index += 1) {
    const itemIndex = Math.min(items.length - 1, Math.floor(index * step))
    if (seen.has(itemIndex)) continue
    seen.add(itemIndex)
    picked.push(items[itemIndex])
  }
  for (let index = 0; picked.length < count && index < items.length; index += 1) {
    if (seen.has(index)) continue
    picked.push(items[index])
  }
  return picked
}

function uniqueValues(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function uniqueSites(records) {
  return uniqueValues(records.flatMap(record => splitDimension(record.site)))
}

function splitDimension(value) {
  return String(value || '').split(/[、,，/]/).map(item => item.trim()).filter(Boolean)
}

function isUsefulFaultName(name) {
  const text = String(name || '').trim()
  return (
    text.length >= 2 &&
    text.length <= 36 &&
    !/[。；;]/.test(text) &&
    !text.includes('触发条件') &&
    !text.includes('产生原因') &&
    !text.includes('刹车级别')
  )
}

function isSingleDimension(value) {
  return Boolean(value) && splitDimension(value).length === 1
}

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, '').trim()
}

function safeExpectName(name) {
  return String(name).replace(/\s+/g, ' ').slice(0, 16)
}

function unrelatedCodeRejects(code) {
  const value = String(code)
  if (value.length <= 2) return ['0100001']
  if (value.length <= 3) return [`5${value}`]
  return []
}

function clip(text, limit = 1200) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function escapeTable(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

function formatDate(date) {
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

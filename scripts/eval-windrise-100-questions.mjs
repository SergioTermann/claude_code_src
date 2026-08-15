#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const windrise = join(root, 'bin', 'windrise')
const faultIndexPath = join(root, 'wind-llmwiki', 'fault-index.jsonl')
const farmModelsPath = join(root, 'src', 'data', 'windFarmModels.json')
const webBaseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5002'

const records = await loadFaultRecords()
const farmModels = JSON.parse(await readFile(farmModelsPath, 'utf8'))
const singleSiteRecords = records.filter(record =>
  record.code &&
  record.name &&
  record.site &&
  record.brand &&
  /^[A-Za-z0-9_./-]{1,12}$/.test(record.code) &&
  isUsefulFaultName(record.name) &&
  isSingleDimension(record.site) &&
  isSingleDimension(record.brand),
)

const cliCases = [
  ...buildCodeCases(20),
  ...buildNameLookupCases(20),
  ...buildBrandQualifiedCases(10),
  ...buildSiteQualifiedCases(10),
  ...buildRepairCases(5),
  ...buildReasonResetCases(5),
  ...buildFarmCases(10),
]

const webCases = [
  {
    name: 'web 303804 repair/reset followups',
    turns: ['303804是什么故障', '怎么处理', '怎么复位'],
    expects: ['303804', '24V主电源开关故障', '复位'],
    rejects: ['参数读取错误', '顺时针扭缆'],
  },
  {
    name: 'web short code then site dimension miss',
    turns: ['80是什么故障', '团结风电场'],
    expects: ['80', '未找到与', '镇赉', '同发'],
    rejects: ['查询结果：', '5980', '偏航刹车打压超时'],
  },
  {
    name: 'web bearing result memory narrows by farm and brand',
    turns: ['轴承温度过高，且反复报错，或异响，震动噪声过大是什么原因造成的', '新华风场运达风机'],
    expects: ['新华', '运达', 'WD1500', '轴承温度'],
    rejects: ['查询结果： - 新华风电场', 'SS-0 保险断开'],
  },
  {
    name: 'web typo fault-name repair followup',
    turns: ['顺时针扭揽超限停机是什么故障码', '这个怎么处理'],
    expects: ['709', '顺时针扭缆', '解缆'],
    rejects: ['2038', '轴承温度', '24V主电源'],
  },
  {
    name: 'web farm model query does not erase fault context',
    turns: ['303804是什么故障', '新华风场有哪些风机机型', '刚才那个故障怎么复位'],
    expects: ['303804', '24V主电源开关故障', '复位'],
    rejects: ['查询结果：', '同发风电场', '参数读取错误'],
  },
  {
    name: 'web brand switch between same-name faults',
    turns: ['运达风速仪故障是什么码', '华仪风速仪故障是什么码', '这个怎么处理'],
    expects: ['170010', '华仪', '风速仪故障'],
    rejects: ['5307 为', '运达风速仪'],
  },
  {
    name: 'web unknown code does not borrow old context',
    turns: ['999999是什么故障'],
    expects: ['999999'],
    rejects: ['303804', '24V主电源开关故障', '风场：', '品牌：', '机型：'],
  },
  {
    name: 'web nonsense name does not overmatch real fault',
    turns: ['不存在的扭缆超级故障是什么码'],
    expects: ['未找到'],
    rejects: ['800017', '709：', '顺时针扭缆超限停机'],
  },
  {
    name: 'web code coverage followup',
    turns: ['709是什么故障', '这个码哪些风场有'],
    expects: ['709', '裕民', '什花道', '新华', '洮北'],
    rejects: ['303804', '24V主电源'],
  },
  {
    name: 'web independent session has no old fault context',
    turns: ['怎么复位'],
    expects: [],
    rejects: ['303804', '709', '170010', '24V主电源开关故障'],
  },
]

const questionCount =
  cliCases.length + webCases.reduce((sum, item) => sum + item.turns.length, 0)
if (questionCount !== 100) {
  throw new Error(`Expected exactly 100 questions, generated ${questionCount}`)
}

let failures = 0
console.log('100 questions under test:')
let questionIndex = 1
for (const testCase of cliCases) {
  console.log(`${String(questionIndex++).padStart(3, '0')}. ${testCase.question}`)
}
for (const testCase of webCases) {
  for (const turn of testCase.turns) {
    console.log(`${String(questionIndex++).padStart(3, '0')}. ${turn}`)
  }
}
console.log('')

for (const testCase of cliCases) {
  const stdout = await runWindrise(testCase.args)
  reportResult(testCase.name, testCase.expects, testCase.rejects, stdout)
}

const cookie = await login()
for (const testCase of webCases) {
  const sessionId = await createSession(testCase.name, cookie)
  let answer = ''
  for (const turn of testCase.turns) {
    answer = await ask(turn, sessionId, cookie)
  }
  reportResult(testCase.name, testCase.expects, testCase.rejects, answer)
}

if (failures) {
  console.error(`\n${failures} case(s) failed across 100 questions.`)
  process.exit(1)
}

console.log('\nWindrise 100-question eval passed.')

function buildCodeCases(count) {
  return pickUniqueBy(singleSiteRecords, record => record.code, count).map(record => ({
    name: `code lookup ${record.code}`,
    question: `故障码${record.code}是什么`,
    args: ['search', `故障码${record.code}是什么`],
    expects: [record.code, safeExpectName(record.name)],
    rejects: unrelatedCodeRejects(record.code),
  }))
}

function buildNameLookupCases(count) {
  return pickUniqueBy(
    singleSiteRecords.filter(record => record.name.length >= 4),
    record => `${record.name}:${record.code}`,
    count,
  ).map(record => ({
    name: `name to code ${record.code}`,
    question: `${record.name}是什么故障码`,
    args: ['search', `${record.name}是什么故障码`],
    expects: [record.code, safeExpectName(record.name)],
  }))
}

function buildBrandQualifiedCases(count) {
  return pickUniqueBy(
    singleSiteRecords.filter(record => record.name.length >= 4),
    record => `${record.brand}:${record.name}:${record.code}`,
    count,
  ).map(record => ({
    name: `brand name to code ${record.brand} ${record.code}`,
    question: `${record.brand}${record.name}是什么码`,
    args: ['search', `${record.brand}${record.name}是什么码`],
    expects: [record.code, record.brand, safeExpectName(record.name)],
  }))
}

function buildSiteQualifiedCases(count) {
  return pickUniqueBy(
    singleSiteRecords.filter(record => record.site.length >= 2),
    record => `${record.site}:${record.code}`,
    count,
  ).map(record => ({
    name: `site code lookup ${record.site} ${record.code}`,
    question: `${record.site}风场${record.code}是什么故障`,
    args: ['search', `${record.site}风场${record.code}是什么故障`],
    expects: [record.code, record.site, safeExpectName(record.name)],
  }))
}

function buildRepairCases(count) {
  return pickUniqueBy(
    singleSiteRecords.filter(record => record.solution && record.name.length >= 4),
    record => `repair:${record.name}:${record.code}`,
    count,
  ).map(record => ({
    name: `repair by name ${record.code}`,
    question: `${record.name}怎么处理`,
    args: ['search', `${record.name}怎么处理`],
    expects: [record.code, safeExpectName(record.name), '处理'],
  }))
}

function buildReasonResetCases(count) {
  return pickUniqueBy(
    singleSiteRecords.filter(record => record.name.length >= 4),
    record => `reason-reset:${record.name}:${record.code}`,
    count,
  ).map((record, index) => {
    const question = index % 2 === 0
      ? `${record.code}为什么会报`
      : `${record.code}怎么复位`
    return {
      name: `reason/reset by code ${record.code}`,
      question,
      args: ['search', question],
      expects: [record.code, safeExpectName(record.name)],
    }
  })
}

function buildFarmCases(count) {
  return farmModels.slice(0, count).map(farm => {
    const alias = farm.aliases?.[0] || farm.site
    const expectedModel = String(farm.models?.[0] || '').split('（')[0].trim()
    return {
      name: `farm model ${farm.site}`,
      question: `${alias}有哪些风机机型`,
      args: ['farm', `${alias}有哪些风机机型`],
      expects: [farm.site.replace(/[()（）/].*$/, '').slice(0, 2), expectedModel].filter(Boolean),
    }
  })
}

async function loadFaultRecords() {
  const content = await readFile(faultIndexPath, 'utf8')
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(record => record.code && record.name)
}

function pickUniqueBy(items, keyFn, count) {
  const picked = []
  const seen = new Set()
  for (const item of items) {
    const key = keyFn(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    picked.push(item)
    if (picked.length >= count) break
  }
  if (picked.length < count) {
    throw new Error(`Could only pick ${picked.length}/${count} records`)
  }
  return picked
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
  return Boolean(value) && !/[、,，/]/.test(String(value))
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

async function runWindrise(args) {
  const { stdout } = await execFileAsync(windrise, args, {
    cwd: root,
    env: buildEnv(),
    maxBuffer: 30 * 1024 * 1024,
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

function reportResult(name, expects = [], rejects = [], answer = '') {
  const missing = expects.filter(needle => needle && !answer.includes(needle))
  const bad = rejects.filter(needle => needle && answer.includes(needle))
  const ok = missing.length === 0 && bad.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (bad.length) console.log(`  rejected present: ${bad.join(' | ')}`)
    console.log(`  answer: ${clip(answer)}`)
  }
}

function clip(text, limit = 1200) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

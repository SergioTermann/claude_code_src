#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const faultIndexPath = join(root, 'wind-llmwiki', 'fault-index.jsonl')
const reportDir = join(root, 'reports')
const reportPath = join(reportDir, `windrise-constraint-switch-${timestampForFile()}.md`)
const webBaseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5012'

const records = await loadRecords()
const cases = buildCases(records)
const startedAt = new Date()
const cookie = await login()
const results = []
let questionId = 1

console.log(`Windrise constraint-switch eval started. Report: ${reportPath}`)
console.log(`Web: ${webBaseUrl}`)
console.log(`Cases: ${cases.length}, turns: ${cases.reduce((sum, item) => sum + item.turns.length, 0)}`)

for (const testCase of cases) {
  const sessionId = await createSession(testCase.name, cookie)
  const conversation = []
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
    conversation.push(turn)
    const finalTurn = turnIndex === testCase.turns.length - 1
    const expects = finalTurn ? testCase.finalExpects : testCase.turnExpects?.[turnIndex] || []
    const rejects = finalTurn ? testCase.finalRejects : testCase.turnRejects?.[turnIndex] || []
    const result = evaluate({
      id: questionId++,
      caseId: testCase.id,
      type: testCase.type,
      name: testCase.name,
      turnIndex: turnIndex + 1,
      question: turn,
      expects,
      rejects,
      answer,
      error,
      elapsedMs: Date.now() - started,
      finalTurn,
      conversation: [...conversation],
      target: testCase.target,
      stale: testCase.stale,
    })
    results.push(result)
    printProgress(result)
  }
}

await writeReport({ startedAt, finishedAt: new Date(), cases, results })

const failed = results.filter(result => !result.ok)
const finalResults = results.filter(result => result.finalTurn)
const finalFailed = finalResults.filter(result => !result.ok)

console.log('')
console.log(`Windrise constraint-switch eval finished: ${results.length - failed.length}/${results.length} turns passed.`)
console.log(`Final-turn locating accuracy: ${finalResults.length - finalFailed.length}/${finalResults.length}`)
console.log(`Report written: ${reportPath}`)

if (failed.length) {
  process.exit(1)
}

async function loadRecords() {
  const lines = (await readFile(faultIndexPath, 'utf8')).split(/\r?\n/).filter(Boolean)
  const all = lines.map(line => JSON.parse(line))
  const usable = all.filter(record =>
    record.code &&
    record.name &&
    record.site &&
    record.brand &&
    record.model &&
    record.standardModel &&
    isSingleDimension(record.site) &&
    isSingleDimension(record.brand) &&
    isUsefulFaultName(record.name) &&
    String(record.standardModel).length <= 52,
  )
  const seen = new Set()
  const deduped = []
  for (const record of usable) {
    const key = [
      normalize(record.site),
      normalize(record.brand),
      normalize(record.model),
      normalize(record.standardModel),
      normalize(record.code),
      normalize(record.name),
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push({
      code: String(record.code),
      name: String(record.name),
      site: String(record.site),
      brand: String(record.brand),
      model: String(record.model),
      standardModel: String(record.standardModel),
    })
  }
  deduped.sort((a, b) =>
    `${a.brand}|${a.site}|${a.model}|${a.standardModel}|${a.code}`.localeCompare(
      `${b.brand}|${b.site}|${b.model}|${b.standardModel}|${b.code}`,
      'zh-CN',
    ),
  )
  return deduped
}

function buildCases(allRecords) {
  const byBrand = new Map()
  for (const record of allRecords) {
    if (!byBrand.has(record.brand)) byBrand.set(record.brand, [])
    byBrand.get(record.brand).push(record)
  }
  const brands = [...byBrand.keys()].filter(brand => byBrand.get(brand).length >= 8)
  const cases = []

  for (let index = 0; index < 10; index += 1) {
    const oldBrand = brands[index % brands.length]
    const newBrand = brands[(index + 3) % brands.length]
    const stale = pickSpread(byBrand.get(oldBrand), 10, index)[0]
    const target = pickSpread(byBrand.get(newBrand), 10, index + 2).find(item => item.code !== stale.code && item.name !== stale.name)
    cases.push(buildCorrectionCase(cases.length + 1, stale, target))
  }

  for (let index = 0; index < 10; index += 1) {
    const brand = brands[(index * 2) % brands.length]
    const target = pickSpread(byBrand.get(brand), 10, index + 5)[0]
    cases.push(buildBrandLockedCase(cases.length + 1, target))
  }

  for (let index = 0; index < 10; index += 1) {
    const brand = brands[(index * 3 + 1) % brands.length]
    const target = pickSpread(byBrand.get(brand), 10, index + 9)[0]
    cases.push(buildFuzzyThenExactCase(cases.length + 1, target))
  }

  for (let index = 0; index < 10; index += 1) {
    const brand = brands[(index * 4 + 2) % brands.length]
    const target = pickSpread(byBrand.get(brand), 10, index + 13)[0]
    cases.push(buildModelFirstCase(cases.length + 1, target))
  }

  return cases
}

function buildCorrectionCase(id, stale, target) {
  return {
    id,
    type: '纠错切换',
    name: `纠错切换 ${stale.brand}->${target.brand} ${target.code}`,
    stale,
    target,
    turns: [
      `先记录厂家${stale.brand}，风场${stale.site}，机型${stale.model}，具体型号${stale.standardModel}`,
      `告警内容是${stale.name}`,
      `刚才说错了，厂家改成${target.brand}，风场改成${target.site}，机型改成${target.model}，具体型号改成${target.standardModel}`,
      `现在报的是${target.name}，请按最新厂家、风场、机型和具体型号最终定位`,
    ],
    turnExpects: [[stale.brand, stale.site], [safeExpectName(stale.name)], [target.brand, target.site, target.model]],
    finalExpects: targetExpects(target),
    finalRejects: [stale.code, safeExpectName(stale.name), '本地知识库暂未找到', '通用风机运维知识'],
  }
}

function buildBrandLockedCase(id, target) {
  return {
    id,
    type: '厂家硬约束',
    name: `厂家硬约束 ${target.brand} ${target.code}`,
    target,
    turns: [
      `厂家先限定为${target.brand}`,
      `风场${target.site}，机型${target.model}`,
      `具体型号${target.standardModel}`,
      `${loosenFaultName(target.name)}是什么故障码，请不要跨厂家回答`,
    ],
    turnExpects: [[target.brand], [target.site, target.model], [target.standardModel]],
    finalExpects: targetExpects(target),
    finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
  }
}

function buildFuzzyThenExactCase(id, target) {
  return {
    id,
    type: '模糊后补全',
    name: `模糊后补全 ${target.brand}/${target.site} ${target.code}`,
    target,
    turns: [
      `${fuzzyFaultName(target.name)}，先帮我记住这个现象`,
      `厂家${target.brand}`,
      `风场${target.site}，机型${target.model}`,
      `具体型号${target.standardModel}，完整告警是${target.name}，请最终定位`,
    ],
    turnExpects: [[safeExpectName(fuzzyFaultName(target.name))], [target.brand], [target.site, target.model]],
    finalExpects: targetExpects(target),
    finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
  }
}

function buildModelFirstCase(id, target) {
  return {
    id,
    type: '机型优先',
    name: `机型优先 ${target.model} ${target.code}`,
    target,
    turns: [
      `这台风机机型是${target.model}`,
      `具体型号是${target.standardModel}`,
      `厂家${target.brand}，风场${target.site}`,
      `故障描述：${target.name}，请最终定位故障码`,
    ],
    turnExpects: [[target.model], [target.standardModel], [target.brand, target.site]],
    finalExpects: targetExpects(target),
    finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
  }
}

async function login() {
  const response = await fetch(`${webBaseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`)
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
  if (!response.ok) throw new Error(`create session failed: ${response.status} ${await response.text()}`)
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
  if (!response.ok) throw new Error(`chat failed for ${message}: ${response.status} ${await response.text()}`)
  const payload = await response.json()
  return String(payload.answer || '')
}

function evaluate({ id, caseId, type, name, turnIndex, question, expects = [], rejects = [], answer = '', error = null, elapsedMs, finalTurn, conversation, target, stale }) {
  const missing = expects.filter(needle => needle && !answer.includes(needle))
  const bad = rejects.filter(needle => needle && answer.includes(needle))
  return {
    id,
    caseId,
    type,
    name,
    turnIndex,
    question,
    ok: !error && missing.length === 0 && bad.length === 0,
    missing,
    bad,
    expects,
    rejects,
    answer,
    error: error ? String(error?.message || error) : '',
    elapsedMs,
    finalTurn,
    conversation,
    target,
    stale,
  }
}

function printProgress(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  const suffix = result.finalTurn ? 'final' : `turn ${result.turnIndex}`
  console.log(`${String(result.id).padStart(3, '0')} ${status} [${suffix}] [${result.type}] ${result.question}`)
  if (!result.ok) {
    if (result.error) console.log(`    error: ${result.error}`)
    if (result.missing.length) console.log(`    missing: ${result.missing.join(' | ')}`)
    if (result.bad.length) console.log(`    rejected present: ${result.bad.join(' | ')}`)
    console.log(`    target: ${formatRecord(result.target)}`)
    if (result.stale) console.log(`    stale: ${formatRecord(result.stale)}`)
    console.log(`    answer: ${clip(result.answer, 700)}`)
  }
}

async function writeReport({ startedAt, finishedAt, cases, results }) {
  await mkdir(reportDir, { recursive: true })
  const failed = results.filter(result => !result.ok)
  const finalResults = results.filter(result => result.finalTurn)
  const finalFailed = finalResults.filter(result => !result.ok)
  const lines = [
    '# Windrise 约束切换与跨品牌防串测试报告',
    '',
    `- 测试时间：${formatDate(startedAt)} - ${formatDate(finishedAt)}`,
    `- 测试入口：Web \`${webBaseUrl}\``,
    `- 测试方式：${cases.length} 个独立会话，覆盖纠错切换、厂家硬约束、模糊后补全、机型优先`,
    `- 总轮数：${results.length}`,
    `- 总体结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`,
    `- 最终定位：${finalResults.length - finalFailed.length}/${finalResults.length} 通过，${finalFailed.length} 失败`,
    '',
    '## 失败项',
    '',
    failed.length ? failed.map(formatFailure).join('\n\n') : '无失败项。',
    '',
    '## 会话清单',
    '',
    '| 会话 | 类型 | 目标 | 最终结果 | 缺失项 |',
    '|---:|---|---|---|---|',
    ...finalResults.map(result =>
      `| ${result.caseId} | ${escapeTable(result.type)} | ${escapeTable(formatRecord(result.target))} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.missing.join('、') || '-')} |`,
    ),
    '',
    '## 全量问题',
    '',
    '| # | 会话 | 轮次 | 类型 | 结果 | 问题 | 用时 |',
    '|---:|---:|---:|---|---|---|---:|',
    ...results.map(result =>
      `| ${result.id} | ${result.caseId} | ${result.turnIndex} | ${escapeTable(result.type)} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.question)} | ${Math.round(result.elapsedMs)}ms |`,
    ),
    '',
    '## 最终输出摘录',
    '',
    ...finalResults.map(result => [
      `### 会话 ${result.caseId}：${result.ok ? '通过' : '失败'} ${result.type} ${formatRecord(result.target)}`,
      '',
      `对话：${result.conversation.join(' -> ')}`,
      '',
      '```text',
      clip(result.answer, result.ok ? 1000 : 1800),
      '```',
      '',
    ].join('\n')),
  ]
  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8')
}

function formatFailure(result) {
  return [
    `### ${result.id}. 会话 ${result.caseId} 第 ${result.turnIndex} 轮（${result.type}）`,
    '',
    `- 目标：${formatRecord(result.target)}`,
    result.stale ? `- 已纠正的旧目标：${formatRecord(result.stale)}` : '',
    `- 问题：${result.question}`,
    result.error ? `- 错误：${result.error}` : '',
    result.missing.length ? `- 缺失：${result.missing.join('、')}` : '',
    result.bad.length ? `- 不应出现但出现：${result.bad.join('、')}` : '',
    '',
    '```text',
    clip(result.answer, 1800),
    '```',
  ].filter(Boolean).join('\n')
}

function targetExpects(target) {
  return [
    target.code,
    safeExpectName(target.name),
    target.site,
    target.brand,
    target.model,
    target.standardModel,
  ]
}

function pickSpread(items, count, offset = 0) {
  if (!items?.length) return []
  const picked = []
  const step = items.length / Math.max(count, 1)
  const seen = new Set()
  for (let index = 0; picked.length < count && index < count * 4; index += 1) {
    const itemIndex = Math.min(items.length - 1, Math.floor(((index + offset) % count) * step))
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

function isSingleDimension(value) {
  return Boolean(value) && !/[、,，/]/.test(String(value))
}

function isUsefulFaultName(name) {
  const text = String(name || '').trim()
  return (
    text.length >= 2 &&
    text.length <= 42 &&
    !/[。；;]/.test(text) &&
    !text.includes('触发条件') &&
    !text.includes('产生原因') &&
    !text.includes('刹车级别')
  )
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').trim()
}

function safeExpectName(name) {
  return String(name || '').replace(/\s+/g, ' ').slice(0, 14)
}

function loosenFaultName(name) {
  return String(name || '')
    .replace(/^SC[_-]?/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fuzzyFaultName(name) {
  const text = loosenFaultName(name)
  if (text.length <= 12) return text
  return text.slice(0, Math.max(8, Math.min(18, text.length)))
}

function formatRecord(record) {
  if (!record) return '-'
  return `${record.site} / ${record.brand} / ${record.model} / ${record.standardModel} / ${record.code} / ${record.name}`
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

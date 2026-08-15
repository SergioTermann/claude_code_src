#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const faultIndexPath = join(root, 'wind-llmwiki', 'fault-index.jsonl')
const reportDir = join(root, 'reports')
const reportPath = join(reportDir, `windrise-progressive-200-${timestampForFile()}.md`)
const webBaseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5012'
const totalTurns = 200
const turnsPerCase = 4
const caseCount = totalTurns / turnsPerCase

const records = await loadTargetRecords()
const cases = buildCases(records, caseCount)
if (cases.length !== caseCount) {
  throw new Error(`Expected ${caseCount} cases, generated ${cases.length}`)
}

const startedAt = new Date()
const cookie = await login()
const results = []
let questionId = 1

console.log(`Windrise progressive 200-turn eval started. Report: ${reportPath}`)
console.log(`Web: ${webBaseUrl}`)
console.log(`Cases: ${cases.length}, turns: ${cases.length * turnsPerCase}`)

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
    conversation.push({ turn, answer })
    const isFinal = turnIndex === testCase.turns.length - 1
    const result = evaluate({
      id: questionId++,
      caseId: testCase.id,
      turnIndex: turnIndex + 1,
      name: testCase.name,
      question: turn,
      expects: isFinal ? testCase.finalExpects : testCase.turnExpects[turnIndex] || [],
      rejects: isFinal ? testCase.finalRejects : testCase.turnRejects[turnIndex] || [],
      answer,
      error,
      elapsedMs: Date.now() - started,
      conversation: conversation.map(item => item.turn),
      finalTurn: isFinal,
      target: testCase.target,
    })
    results.push(result)
    printProgress(result)
  }
}

await writeReport({ startedAt, finishedAt: new Date(), results, cases })
const failed = results.filter(result => !result.ok)
console.log('')
console.log(`Windrise progressive 200-turn eval finished: ${results.length - failed.length}/${results.length} passed.`)
console.log(`Final-turn locating accuracy: ${finalAccuracy(results)}`)
console.log(`Report written: ${reportPath}`)

if (failed.length) {
  process.exit(1)
}

async function loadTargetRecords() {
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
    String(record.standardModel).length <= 40,
  )

  const deduped = []
  const seen = new Set()
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
    deduped.push(record)
  }

  deduped.sort((a, b) =>
    `${a.brand}|${a.site}|${a.model}|${a.standardModel}`.localeCompare(
      `${b.brand}|${b.site}|${b.model}|${b.standardModel}`,
      'zh-CN',
    ),
  )

  return pickSpread(deduped, caseCount)
}

function buildCases(targets, count) {
  return targets.slice(0, count).map((record, index) => {
    const target = {
      code: String(record.code),
      name: String(record.name),
      site: String(record.site),
      brand: String(record.brand),
      model: String(record.model),
      standardModel: String(record.standardModel),
    }
    return {
      id: index + 1,
      name: `渐进定位 ${target.site}/${target.brand}/${target.model}/${target.standardModel}/${target.code}`,
      target,
      turns: [
        `${target.name}是什么故障码`,
        `厂家是${target.brand}`,
        `风场是${target.site}`,
        `机型是${target.model}，具体型号是${target.standardModel}，请最终定位故障码、风场、厂家、机型和具体型号`,
      ],
      turnExpects: [
        [safeExpectName(target.name)],
        [target.brand],
        [target.site],
      ],
      turnRejects: [[], [], []],
      finalExpects: [
        target.code,
        safeExpectName(target.name),
        target.site,
        target.brand,
        target.model,
        target.standardModel,
      ],
      finalRejects: ['本地知识库暂未找到', '通用风机运维知识'],
    }
  })
}

async function login() {
  const response = await fetch(`${webBaseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (!response.ok) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`)
  }
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
  if (!response.ok) {
    throw new Error(`create session failed: ${response.status} ${await response.text()}`)
  }
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
  if (!response.ok) {
    throw new Error(`chat failed for ${message}: ${response.status} ${await response.text()}`)
  }
  const payload = await response.json()
  return String(payload.answer || '')
}

function evaluate({ id, caseId, turnIndex, name, question, expects = [], rejects = [], answer = '', error = null, elapsedMs, conversation = [], finalTurn, target }) {
  const missing = expects.filter(needle => needle && !answer.includes(needle))
  const bad = rejects.filter(needle => needle && answer.includes(needle))
  const ok = !error && missing.length === 0 && bad.length === 0
  return {
    id,
    caseId,
    turnIndex,
    name,
    question,
    ok,
    missing,
    bad,
    expects,
    rejects,
    answer,
    error: error ? String(error?.message || error) : '',
    elapsedMs,
    conversation,
    finalTurn,
    target,
  }
}

function printProgress(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  const suffix = result.finalTurn ? 'final' : `turn ${result.turnIndex}`
  console.log(`${String(result.id).padStart(3, '0')} ${status} [${suffix}] ${result.question}`)
  if (!result.ok) {
    if (result.error) console.log(`    error: ${result.error}`)
    if (result.missing.length) console.log(`    missing: ${result.missing.join(' | ')}`)
    if (result.bad.length) console.log(`    rejected present: ${result.bad.join(' | ')}`)
    console.log(`    target: ${formatTarget(result.target)}`)
    console.log(`    answer: ${clip(result.answer, 500)}`)
  }
}

async function writeReport({ startedAt, finishedAt, results, cases }) {
  await mkdir(reportDir, { recursive: true })
  const failed = results.filter(result => !result.ok)
  const finalResults = results.filter(result => result.finalTurn)
  const finalFailed = finalResults.filter(result => !result.ok)
  const lines = [
    '# Windrise 渐进式 200 问定位测试报告',
    '',
    `- 测试时间：${formatDate(startedAt)} - ${formatDate(finishedAt)}`,
    `- 测试入口：Web \`${webBaseUrl}\``,
    `- 测试方式：${cases.length} 个独立会话，每个会话 4 轮，模拟用户逐步补充故障名、厂家、风场、机型/具体型号`,
    `- 总问题数：${results.length}`,
    `- 总体结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 失败`,
    `- 最终定位：${finalResults.length - finalFailed.length}/${finalResults.length} 通过，${finalFailed.length} 失败`,
    '',
    '## 失败项',
    '',
    failed.length ? failed.map(formatFailure).join('\n\n') : '无失败项。',
    '',
    '## 会话清单',
    '',
    '| 会话 | 目标 | 最终结果 | 缺失项 |',
    '|---:|---|---|---|',
    ...finalResults.map(result =>
      `| ${result.caseId} | ${escapeTable(formatTarget(result.target))} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.missing.join('、') || '-')} |`,
    ),
    '',
    '## 全量问题',
    '',
    '| # | 会话 | 轮次 | 结果 | 问题 | 用时 |',
    '|---:|---:|---:|---|---|---:|',
    ...results.map(result =>
      `| ${result.id} | ${result.caseId} | ${result.turnIndex} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.question)} | ${Math.round(result.elapsedMs)}ms |`,
    ),
    '',
    '## 输出摘录',
    '',
    ...finalResults.map(result => [
      `### 会话 ${result.caseId}：${result.ok ? '通过' : '失败'} ${formatTarget(result.target)}`,
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
    `### ${result.id}. 会话 ${result.caseId} 第 ${result.turnIndex} 轮`,
    '',
    `- 目标：${formatTarget(result.target)}`,
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

function pickSpread(items, count) {
  if (items.length < count) {
    throw new Error(`Could only pick ${items.length}/${count} records`)
  }
  const picked = []
  const step = items.length / count
  const seen = new Set()
  for (let index = 0; picked.length < count && index < count * 4; index += 1) {
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

function isSingleDimension(value) {
  return Boolean(value) && !/[、,，/]/.test(String(value))
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

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').trim()
}

function safeExpectName(name) {
  return String(name || '').replace(/\s+/g, ' ').slice(0, 14)
}

function finalAccuracy(results) {
  const finalResults = results.filter(result => result.finalTurn)
  const passed = finalResults.filter(result => result.ok).length
  return `${passed}/${finalResults.length}`
}

function formatTarget(target) {
  return `${target.site} / ${target.brand} / ${target.model} / ${target.standardModel} / ${target.code} / ${target.name}`
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

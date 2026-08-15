#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const faultIndexPath = join(root, 'wind-llmwiki', 'fault-index.jsonl')
const reportDir = join(root, 'reports')
const reportPath = join(reportDir, `windrise-context-200-${timestampForFile()}.md`)
const webBaseUrl = process.env.WINDRISE_WEB_URL || 'http://127.0.0.1:5012'
const modelBaseUrl = process.env.LMSTUDIO_BASE_URL || 'http://10.46.161.210:9527'
const modelName = process.env.LMSTUDIO_MODEL || 'Qwen-30B'
const SYSTEM_ERROR_MARKERS = [
  '暂时无法通过大模型提取知识库检索内容',
  'vLLM 当前不可用或响应超时',
  'Error in input stream',
  'NetworkError',
  '连接在传输过程中中断',
]
const totalTurns = 200
const turnsPerCase = 4
const caseCount = totalTurns / turnsPerCase

const records = await loadTargetRecords()
const cases = buildCases(records, caseCount)
if (cases.length !== caseCount) {
  throw new Error(`Expected ${caseCount} cases, generated ${cases.length}`)
}

const startedAt = new Date()
const modelProbe = await probeModelService()
const cookie = await login()
const results = []
let questionId = 1

console.log(`Windrise context 200-turn eval started. Report: ${reportPath}`)
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
      pattern: testCase.pattern,
    })
    results.push(result)
    printProgress(result)
  }
}

await writeReport({ startedAt, finishedAt: new Date(), results, cases })
const failed = results.filter(result => !result.ok)
console.log('')
console.log(`Windrise context 200-turn eval finished: ${results.length - failed.length}/${results.length} passed.`)
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
    String(record.standardModel).length <= 48,
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
    `${a.site}|${a.brand}|${a.model}|${a.standardModel}|${a.code}`.localeCompare(
      `${b.site}|${b.brand}|${b.model}|${b.standardModel}|${b.code}`,
      'zh-CN',
    ),
  )

  return pickSpread(deduped, caseCount, 7)
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
    const variants = buildTurnVariants(target)
    const variant = variants[index % variants.length]
    return {
      id: index + 1,
      pattern: variant.name,
      name: `上下文定位 ${variant.name} ${target.site}/${target.brand}/${target.model}/${target.standardModel}/${target.code}`,
      target,
      turns: variant.turns,
      turnExpects: variant.turnExpects,
      turnRejects: variant.turnRejects,
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

function buildTurnVariants(target) {
  const faultName = target.name
  const finalShort = '风机编号无法提供，请按已有信息最终定位故障码、风场、厂家、机型和具体型号，并列出相关结果'
  return [
    {
      name: '故障优先',
      turns: [
        `${faultName}是什么故障码`,
        `厂家是${target.brand}`,
        `风场是${target.site}`,
        `机型是${target.model}，具体型号是${target.standardModel}，${finalShort}`,
      ],
      turnExpects: [[safeExpectName(faultName)], [target.brand], [target.site]],
      turnRejects: [[], [], []],
    },
    {
      name: '厂家优先',
      turns: [
        `先限定厂家：${target.brand}`,
        `现场风场是${target.site}`,
        `告警内容是${faultName}`,
        `机型${target.model}，具体型号${target.standardModel}，${finalShort}`,
      ],
      turnExpects: [[target.brand], [target.site], [safeExpectName(faultName)]],
      turnRejects: [[], [], []],
    },
    {
      name: '风场优先',
      turns: [
        `风场先确定为${target.site}`,
        `厂家是${target.brand}，机型先记一下是${target.model}`,
        `现在报的是${faultName}`,
        `具体型号${target.standardModel}，${finalShort}`,
      ],
      turnExpects: [[target.site], [target.brand, target.model], [safeExpectName(faultName)]],
      turnRejects: [[], [], []],
    },
    {
      name: '机型优先',
      turns: [
        `这台机组机型是${target.model}`,
        `具体型号是${target.standardModel}，厂家${target.brand}`,
        `风场${target.site}，故障描述：${faultName}`,
        finalShort,
      ],
      turnExpects: [[target.model], [target.standardModel, target.brand], [target.site, safeExpectName(faultName)]],
      turnRejects: [[], [], []],
    },
    {
      name: '最后补风场',
      turns: [
        `${faultName}，先帮我记住这个故障现象`,
        `厂家${target.brand}，机型${target.model}`,
        `具体型号${target.standardModel}`,
        `风场是${target.site}，${finalShort}`,
      ],
      turnExpects: [[safeExpectName(faultName)], [target.brand, target.model], [target.standardModel]],
      turnRejects: [[], [], []],
    },
  ]
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

function evaluate({ id, caseId, turnIndex, name, question, expects = [], rejects = [], answer = '', error = null, elapsedMs, conversation = [], finalTurn, target, pattern }) {
  const normalizedAnswer = normalizeForMatch(answer)
  const missing = expects.filter(needle =>
    needle && !normalizedAnswer.includes(normalizeForMatch(needle)),
  )
  const bad = rejects.filter(needle => needle && answer.includes(needle))
  const systemErrors = SYSTEM_ERROR_MARKERS.filter(marker => answer.includes(marker))
  const ok = !error && missing.length === 0 && bad.length === 0 && systemErrors.length === 0
  return {
    id,
    caseId,
    turnIndex,
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
    target,
    pattern,
  }
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLocaleLowerCase('zh-CN')
    .replace(/[、，]/g, ',')
}

function printProgress(result) {
  const status = result.ok ? 'PASS' : 'FAIL'
  const suffix = result.finalTurn ? 'final' : `turn ${result.turnIndex}`
  console.log(`${String(result.id).padStart(3, '0')} ${status} [${suffix}] [${result.pattern}] ${result.question}`)
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
    '# Windrise 上下文 200 问定位测试报告',
    '',
    `- 测试时间：${formatDate(startedAt)} - ${formatDate(finishedAt)}`,
    `- 测试入口：Web \`${webBaseUrl}\``,
    `- vLLM：\`${modelBaseUrl}\` / \`${modelName}\`，探测结果：${modelProbe.ok ? '可访问' : `不可访问（${modelProbe.detail}）`}`,
    `- 测试方式：${cases.length} 个独立会话，每个会话 4 轮；话术顺序覆盖故障优先、厂家优先、风场优先、机型优先、最后补风场`,
    '- 原文规则：逐题保存用户问题和系统实际回答，不截断、不改写、不压缩空白',
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
    '| 会话 | 话术 | 目标 | 最终结果 | 缺失项 |',
    '|---:|---|---|---|---|',
    ...finalResults.map(result =>
      `| ${result.caseId} | ${escapeTable(result.pattern)} | ${escapeTable(formatTarget(result.target))} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.missing.join('、') || '-')} |`,
    ),
    '',
    '## 全量问题',
    '',
    '| # | 会话 | 轮次 | 话术 | 结果 | 问题 | 用时 |',
    '|---:|---:|---:|---|---|---|---:|',
    ...results.map(result =>
      `| ${result.id} | ${result.caseId} | ${result.turnIndex} | ${escapeTable(result.pattern)} | ${result.ok ? '通过' : '失败'} | ${escapeTable(result.question)} | ${Math.round(result.elapsedMs)}ms |`,
    ),
    '',
    '## 完整问题与回答原文',
    '',
    ...results.map(result => [
      `### ${result.id}. ${result.ok ? '通过' : '失败'} 会话 ${result.caseId} 第 ${result.turnIndex} 轮：${result.question}`,
      '',
      `- 话术：${result.pattern}`,
      `- 目标：${formatTarget(result.target)}`,
      `- 对话上下文：${result.conversation.join(' -> ')}`,
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
    ].join('\n')),
  ]
  await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8')
}

function formatFailure(result) {
  return [
    `### ${result.id}. 会话 ${result.caseId} 第 ${result.turnIndex} 轮（${result.pattern}）`,
    '',
    `- 目标：${formatTarget(result.target)}`,
    `- 问题：${result.question}`,
    result.error ? `- 错误：${result.error}` : '',
    result.missing.length ? `- 缺失：${result.missing.join('、')}` : '',
    result.bad.length ? `- 不应出现但出现：${result.bad.join('、')}` : '',
    result.systemErrors.length ? `- 系统异常：${result.systemErrors.join('、')}` : '',
    '',
    '```text',
    clip(result.answer, 1800),
    '```',
  ].filter(Boolean).join('\n')
}

function pickSpread(items, count, offset = 0) {
  if (items.length < count) {
    throw new Error(`Could only pick ${items.length}/${count} records`)
  }
  const picked = []
  const step = items.length / count
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
    text.length <= 40 &&
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

#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const indexPath = join(root, '风机故障码', 'fault-index.jsonl')

const category = process.argv.find(arg => arg.startsWith('--category='))?.slice('--category='.length) || 'all-non-sc'
const concurrency = Number.parseInt(
  process.argv.find(arg => arg.startsWith('--concurrency='))?.slice('--concurrency='.length) || '12',
  10,
)
const reportPath =
  process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length) ||
  join(root, 'scripts', `.audit-fault-codes-${category}-report.json`)

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[_.\-/]+/g, '')
}

function classifyCode(code) {
  if (/^SC\d{2}_\d{2}_\d{3}$/i.test(code)) return 'sc'
  if (/^SM\d/i.test(code)) return 'sm'
  if (/^\d+$/.test(code)) return 'numeric'
  return 'other'
}

function matchesCategory(code) {
  const kind = classifyCode(code)
  switch (category) {
    case 'sc':
      return kind === 'sc'
    case 'sm':
      return kind === 'sm'
    case 'numeric':
      return kind === 'numeric'
    case 'all-non-sc':
      return kind === 'sm' || kind === 'numeric'
    case 'all':
      return kind !== 'other'
    default:
      throw new Error(`Unknown category: ${category}`)
  }
}

async function runLlmwiki(command) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', command],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: join(root, '风机故障码'),
        WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
        ANTHROPIC_MODEL_PROVIDER:
          process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
        LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
        LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  return stdout.trim()
}

function evaluate(code, name, answer) {
  if (!answer || /^No matches/i.test(answer)) {
    return { ok: false, reason: 'no_match' }
  }
  if (!norm(answer).includes(norm(code))) {
    return { ok: false, reason: 'code_missing' }
  }
  const normalizedName = norm(name)
  if (normalizedName.length >= 4) {
    const chunks = [
      normalizedName,
      normalizedName.slice(0, 12),
      normalizedName.replace(/重复故障$/, ''),
      normalizedName.replace(/故障$/, ''),
      normalizedName.replace(/^预留$/, '预留'),
    ].filter(chunk => chunk.length >= 2)
    if (!chunks.some(chunk => norm(answer).includes(chunk))) {
      return { ok: false, reason: 'name_missing' }
    }
  }
  return { ok: true, reason: 'ok' }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= items.length) return
      results[current] = await worker(items[current], current)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, runWorker))
  return results
}

const lines = (await readFile(indexPath, 'utf8')).split(/\r?\n/).filter(Boolean)
const byCode = new Map()
for (const line of lines) {
  const record = JSON.parse(line)
  const code = String(record.code || '').trim()
  if (!code || !matchesCategory(code)) continue
  if (!byCode.has(code)) {
    byCode.set(code, {
      code,
      kind: classifyCode(code),
      name: String(record.name || '').trim(),
      brand: String(record.brand || '').trim(),
    })
  }
}

const cases = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
const startedAt = Date.now()
let completed = 0

console.log(`故障码分类全量扫描`)
console.log(`类别: ${category}`)
console.log(`数量: ${cases.length}`)
console.log(`并发: ${concurrency}\n`)

const results = await mapLimit(cases, concurrency, async (item, index) => {
  const answer = await runLlmwiki(`/llmwiki ask ${item.code} --limit 4`)
  const result = evaluate(item.code, item.name, answer)
  completed += 1
  if (!result.ok) {
    console.log(`FAIL [${completed}/${cases.length}] ${item.code} (${result.reason})`)
    return {
      ...item,
      ok: false,
      reason: result.reason,
      preview: answer.split('\n').slice(0, 4).join(' | '),
    }
  }
  if (completed % 100 === 0 || completed === cases.length) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[${completed}/${cases.length}] 进度 ${((completed / cases.length) * 100).toFixed(1)}%，用时 ${elapsed}s`)
  }
  return { ...item, ok: true, reason: 'ok' }
})

const passed = results.filter(result => result.ok)
const failures = results.filter(result => !result.ok)
const byKind = {}
for (const result of results) {
  byKind[result.kind] = byKind[result.kind] || { passed: 0, failed: 0 }
  if (result.ok) byKind[result.kind].passed += 1
  else byKind[result.kind].failed += 1
}

const elapsedMs = Date.now() - startedAt
const report = {
  generatedAt: new Date().toISOString(),
  category,
  total: cases.length,
  passed: passed.length,
  failed: failures.length,
  elapsedMs,
  byKind,
  failures: failures.map(({ code, name, brand, kind, reason, preview }) => ({
    code,
    name,
    brand,
    kind,
    reason,
    preview,
  })),
}

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('\n========== 扫描完成 ==========')
console.log(`总计: ${cases.length}`)
console.log(`成功: ${passed.length}`)
console.log(`失败: ${failures.length}`)
console.log(`耗时: ${(elapsedMs / 1000).toFixed(1)}s`)
console.log(`报告: ${reportPath}`)
console.log('分类统计:', byKind)

if (failures.length > 0) {
  console.log('\n--- 失败明细（前 30 条）---')
  for (const failure of failures.slice(0, 30)) {
    console.log(`${failure.code} [${failure.kind}] | ${failure.name} | ${failure.reason}`)
  }
  process.exit(1)
}

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
const reportPath = join(root, 'scripts', '.audit-sc-fault-codes-report.json')

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[_.\-/]+/g, '')
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
    ].filter(chunk => chunk.length >= 4)
    if (!chunks.some(chunk => norm(answer).includes(chunk))) {
      return { ok: false, reason: 'name_missing' }
    }
  }
  return { ok: true, reason: 'ok' }
}

const lines = (await readFile(indexPath, 'utf8')).split(/\r?\n/).filter(Boolean)
const byCode = new Map()
for (const line of lines) {
  const record = JSON.parse(line)
  const code = String(record.code || '').trim()
  if (!/^SC\d{2}_\d{2}_\d{3}$/i.test(code)) continue
  if (!byCode.has(code)) {
    byCode.set(code, {
      code,
      name: String(record.name || '').trim(),
      brand: String(record.brand || '').trim(),
    })
  }
}

const cases = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))
const startedAt = Date.now()
const failures = []
let passed = 0

console.log(`SC 下划线故障码全量扫描：${cases.length} 个\n`)

for (let index = 0; index < cases.length; index += 1) {
  const item = cases[index]
  const answer = await runLlmwiki(`/llmwiki ask ${item.code} --limit 4`)
  const result = evaluate(item.code, item.name, answer)
  if (result.ok) {
    passed += 1
    if ((index + 1) % 50 === 0 || index + 1 === cases.length) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      console.log(`[${index + 1}/${cases.length}] 已通过 ${passed}，失败 ${failures.length}，用时 ${elapsed}s`)
    }
    continue
  }

  failures.push({
    code: item.code,
    name: item.name,
    brand: item.brand,
    reason: result.reason,
    preview: answer.split('\n').slice(0, 4).join(' | '),
  })
  console.log(`FAIL [${index + 1}/${cases.length}] ${item.code} (${result.reason})`)
}

const elapsedMs = Date.now() - startedAt
const report = {
  generatedAt: new Date().toISOString(),
  total: cases.length,
  passed,
  failed: failures.length,
  elapsedMs,
  failures,
}

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('\n========== 全量扫描完成 ==========')
console.log(`总计: ${cases.length}`)
console.log(`成功: ${passed}`)
console.log(`失败: ${failures.length}`)
console.log(`耗时: ${(elapsedMs / 1000).toFixed(1)}s`)
console.log(`报告: ${reportPath}`)

if (failures.length > 0) {
  console.log('\n--- 失败明细 ---')
  for (const failure of failures.slice(0, 20)) {
    console.log(`${failure.code} | ${failure.name} | ${failure.reason}`)
    console.log(`  ${failure.preview}`)
  }
  if (failures.length > 20) {
    console.log(`... 还有 ${failures.length - 20} 条，见报告文件`)
  }
  process.exit(1)
}

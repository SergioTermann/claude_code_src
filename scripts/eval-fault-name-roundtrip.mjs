#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const indexPath = join(root, '风机故障码', 'fault-index.jsonl')

const sampleSize = Number(process.env.WINDRISE_ROUNDTRIP_SAMPLE || 20)
const records = await loadSampleRecords(sampleSize)

let failures = 0
for (const record of records) {
  const byName = await runLlmwiki(`/llmwiki ask ${record.name}的故障码是什么 --limit 12`)
  const byCode = await runLlmwiki(`/llmwiki ask 故障码${record.code}是什么 --limit 12`)
  const nameOk = byName.includes(record.code) && byName.includes(record.name)
  const codeOk = byCode.includes(record.code) && byCode.includes(record.name)
  const ok = nameOk && codeOk
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${record.code} ${record.name}`)
  if (!ok) {
    if (!nameOk) console.log(`  name lookup miss: ${clip(byName)}`)
    if (!codeOk) console.log(`  code lookup miss: ${clip(byCode)}`)
  }
}

if (failures) {
  console.error(`\n${failures} fault-name roundtrip case(s) failed.`)
  process.exit(1)
}

console.log(`\nFault-name roundtrip eval passed (${records.length} cases).`)

async function loadSampleRecords(limit) {
  const lines = (await readFile(indexPath, 'utf8')).split(/\r?\n/).filter(Boolean)
  const parsed = lines.map(line => JSON.parse(line))
  const seen = new Set()
  const result = []
  for (const record of parsed) {
    const code = String(record.code || '').trim()
    const name = String(record.name || '').trim()
    const site = String(record.site || '').trim()
    const brand = String(record.brand || '').trim()
    if (!code || !name || !site || !brand) continue
    if (name.length < 4) continue
    const key = `${code}\t${name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ code, name })
    if (result.length >= limit) break
  }
  return result
}

async function runLlmwiki(command) {
  const { stdout } = await execFileAsync(process.execPath, [runner, '--print', '--bare', command], {
    cwd: root,
    env: {
      ...process.env,
      LLMWIKI_PROJECT: join(root, '风机故障码'),
      WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
      ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
      LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
      LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  })
  return stdout
}

function clip(text, limit = 700) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

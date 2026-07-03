#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const indexPath = join(root, '风机故障码', 'fault-index.jsonl')
const llmwiki = await loadLlmwikiCommand()
process.env.LLMWIKI_PROJECT = process.env.LLMWIKI_PROJECT || join(root, '风机故障码')

const records = (await readFile(indexPath, 'utf8'))
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line))

const expectedCounts = groupCountsByCode(records)
const ambiguous = [...expectedCounts.entries()]
  .map(([code, count]) => ({ code, count }))
  .filter(item => item.count > 1)
  .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))

console.log(`Ambiguous fault codes: ${ambiguous.length}`)

for (const item of ambiguous) {
  const actual = displayedGroupCountForBareCode(records, item.code)
  if (actual !== item.count) {
    throw new Error(
      `Internal audit mismatch for ${item.code}: expected ${item.count}, got ${actual}`,
    )
  }
}

console.log(`Internal full audit checked ${ambiguous.length} ambiguous codes.`)

for (const item of ambiguous) {
  const stdout = await runLlmwiki(`ask ${item.code} --limit 1`)
  const match = stdout.match(/有\s+(\d+)\s+类不同含义/)
  if (!match) {
    throw new Error(`Expected ambiguous answer for ${item.code}\n\n${stdout}`)
  }
  const actual = Number(match[1])
  if (actual !== item.count) {
    throw new Error(
      `Expected ${item.count} grouped meanings for ${item.code}, got ${actual}\n\n${stdout}`,
    )
  }
  if (/^\d+$/.test(item.code) && stdout.includes(`${item.code}0：`)) {
    throw new Error(`Likely suffix-code pollution for ${item.code}\n\n${stdout}`)
  }
}

console.log(`End-to-end checked ${ambiguous.length} ambiguous codes.`)
console.log('Ambiguous fault-code audit passed.')

function groupCountsByCode(input) {
  const byCode = new Map()
  for (const record of input) {
    const code = String(record.code || '')
    if (!code) continue
    const groups = byCode.get(code) ?? new Set()
    groups.add(
      [code, record.brand || '', normalizeFaultNameForGrouping(record.name || '')]
        .filter(Boolean)
        .join('|'),
    )
    byCode.set(code, groups)
  }
  return new Map([...byCode.entries()].map(([code, groups]) => [code, groups.size]))
}

function displayedGroupCountForBareCode(input, code) {
  const matching = input.filter(record => String(record.code || '') === code)
  return new Set(
    matching.map(record =>
      [record.code || '', record.brand || '', normalizeFaultNameForGrouping(record.name || '')]
        .filter(Boolean)
        .join('|'),
    ),
  ).size
}

function normalizeFaultNameForGrouping(value) {
  return cleanFaultName(value)
    .replace(/([123])#/g, '$1号')
    .replace(/([123])＃/g, '$1号')
    .replace(/\s+/g, '')
}

function cleanFaultName(value) {
  return value
    .replace(/，?故障名称\(英文\)：.*$/i, '')
    .replace(/，?等级：.*$/i, '')
    .replace(/，?故障变量：.*$/i, '')
    .replace(/，?故障使能：.*$/i, '')
    .replace(/，?故障触发条件：.*$/i, '')
    .replace(/[，,；;。]\s*$/g, '')
    .trim()
}

async function runLlmwiki(command) {
  const result = await llmwiki.call(command)
  if (result.type !== 'text') {
    throw new Error(`Expected text result for ${command}: ${JSON.stringify(result)}`)
  }
  return result.value
}

async function loadLlmwikiCommand() {
  const outfile = join(tmpdir(), 'claude-code-audit-llmwiki-command.mjs')
  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [join(root, 'src', 'commands', 'llmwiki', 'llmwiki.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  return import(`${outfile}?t=${Date.now()}`)
}

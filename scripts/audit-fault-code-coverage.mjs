#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const projectPath = process.env.LLMWIKI_PROJECT || join(root, '风机故障码')
const indexPath = join(projectPath, 'fault-index.jsonl')
const reportPath =
  process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length) ||
  join(root, 'wind-llmwiki', 'fault-code-coverage-audit.json')
const concurrency = Number.parseInt(
  process.argv.find(arg => arg.startsWith('--concurrency='))?.slice('--concurrency='.length) ||
    '12',
  10,
)

process.env.LLMWIKI_PROJECT = projectPath

const llmwiki = await loadLlmwikiCommand()
const records = (await readFile(indexPath, 'utf8'))
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line))
const skippedInvalidCodeRecords = []
const byCode = groupRecordsByCode(records, skippedInvalidCodeRecords)
const codes = [...byCode.keys()].sort(compareCodes)
const startedAt = new Date()

console.log(`Fault-code coverage audit`)
console.log(`Project: ${projectPath}`)
console.log(`Records: ${records.length}`)
console.log(`Unique codes: ${codes.length}`)
console.log(`Skipped invalid code records: ${skippedInvalidCodeRecords.length}`)
console.log(`Concurrency: ${Number.isFinite(concurrency) ? concurrency : 12}`)

const results = await mapLimit(codes, Math.max(1, concurrency || 12), auditCode)
const passed = results.filter(result => result.ok)
const failed = results.filter(result => !result.ok)
const endedAt = new Date()
const summary = {
  projectPath,
  indexPath,
  startedAt: startedAt.toISOString(),
  endedAt: endedAt.toISOString(),
  elapsedSeconds: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
  recordCount: records.length,
  uniqueCodeCount: codes.length,
  skippedInvalidCodeRecordCount: skippedInvalidCodeRecords.length,
  passedCodeCount: passed.length,
  failedCodeCount: failed.length,
  accuracy: codes.length > 0 ? passed.length / codes.length : 0,
  totalExpectedCoverageCount: results.reduce(
    (sum, result) => sum + result.expectedCoverageCount,
    0,
  ),
  totalMissingCoverageCount: results.reduce(
    (sum, result) => sum + result.missingCoverage.length,
    0,
  ),
}

const report = {
  summary,
  failures: failed,
  skippedInvalidCodeRecords,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

console.log('')
console.log(`Passed codes: ${summary.passedCodeCount}/${summary.uniqueCodeCount}`)
console.log(`Failed codes: ${summary.failedCodeCount}`)
console.log(`Accuracy: ${(summary.accuracy * 100).toFixed(2)}%`)
console.log(
  `Coverage lines missing: ${summary.totalMissingCoverageCount}/${summary.totalExpectedCoverageCount}`,
)
console.log(`Report: ${reportPath}`)

if (failed.length > 0) {
  console.log('')
  console.log('First failures:')
  for (const failure of failed.slice(0, 20)) {
    console.log(
      `- ${failure.code}: missing ${failure.missingCoverage.length}/${failure.expectedCoverageCount}`,
    )
    for (const line of failure.missingCoverage.slice(0, 3)) {
      console.log(`  ${line}`)
    }
  }
  process.exitCode = 1
}

async function auditCode(code) {
  const expectedRecords = byCode.get(code) ?? []
  const expectedCoverage = uniqueCoverageLines(expectedRecords)
  const command = `ask ${quoteArg(code)} --limit 1`
  const stdout = await runLlmwiki(command)
  const missingCoverage = expectedCoverage.filter(line => !stdout.includes(line))
  const unexpectedCodeHeaders = extractUnexpectedCodeHeaders(stdout, code)
  return {
    code,
    ok: missingCoverage.length === 0 && unexpectedCodeHeaders.length === 0,
    recordCount: expectedRecords.length,
    expectedCoverageCount: expectedCoverage.length,
    missingCoverage,
    unexpectedCodeHeaders,
    outputExcerpt: missingCoverage.length || unexpectedCodeHeaders.length
      ? stdout.slice(0, 2000)
      : undefined,
  }
}

function groupRecordsByCode(input, skipped) {
  const groups = new Map()
  for (const record of input) {
    const code = cleanFaultCode(String(record.code || ''))
    const aliases = faultCodeAliases(code)
    if (aliases.length === 0) {
      skipped.push({
        code,
        site: record.site || '',
        brand: record.brand || '',
        model: record.model || '',
        source: record.source || record.location || '',
      })
      continue
    }
    for (const alias of aliases) {
      const group = groups.get(alias) ?? []
      group.push(record)
      groups.set(alias, group)
    }
  }
  return groups
}

function uniqueCoverageLines(input) {
  const seen = new Set()
  const lines = []
  for (const record of input) {
    const sites = splitSiteLabels(record.site)
    for (const site of sites.length > 0 ? sites : ['']) {
      const line = [
        site ? `风场：${site}` : '',
        record.brand ? `品牌：${record.brand}` : '',
        record.model ? `机型：${record.model}` : '',
      ]
        .filter(Boolean)
        .join(' / ')
      if (!line || seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

function splitSiteLabels(value) {
  return String(value || '')
    .split(/[、,，/]/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function extractUnexpectedCodeHeaders(stdout, expectedCode) {
  return [...stdout.matchAll(/^\d+[.、]\s*([^：:\s]+)[：:]/gm)]
    .map(match => match[1] || '')
    .filter(code => code && !faultCodesEqual(code, expectedCode))
}

function cleanFaultCode(value) {
  let normalized = String(value || '').trim()
  const metadataIndex = normalized.search(
    /[，,；;。]\s*(?:对应|故障|分类|unnamed|bachmann|abb|描述|触发|刹车|制动|报警|偏航|复位|设置|信号源|等级)/i,
  )
  if (metadataIndex > 0) normalized = normalized.slice(0, metadataIndex).trim()
  const trailingCode = normalized.match(/\b([a-z]+_?\d+)\b$/i)?.[1]
  if (trailingCode && /\s/.test(normalized)) return trailingCode
  return normalized
}

function faultCodesEqual(left, right) {
  const leftAliases = faultCodeAliases(left)
  const rightAliases = new Set(faultCodeAliases(right))
  return leftAliases.some(alias => rightAliases.has(alias))
}

function faultCodeKey(value) {
  return cleanFaultCode(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_.\-\/]+/g, '')
}

function faultCodeAliases(value) {
  const code = cleanFaultCode(value)
  if (!isValidFaultCodeValue(code)) return []

  const expanded = expandNumericFaultCodeRanges(code)
  return [
    ...new Set(
      expanded
        .map(item => faultCodeKey(item))
        .filter(Boolean),
    ),
  ]
}

function isValidFaultCodeValue(value) {
  return /\d/.test(value) && /^[a-z0-9_./\-\s、,，至到~～]+$/i.test(value)
}

function expandNumericFaultCodeRanges(value) {
  const trimmed = value.trim()
  if (!/^[\d\s、,，至到~～]+$/.test(trimmed)) return [trimmed]

  const parts = trimmed
    .split(/[、,，]/)
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return []

  const expanded = []
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*(?:至|到|[~～])\s*(\d+)$/)
    if (range) {
      const startText = range[1] || ''
      const endText = range[2] || ''
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 1000) {
        expanded.push(part)
        continue
      }
      const width = Math.max(startText.length, endText.length)
      for (let code = start; code <= end; code += 1) {
        expanded.push(String(code).padStart(width, '0'))
      }
      continue
    }

    if (/^\d+$/.test(part)) {
      expanded.push(part)
      continue
    }

    return [trimmed]
  }

  return expanded
}

async function runLlmwiki(command) {
  const result = await llmwiki.call(command)
  if (result.type !== 'text') {
    throw new Error(`Expected text result for ${command}: ${JSON.stringify(result)}`)
  }
  return result.value
}

async function loadLlmwikiCommand() {
  const outfile = join(tmpdir(), 'claude-code-coverage-llmwiki-command.mjs')
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

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      output[index] = await worker(items[index], index)
      if ((index + 1) % 250 === 0 || index + 1 === items.length) {
        console.log(`Checked ${index + 1}/${items.length}`)
      }
    }
  })
  await Promise.all(workers)
  return output
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_.-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function compareCodes(a, b) {
  const aNumber = /^\d+$/.test(a) ? Number(a) : Number.NaN
  const bNumber = /^\d+$/.test(b) ? Number(b) : Number.NaN
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber || a.localeCompare(b)
  }
  return a.localeCompare(b)
}

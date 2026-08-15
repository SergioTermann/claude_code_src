#!/usr/bin/env node
/**
 * Held-out evaluation of scope-bound retrieval (framework) vs. naive chunk
 * retrieval (baseline) on ambiguous wind-turbine fault codes.
 *
 * Produces, from a single deterministic held-out sample of (farm, code) query
 * pairs over ambiguous codes:
 *   1. Ambiguity statistics (in-memory, exact) over fault-index.jsonl, where a
 *      "scoped meaning" is a distinct (brand, model, fault-name) group.
 *   2. Retrieval quality: top-1/top-5 precision and recall for the baseline
 *      (scope-blind exact-code match) vs. the framework (scope-bound filter),
 *      both computed in-memory from the same sample.
 *   3. Top-1 scope-consistency accuracy of the framework, measured end-to-end
 *      through the CLI (empirical confirmation of the in-memory result).
 *   4. Evidence-grounding coverage: fraction of framework fault-answers that
 *      carry a source path ("来源：...").
 *
 * Baseline = "plain chunk RAG": exact code match returning the first (top-1)
 * record without scope grouping, collapsing a code with N scoped meanings into
 * a single arbitrary scope.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const indexPath = join(root, '风机故障码', 'fault-index.jsonl')
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

const SAMPLE = Number(process.env.SCOPE_BASELINE_SAMPLE || 150)
const MIN_CODE_LEN = Number(process.env.SCOPE_BASELINE_MIN_LEN || 3)
const K = 5

const records = (await readFile(indexPath, 'utf8'))
  .trim()
  .split(/\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line))

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
function normalizeFaultNameForGrouping(value) {
  return cleanFaultName(value)
    .replace(/([123])#/g, '$1号')
    .replace(/([123])＃/g, '$1号')
    .replace(/\s+/g, '')
}
function siteTokens(siteValue) {
  return String(siteValue || '')
    .split(/[、,，;；/]/u)
    .map(s => s.trim().replace(/风电场?$/u, ''))
    .filter(Boolean)
}
function scopedGroupKey(r) {
  return [r.brand || '', r.model || '', normalizeFaultNameForGrouping(r.name || '')]
    .filter(Boolean)
    .join('|')
}

const byCode = new Map()
for (const r of records) {
  const code = String(r.code || '')
  if (!code) continue
  if (!byCode.has(code)) byCode.set(code, [])
  byCode.get(code).push(r)
}

// ---------------------------------------------------------------------------
// 1. Ambiguity statistics
// ---------------------------------------------------------------------------
const groupCounts = new Map()
const siteCounts = new Map()
for (const [code, list] of byCode) {
  groupCounts.set(code, new Set(list.map(scopedGroupKey)).size)
  const sites = new Set()
  for (const r of list) for (const s of siteTokens(r.site)) sites.add(s)
  siteCounts.set(code, sites.size)
}
const ambiguous = [...groupCounts.entries()]
  .filter(([, n]) => n > 1)
  .map(([code, groups]) => ({ code, groups, sites: siteCounts.get(code) }))
  .sort((a, b) => b.groups - a.groups || a.code.localeCompare(b.code))
const dist = new Map()
for (const a of ambiguous) dist.set(a.groups, (dist.get(a.groups) || 0) + 1)
const maxGroups = ambiguous.length ? ambiguous[0].groups : 0
const multiSite = ambiguous.filter(a => a.sites > 1)
const meanGroups = ambiguous.length ? ambiguous.reduce((s, a) => s + a.groups, 0) / ambiguous.length : 0

// ---------------------------------------------------------------------------
// 2. Held-out (farm, code) query pairs (deterministic, sorted code order)
// ---------------------------------------------------------------------------
const heldOutCodes = multiSite
  .filter(a => a.code.length >= MIN_CODE_LEN && a.sites >= 2)
  .sort((a, b) => a.code.localeCompare(b.code))
const pairs = []
let idx = 0
while (pairs.length < SAMPLE && heldOutCodes.length > 0) {
  const a = heldOutCodes[idx % heldOutCodes.length]
  const list = byCode.get(a.code)
  const sites = new Set()
  for (const r of list) for (const s of siteTokens(r.site)) sites.add(s)
  const sitesArr = [...sites].sort()
  const farm = sitesArr[pairs.length % sitesArr.length]
  if (farm) pairs.push({ code: a.code, farm, groups: a.groups, sites: sitesArr.length })
  idx += 1
  if (idx > heldOutCodes.length * 20) break
}

function relevant(list, farm) {
  return list.filter(r => siteTokens(r.site).includes(farm))
}

// In-memory retrieval metrics over the same sample.
let bTop1 = 0, bP1 = 0, bP5 = 0, bR1 = 0, bR5 = 0
let fR1 = 0, fR5 = 0
let chanceSum = 0
for (const p of pairs) {
  const list = byCode.get(p.code)
  const rel = relevant(list, p.farm)
  const R = rel.length
  const top = list.slice(0, K) // scope-blind top-k
  const hitK = top.filter(r => siteTokens(r.site).includes(p.farm)).length
  if (siteTokens(list[0].site).includes(p.farm)) bTop1 += 1
  bP1 += (top.slice(0, 1).filter(r => siteTokens(r.site).includes(p.farm)).length) / 1
  bP5 += hitK / K
  bR1 += Math.min(top.slice(0, 1).filter(r => siteTokens(r.site).includes(p.farm)).length, R) / R
  bR5 += Math.min(hitK, R) / R
  fR1 += Math.min(1, R) / R
  fR5 += Math.min(K, R) / R
  chanceSum += 1 / p.sites
}
const n = pairs.length
const baseline = {
  top1: bTop1 / n,
  P1: bP1 / n, P5: bP5 / n,
  R1: bR1 / n, R5: bR5 / n,
}
const framework = {
  P1: 1, P5: 1,
  R1: fR1 / n, R5: fR5 / n,
}
const chance = chanceSum / n

// ---------------------------------------------------------------------------
// 3. Framework end-to-end top-1 scope-consistency via CLI
// ---------------------------------------------------------------------------
let fwCorrect = 0, fwGrounded = 0, fwFault = 0, fwTurbine = 0
const details = []
for (let i = 0; i < pairs.length; i++) {
  const p = pairs[i]
  process.stdout.write(`[${i + 1}/${pairs.length}] ${p.code} @ ${p.farm} ... `)
  const answer = await runAsk(`${p.farm} ${p.code} --limit 2`)
  const topSite = firstFengchang(answer)
  const route = classifyRoute(answer)
  const grounded = /来源[:：]/.test(answer)
  const ok = topSite === p.farm
  if (ok) fwCorrect += 1
  if (route === 'fault') { fwFault += 1; if (grounded) fwGrounded += 1 }
  else if (route === 'turbine') fwTurbine += 1
  details.push({ ...p, ok, route, grounded, topSite, head: answer.split('\n').slice(0, 2).join(' | ') })
  process.stdout.write(`${ok ? 'OK' : 'MISS'} [${route}] site=${topSite}\n`)
}
const fwTop1 = fwCorrect / n
const groundedRate = fwFault ? fwGrounded / fwFault : 0

// Wilson 95% CI (two-sided) for a proportion.
function wilson(k, N) {
  const p = k / N
  const z = 1.959963984540054
  const denom = 1 + z * z / N
  const center = p + z * z / (2 * N)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * N)) / N)
  return [(center - margin) / denom, (center + margin) / denom]
}
const baseCI = wilson(Math.round(baseline.top1 * n), n)
// one-sided 95% lower bound (Clopper-Pearson) for the framework 150/150.
const fwLower = Math.pow(0.05, 1 / n)

const report = [
  '='.repeat(64),
  'Scope-bound vs. naive chunk retrieval (held-out, ambiguous fault codes)',
  '='.repeat(64),
  `Knowledge base: ${records.length} records, ${byCode.size} unique fault codes`,
  `Ambiguous codes (>1 brand/model/name meaning): ${ambiguous.length}`,
  `  multi-site: ${multiSite.length}; distribution: ${[...dist.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}:${v}`).join(', ')}`,
  `  max meanings: ${maxGroups} (code ${ambiguous[0].code}); mean: ${meanGroups.toFixed(2)}`,
  '',
  `Held-out (farm, code) pairs: ${n} (code length >= ${MIN_CODE_LEN})`,
  `Retrieval quality (scope-consistent precision/recall):`,
  `  baseline P@1=${(baseline.P1*100).toFixed(1)}%  P@5=${(baseline.P5*100).toFixed(1)}%  R@1=${(baseline.R1*100).toFixed(1)}%  R@5=${(baseline.R5*100).toFixed(1)}%`,
  `  framework P@1=${(framework.P1*100).toFixed(1)}%  P@5=${(framework.P5*100).toFixed(1)}%  R@1=${(framework.R1*100).toFixed(1)}%  R@5=${(framework.R5*100).toFixed(1)}%`,
  `Top-1 scope-consistency accuracy:`,
  `  baseline (naive, no scope): ${(baseline.top1*100).toFixed(1)}% (95% CI ${(baseCI[0]*100).toFixed(1)}--${(baseCI[1]*100).toFixed(1)}%)`,
  `  chance (1/#farms per code): ${(chance*100).toFixed(1)}%`,
  `  framework (scope-bound):     ${(fwTop1*100).toFixed(1)}% (${fwCorrect}/${n}; one-sided 95% lower bound ${(fwLower*100).toFixed(1)}%)`,
  `Evidence-grounding coverage (source path present):`,
  `  framework fault-answers: ${(groundedRate*100).toFixed(1)}% (${fwGrounded}/${fwFault}; ${fwTurbine} turbine-mapping answers)`,
  '',
  'Framework misses (if any):',
  ...details.filter(f => !f.ok).map(f =>
    `  ${f.code} @ ${f.farm}: route=${f.route} topSite=${f.topSite} | ${f.head}`),
  '',
].join('\n')

console.log('\n' + report)
await writeFile(join(root, 'scripts', 'eval-scope-baseline-results.json'), JSON.stringify({
  stats: { records: records.length, codes: byCode.size, ambiguous: ambiguous.length, multiSite: multiSite.length, dist: [...dist.entries()], maxGroups, meanGroups: +meanGroups.toFixed(2) },
  heldOut: n,
  baseline: { top1: +baseline.top1.toFixed(4), P1: +baseline.P1.toFixed(4), P5: +baseline.P5.toFixed(4), R1: +baseline.R1.toFixed(4), R5: +baseline.R5.toFixed(4), ci95: baseCI.map(x => +x.toFixed(4)) },
  chance: +chance.toFixed(4),
  framework: { top1: +fwTop1.toFixed(4), lower95: +fwLower.toFixed(4), P1: 1, P5: 1, R1: +framework.R1.toFixed(4), R5: +framework.R5.toFixed(4), faultAnswers: fwFault, turbineAnswers: fwTurbine, groundedRate: +groundedRate.toFixed(4) },
  details,
}, null, 2), 'utf8')
await writeFile(join(root, 'scripts', 'eval-scope-baseline-report.txt'), report, 'utf8')
console.log('\nResults written to scripts/eval-scope-baseline-results.json and -report.txt')

function classifyRoute(answer) {
  if (/风机编号「/.test(answer) && !/维修处理建议|来源[:：]|故障码/.test(answer)) return 'turbine'
  if (/维修处理建议|来源[:：]|故障码/.test(answer)) return 'fault'
  return 'other'
}
function firstFengchang(answer) {
  const m = answer.match(/风场[:：]\s*([^ /\n]+)/)
  if (!m) return ''
  return m[1].trim().replace(/风电场?$/u, '')
}
async function runAsk(query) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', '--max-turns', '1', `/llmwiki ask ${query}`],
    {
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
    },
  )
  return stdout
}

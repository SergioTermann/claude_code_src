#!/usr/bin/env node
/**
 * 从 turbineMapping.json 抽取 50 条「风场 + 编号 + 故障现象」查询，
 * 调用 hn/dify_web_server_.py 的 build_windrise_response_payload 并统计结果。
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const mappingPath = join(root, 'src', 'data', 'turbineMapping.json')
const indexPath = join(root, '风机故障码', 'fault-index.jsonl')
const serverPath = join(root, 'hn', 'dify_web_server_.py')
const pythonBin = join(root, 'hn', '.venv', 'bin', 'python')
const TARGET = 50

const SUFFIXES = ['怎么处理', '如何处理', '怎么办']
const SYMPTOM_FALLBACK = [
  '机舱温度超限',
  '扭缆',
  '偏航传感器故障',
  '齿轮箱温度高',
  '风速仪故障',
  '振动过大',
]

const mapping = JSON.parse(await readFile(mappingPath, 'utf8'))
const records = (await readFile(indexPath, 'utf8'))
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line))

const siteTurbines = groupTurbinesBySite(mapping)
const sites = [...siteTurbines.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))

const cases = []
const usedKeys = new Set()

// 每个风场轮流取不同编号，尽量覆盖 13 个风场
let siteIdx = 0
let turbineOffset = 0
while (cases.length < TARGET && siteIdx < sites.length * 20) {
  const site = sites[siteIdx % sites.length]
  const turbines = siteTurbines.get(site) || []
  if (turbines.length === 0) {
    siteIdx += 1
    continue
  }
  const turbine = turbines[turbineOffset % turbines.length]
  const symptoms = compatibleSymptomsForTurbine(records, site, turbine)
  const symptom = symptoms[cases.length % Math.max(symptoms.length, 1)] || SYMPTOM_FALLBACK[cases.length % SYMPTOM_FALLBACK.length]
  const suffix = SUFFIXES[cases.length % SUFFIXES.length]
  const query = buildQuery(site, turbine, symptom, suffix)
  const key = `${site}|${turbine.turbineId}|${symptom}`
  if (!usedKeys.has(key)) {
    usedKeys.add(key)
    cases.push({
      id: cases.length + 1,
      site,
      turbineId: turbine.turbineId,
      brand: turbine.brand,
      model: turbine.model,
      symptom,
      query,
    })
  }
  siteIdx += 1
  if (siteIdx % sites.length === 0) turbineOffset += 1
}

console.log(`生成 ${cases.length} 条测试（覆盖 ${new Set(cases.map(c => c.site)).size} 个风场）\n`)

const results = []
for (const testCase of cases) {
  process.stdout.write(`[${testCase.id}/${cases.length}] ${testCase.site} ${testCase.turbineId} ... `)
  const payload = await callWindrisePayload(testCase.query)
  const classification = classifyResult(payload, testCase)
  results.push({ ...testCase, ...payload, classification })
  process.stdout.write(`${classification}\n`)
}

const stats = summarize(results)
const report = formatReport(results, stats)
console.log('\n' + report)

const outJson = join(root, 'scripts', 'eval-windrise-50-results.json')
const outTxt = join(root, 'scripts', 'eval-windrise-50-report.txt')
await writeFile(outJson, JSON.stringify({ cases: results, stats }, null, 2), 'utf8')
await writeFile(outTxt, report, 'utf8')
console.log(`\n详细结果已写入:\n  ${outJson}\n  ${outTxt}`)

function groupTurbinesBySite(entries) {
  const bySite = new Map()
  for (const entry of entries) {
    if (!entry?.site || !entry?.turbineId) continue
    if (/^&#/i.test(entry.turbineId)) continue
    const list = bySite.get(entry.site) || []
    if (!list.some(item => item.turbineId === entry.turbineId)) list.push(entry)
    bySite.set(entry.site, list)
  }
  for (const list of bySite.values()) {
    list.sort((a, b) => a.turbineId.localeCompare(b.turbineId, 'zh-CN'))
  }
  return bySite
}

function compatibleSymptomsForTurbine(records, site, turbine) {
  const matched = records.filter(r => recordMatchesTurbineContext(r, site, turbine))
  const names = []
  for (const record of matched) {
    const name = String(record.name || record.description || '').trim()
    if (!name || name.length < 2 || names.includes(name)) continue
    names.push(name)
    if (names.length >= 6) break
  }
  const preferred = []
  for (const symptom of [...names, ...SYMPTOM_FALLBACK]) {
    if (preferred.includes(symptom)) continue
    if (!matched.some(r => recordTextIncludesSymptom(r, symptom))) continue
    preferred.push(symptom)
    if (preferred.length >= 4) break
  }
  return preferred
}

function recordMatchesTurbineContext(record, site, turbine) {
  const sites = String(record.site || '')
    .split(/[、,，;；/]/u)
    .map(s => s.trim())
    .filter(Boolean)
  if (sites.length > 0 && !sites.some(s => s.includes(site) || site.includes(s))) return false
  if (record.brand && turbine.brand && record.brand !== turbine.brand) return false
  const recordIds = String(record.turbineIds || '')
    .split(/[、,，;；/]/u)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
  const target = String(turbine.turbineId || '').trim().toUpperCase()
  const bare = target.replace(/#$/, '')
  if (
    recordIds.length > 0 &&
    (recordIds.includes(target) || recordIds.includes(bare) || recordIds.includes(`${bare}#`))
  ) return true
  const models = [record.model, record.standardModel].map(normalizeModelKey).filter(Boolean)
  const turbineModels = [turbine.model, turbine.standardModel].map(normalizeModelKey).filter(Boolean)
  if (!models.length || !turbineModels.length) return false
  return models.some(m => turbineModels.includes(m))
}

function recordTextIncludesSymptom(record, symptom) {
  const haystack = [record.name, record.description, record.reason, record.solution, record.code]
    .filter(Boolean)
    .join(' ')
  if (haystack.includes(symptom)) return true
  if (symptom === '扭缆') return /扭缆|纽缆|绕缆/.test(haystack)
  return false
}

function normalizeModelKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/系列$/u, '').trim()
}

function buildQuery(site, turbine, symptom, suffix) {
  const id = turbine.turbineId
  const displayId = /^\d+$/.test(id.replace(/#$/, ''))
    ? `${id.replace(/#$/, '')}号`
    : id.replace(/#$/, '')
  return `${site}风场${displayId}风机${symptom}故障，${suffix}`
}

async function callWindrisePayload(query) {
  const script = `
import importlib.util, json, os, re, sys
os.chdir(${JSON.stringify(join(root, 'hn'))})
spec = importlib.util.spec_from_file_location('srv', ${JSON.stringify(serverPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
query = sys.argv[1]
answer, route = mod.build_windrise_response_payload(query, [])
ids = mod.extract_windrise_turbine_ids_from_text(query)
slots = mod.build_effective_windrise_slots_for_query(query, [])
codes = re.findall(r'\\b(\\d{4,6})\\b', answer or '')
top_code = ''
m = re.search(r'\\*\\*(\\d+)｜([^*]+)\\*\\*', answer or '')
if m:
    top_code = m.group(1)
    top_name = m.group(2).strip()
else:
    top_name = ''
print(json.dumps({
    'reason': route.get('reason', ''),
    'turbine_ids': ids,
    'slot_turbine': slots.get('turbine_id', ''),
    'slot_farm': slots.get('farm', ''),
    'slot_brand': slots.get('brand', ''),
    'top_code': top_code,
    'top_name': top_name,
    'codes': codes[:5],
    'structured_header': bool(re.search(r'维修处理建议|原因分析|复位说明', answer or '')),
    'answer_head': '\\n'.join((answer or '').splitlines()[:6]),
    'need_more': '需要补充定位条件' in (answer or ''),
    'no_match': mod.is_windrise_no_match_answer(answer or ''),
    'record_count': len(re.findall(r'匹配到\\s*(\\d+)\\s*条', answer or '')) and int(re.search(r'匹配到\\s*(\\d+)\\s*条', answer or '').group(1)) if re.search(r'匹配到\\s*(\\d+)\\s*条', answer or '') else 0,
}, ensure_ascii=False))
`
  const { stdout } = await execFileAsync(pythonBin, ['-c', script, query], {
    cwd: join(root, 'hn'),
    env: {
      ...process.env,
      WINDRISE_CWD: root,
      LLMWIKI_PROJECT: join(root, '风机故障码'),
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 300_000,
  })
  const jsonLine = stdout
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .pop()
  if (!jsonLine) throw new Error(`No JSON in python output: ${stdout.slice(0, 200)}`)
  return JSON.parse(jsonLine)
}

function classifyResult(payload, testCase) {
  const answer = payload.answer_head || ''
  const hasStructuredHeader = /^\S+\s+维修处理建议/m.test(answer) || /维修处理建议/.test(answer.split('\n')[0] || '')
  const hasCodeLine = /\*\*[^*]+｜[^*]+\*\*/.test(answer) || /^\d+\.\s*\*?\*?[A-Z]?\d/.test(answer)
  if (payload.no_match) return '无匹配'
  if (payload.need_more) return '需补充定位'
  if (hasStructuredHeader && hasCodeLine) return `结构化 ${payload.top_code || payload.codes?.[0] || ''}`.trim()
  if (payload.top_code) return `命中故障码 ${payload.top_code}`
  if (payload.reason === 'index_scoped_fault_lookup') return '索引结构化答复'
  if (payload.reason) return `路由:${payload.reason}`
  return '其他答复'
}

function summarize(results) {
  const byClass = new Map()
  const bySite = new Map()
  const byReason = new Map()
  let ok = 0
  let bad = 0
  let structured = 0
  for (const r of results) {
    byClass.set(r.classification, (byClass.get(r.classification) || 0) + 1)
    bySite.set(r.site, (bySite.get(r.site) || { total: 0, ok: 0, bad: 0, structured: 0 }))
    const siteStat = bySite.get(r.site)
    siteStat.total += 1
    if (r.structured_header) {
      structured += 1
      siteStat.structured += 1
    }
    if (r.need_more || r.no_match) {
      bad += 1
      siteStat.bad += 1
    } else {
      ok += 1
      siteStat.ok += 1
    }
    const reason = r.reason || '(empty)'
    byReason.set(reason, (byReason.get(reason) || 0) + 1)
  }
  return { byClass, bySite, byReason, ok, bad, structured, total: results.length }
}

function formatReport(results, stats) {
  const lines = []
  lines.push('='.repeat(60))
  lines.push('风场+编号 50 条批量测试统计')
  lines.push('='.repeat(60))
  lines.push(`总计: ${stats.total}  成功: ${stats.ok}  失败: ${stats.bad}  统一结构化顶格展示: ${stats.structured}`)
  lines.push(`成功率: ${((stats.ok / stats.total) * 100).toFixed(1)}%`)
  lines.push('')
  lines.push('按结果类型:')
  for (const [k, v] of [...stats.byClass.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${v}`)
  }
  lines.push('')
  lines.push('按路由 reason:')
  for (const [k, v] of [...stats.byReason.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k}: ${v}`)
  }
  lines.push('')
  lines.push('按风场:')
  for (const [site, s] of [...stats.bySite.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
    lines.push(`  ${site}: ${s.ok}/${s.total} 成功, 结构化 ${s.structured}/${s.total}`)
  }
  lines.push('')
  lines.push('失败/需补充定位 明细:')
  const failures = results.filter(r => r.need_more || r.no_match)
  if (failures.length === 0) {
    lines.push('  (无)')
  } else {
    for (const f of failures) {
      lines.push(`  #${f.id} ${f.site} ${f.turbineId} | ${f.query}`)
      lines.push(`      => ${f.classification} reason=${f.reason} records=${f.record_count}`)
    }
  }
  lines.push('')
  lines.push('成功样例 (前 10 条):')
  for (const r of results.filter(x => !x.need_more && !x.no_match).slice(0, 10)) {
    lines.push(`  #${r.id} ${r.site} ${r.turbineId} | ${r.top_code || '-'} ${r.top_name || ''}`)
    lines.push(`      查询: ${r.query}`)
  }
  return lines.join('\n')
}

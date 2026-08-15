#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const project = join(root, '风机故障码')
const indexPath = join(project, 'fault-index.jsonl')
const mappingPath = join(root, 'src', 'data', 'turbineMapping.json')

const SYMPTOMS = [
  '扭缆',
  '偏航传感器故障',
  '齿轮箱温度高',
  '机舱温度超限',
  '风速仪故障',
  '偏航电机反馈异常',
  '润滑不足',
  '振动过大',
]

const PHRASING_SUFFIXES = [
  '',
  '怎么处理',
  '如何处理',
  '怎么办',
  '存在故障',
]

const curated = [
  {
    name: '洮北58号偏航传感器',
    query: '洮北58号偏航传感器故障怎么处理',
    expects: ['偏航传感器', '歌美飒', '洮北', '100'],
    rejects: ['故障码 58 未找到', '需要补充定位', '风机编号「58'],
  },
  {
    name: '四平SH09机舱温度超限',
    query: '四平风场SH09风机存在机舱温度超限故障，如何处理?',
    expects: ['270011', '机舱温度', '上海电气', '四平'],
    rejects: ['需要补充定位', '431 条'],
  },
  {
    name: '团结S03扭缆',
    query: '团结 S03 扭缆',
    expects: ['扭缆', '团结', '三一'],
    rejects: ['本地答案：S03', '需要补充定位', 'No matches'],
  },
  {
    name: '洮北59号709',
    query: '洮北 59# 709',
    expects: ['709', '纽缆', '洮北'],
    rejects: ['未找到与', '5012'],
  },
  {
    name: '什花道SY03 709',
    query: '什花道 SY03 709',
    expects: ['709', '什花道', '三一'],
    rejects: ['未找到与', '团结风电场'],
  },
  {
    name: '四平S01# 709',
    query: '四平 S01# 709',
    expects: ['709', '四平', '风机编号：S01'],
    rejects: ['未找到与', '5012'],
  },
  {
    name: '洮北01号709',
    query: '洮北01号709故障怎么处理',
    expects: ['709', '洮北'],
    rejects: ['故障码 01 未找到', '故障码 1 未找到', '需要补充定位'],
  },
  {
    name: '团结HY01#偏航',
    query: '团结 HY01# 偏航电机反馈异常',
    expects: ['偏航', '团结'],
    rejects: ['本地答案：HY01', 'No matches'],
  },
]

const generated = await buildGeneratedCases()
const cases = [...curated, ...generated]

let passed = 0
let failed = 0
const failures = []
const byGroup = new Map()

console.log(`Site+turbine fault eval: ${cases.length} cases\n`)

for (const testCase of cases) {
  const group = testCase.group || 'curated'
  byGroup.set(group, (byGroup.get(group) || 0) + 1)
  process.stdout.write(`- [${group}] ${testCase.name}... `)
  try {
    const answer = await ask(testCase.query)
    if (testCase.expectNoMatch) {
      if (!/^No matches/i.test(answer)) {
        throw new Error(`Expected no match for ${JSON.stringify(testCase.query)}`)
      }
    } else {
      if (/^No matches/i.test(answer)) {
        throw new Error(`No matches for ${JSON.stringify(testCase.query)}`)
      }
      if (/^\#\# 本地答案：[^\n]+\n\n\*\*结论：\*\* 风机编号「/.test(answer)) {
        throw new Error('Returned turbine mapping instead of fault search')
      }
      for (const expected of testCase.expects || []) {
        if (!answer.includes(expected)) {
          throw new Error(`Expected ${JSON.stringify(expected)} in answer`)
        }
      }
      for (const rejected of testCase.rejects || []) {
        if (answer.includes(rejected)) {
          throw new Error(`Did not expect ${JSON.stringify(rejected)} in answer`)
        }
      }
    }
    passed += 1
    process.stdout.write('OK\n')
  } catch (error) {
    failed += 1
    failures.push({ ...testCase, error: error.message })
    process.stdout.write('FAIL\n')
  }
}

console.log(`\nSite+turbine fault eval: ${passed} passed, ${failed} failed (${cases.length} total).`)
for (const [group, count] of [...byGroup.entries()].sort()) {
  console.log(`  ${group}: ${count}`)
}

if (failures.length > 0) {
  for (const failure of failures.slice(0, 30)) {
    console.error(`\n=== ${failure.name} ===`)
    console.error(failure.error)
    if (failure.query) console.error(`Query: ${failure.query}`)
  }
  if (failures.length > 30) {
    console.error(`\n... and ${failures.length - 30} more failures`)
  }
  process.exit(1)
}

async function buildGeneratedCases() {
  const mapping = JSON.parse(await readFile(mappingPath, 'utf8'))
  const records = (await readFile(indexPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))

  const siteTurbines = groupTurbinesBySite(mapping)
  const prioritySites = [
    '洮北',
    '四平',
    '团结',
    '新华',
    '什花道',
    '前进',
    '镇赉',
    '同发',
    '裕民',
  ]

  const result = []
  for (const site of prioritySites) {
    const turbines = siteTurbines.get(site) || []
    if (turbines.length === 0) continue

    for (const turbine of turbines.slice(0, 3)) {
      const symptoms = compatibleSymptomsForTurbine(records, site, turbine)
      if (symptoms.length === 0) continue

      for (const symptom of symptoms.slice(0, 4)) {
        for (const suffix of PHRASING_SUFFIXES.slice(0, 2)) {
          const query = buildQuery(site, turbine, symptom, suffix)
          result.push({
            group: `generated:${site}`,
            name: `${site} ${turbine.turbineId} ${symptom}${suffix ? ` ${suffix}` : ''}`,
            query,
            expects: uniqueNonEmpty([
              site,
              turbine.brand,
              symptom.replace(/故障$/, '').slice(0, 2),
            ]),
            rejects: [
              '需要补充定位',
              `本地答案：${turbine.turbineId}`,
              `风机编号「${turbine.turbineId}」对应`,
              'No matches',
            ],
          })
        }
      }
    }
  }

  return result
}

function compatibleSymptomsForTurbine(records, site, turbine) {
  const matchedRecords = records.filter(record =>
    recordMatchesTurbineContext(record, site, turbine),
  )
  const names = []
  for (const record of matchedRecords) {
    const name = String(record.name || record.description || '').trim()
    if (!name || name.length < 2) continue
    if (names.includes(name)) continue
    names.push(name)
    if (names.length >= 8) break
  }

  const preferred = []
  for (const symptom of [...names, ...SYMPTOMS]) {
    if (preferred.includes(symptom)) continue
    if (!matchedRecords.some(record => recordTextIncludesSymptom(record, symptom))) {
      continue
    }
    preferred.push(symptom)
    if (preferred.length >= 4) break
  }
  return preferred
}

function recordMatchesTurbineContext(record, site, turbine) {
  const sites = String(record.site || '')
    .split(/[、,，;；/]/u)
    .map(item => item.trim())
    .filter(Boolean)
  if (sites.length > 0 && !sites.some(item => item.includes(site) || site.includes(item))) {
    return false
  }
  if (record.brand && turbine.brand && record.brand !== turbine.brand) return false

  const recordIds = String(record.turbineIds || '')
    .split(/[、,，;；/]/u)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
  const target = String(turbine.turbineId || '').trim().toUpperCase()
  const targetBare = target.replace(/#$/, '')
  if (
    recordIds.length > 0 &&
    (recordIds.includes(target) ||
      recordIds.includes(targetBare) ||
      recordIds.includes(`${targetBare}#`))
  ) {
    return true
  }

  const models = [record.model, record.standardModel]
    .map(value => normalizeModelKey(value))
    .filter(Boolean)
  const turbineModels = [turbine.model, turbine.standardModel]
    .map(value => normalizeModelKey(value))
    .filter(Boolean)
  if (models.length === 0 || turbineModels.length === 0) return false
  return models.some(model => turbineModels.includes(model))
}

function recordTextIncludesSymptom(record, symptom) {
  const needle = String(symptom || '').trim()
  if (!needle) return false
  const haystack = [
    record.name,
    record.description,
    record.reason,
    record.solution,
    record.code,
  ]
    .filter(Boolean)
    .join(' ')
  if (haystack.includes(needle)) return true
  if (needle === '扭缆') return /扭缆|纽缆|绕缆/.test(haystack)
  return false
}

function normalizeModelKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/系列$/u, '')
    .trim()
}

function groupTurbinesBySite(mapping) {
  const bySite = new Map()
  for (const entry of mapping) {
    if (!entry?.site || !entry?.turbineId) continue
    if (/^&#/i.test(entry.turbineId)) continue
    const list = bySite.get(entry.site) || []
    if (!list.some(item => item.turbineId === entry.turbineId)) {
      list.push(entry)
    }
    bySite.set(entry.site, list)
  }
  for (const list of bySite.values()) {
    list.sort((a, b) => a.turbineId.localeCompare(b.turbineId, 'zh-CN'))
  }
  return bySite
}

function buildQuery(site, turbine, symptom, suffix) {
  const id = turbine.turbineId
  const displayId = /^\d+$/.test(id.replace(/#$/, ''))
    ? `${id.replace(/#$/, '')}号`
    : id.replace(/#$/, '')
  // Always keep spaces so IDs are not glued to English/numeric symptom tokens
  // (e.g. SY013s..., C02Safety...).
  return suffix
    ? `${site} ${displayId} ${symptom} ${suffix}`
    : `${site} ${displayId} ${symptom}`
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter(Boolean))]
}

async function ask(query) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', `/llmwiki ask ${query} --limit 4`],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: project,
        WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
        ANTHROPIC_MODEL_PROVIDER: process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
        LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
        LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  return stdout.trim()
}

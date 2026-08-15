#!/usr/bin/env node

/**
 * Regression suite for turbine-ID recognition (SH09 / C01 / 编号 / site+ID).
 * Covers: lookup helper, TS utils, windrise farm path, llmwiki ask.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import esbuild from 'esbuild'
import {
  extractTurbineIdsFromText as extractIdsMjs,
  lookupTurbineMapping as lookupMjs,
  resolveTurbineMappingAnswer,
  shouldAnswerTurbineMappingQuestion,
} from './turbine-mapping-lookup.mjs'

const execFileAsync = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const ALL_TURBINE_ENTRIES = JSON.parse(
  readFileSync(join(root, 'src', 'data', 'turbineMapping.json'), 'utf8'),
)

function isValidTurbineEntry(entry) {
  const id = String(entry?.turbineId || '').trim().toUpperCase()
  if (!id) return false
  if (id.includes('&#') || id.includes(';') || id.includes('\n')) return false
  if (!/^([A-Z]{0,4}\d{1,3}#?|\d{1,3}#)$/u.test(id)) return false
  if (!entry.site || !entry.brand) return false
  return true
}

function sampleDiverseTurbineEntries() {
  const bySite = new Map()
  for (const entry of ALL_TURBINE_ENTRIES) {
    if (!isValidTurbineEntry(entry)) continue
    const list = bySite.get(entry.site) || []
    list.push(entry)
    bySite.set(entry.site, list)
  }

  const samples = []
  for (const [site, list] of [...bySite.entries()].sort((a, b) =>
    a[0].localeCompare(b[0], 'zh-Hans-CN'),
  )) {
    const picks = [
      list[0],
      list[Math.floor(list.length / 6)],
      list[Math.floor(list.length / 3)],
      list[Math.floor(list.length / 2)],
      list[Math.floor((list.length * 2) / 3)],
      list[Math.floor((list.length * 5) / 6)],
      list[list.length - 1],
    ]
    const withUnit = list.find(item => /^\d+$/.test(String(item.unitNumber || '')))
    if (withUnit) picks.push(withUnit)
    const seen = new Set()
    for (const item of picks) {
      if (!item) continue
      const key = `${item.site}|${item.turbineId}|${item.unitNumber}`
      if (seen.has(key)) continue
      seen.add(key)
      samples.push(item)
    }
  }

  // Extra ambiguous-prefix coverage across sites.
  for (const prefix of ['SH', 'S', 'C', 'SY', 'Y', 'MY', 'ZC', 'CL', 'H', 'J']) {
    const matches = ALL_TURBINE_ENTRIES.filter(
      item =>
        isValidTurbineEntry(item) &&
        String(item.turbineId).toUpperCase().replace(/#$/, '').startsWith(prefix),
    )
    const bySitePrefix = new Map()
    for (const item of matches) {
      if (!bySitePrefix.has(item.site)) bySitePrefix.set(item.site, item)
    }
    for (const item of bySitePrefix.values()) samples.push(item)
  }

  const uniq = []
  const seen = new Set()
  for (const item of samples) {
    const key = `${item.site}|${item.turbineId}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(item)
  }
  return uniq
}

let failed = 0
let passed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function includesAll(text, expects) {
  return expects.every(item => text.includes(item))
}

function includesNone(text, rejects) {
  return (rejects || []).every(item => !text.includes(item))
}

async function loadTsTurbineUtils() {
  const outfile = join(tmpdir(), `turbine-mapping-eval-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [join(root, 'src', 'utils', 'turbineMapping.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  return import(`${outfile}?t=${Date.now()}`)
}

async function loadLlmwiki() {
  const outfile = join(tmpdir(), `llmwiki-eval-${Date.now()}.mjs`)
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

async function runWindriseFarm(query) {
  const { stdout, stderr } = await execFileAsync(
    join(root, 'bin', 'windrise'),
    ['farm', query],
    {
      cwd: root,
      env: {
        ...process.env,
        WINDRISE_CWD: root,
        LLMWIKI_PROJECT: join(root, '风机故障码'),
      },
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    },
  )
  return `${stdout}\n${stderr}`
}

async function runLlmwikiAsk(query) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', `/llmwiki ask ${query} --limit 4`],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: join(root, '风机故障码'),
      },
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  return `${stdout}\n${stderr}`
}

const extractCases = [
  { q: 'SH09', expectIds: ['SH09'] },
  { q: 'sh09', expectIds: ['SH09'] },
  { q: 'SH09#', expectIds: ['SH09#'] },
  { q: 'SH01', expectIds: ['SH01'] },
  { q: 'SH22', expectIds: ['SH22'] },
  { q: '编号SH09', expectIds: ['SH09'] },
  { q: '编号：SH09', expectIds: ['SH09'] },
  { q: '风机编号SH09', expectIds: ['SH09'] },
  { q: '机组编号 SH09', expectIds: ['SH09'] },
  { q: '四平SH09', expectIds: ['SH09'] },
  { q: '四平风场SH09', expectIds: ['SH09'] },
  { q: '富荣SH09', expectIds: ['SH09'] },
  { q: '富荣SH32', expectIds: ['SH32'] },
  { q: 'C01', expectIds: ['C01'] },
  { q: '洮北58号', expectIds: ['58#'] },
  { q: '团结 S03', expectIds: ['S03'] },
  { q: '四平 S01#', expectIds: ['S01#'] },
]

const mappingAnswerCases = [
  {
    name: 'SH09 maps to 富荣 LeapX',
    q: 'SH09',
    expects: ['风机编号「SH09」', '富荣', '上海电气', 'LeapX', 'EW6.25N-202'],
    rejects: ['该机型对应的风场如下', 'W2000'],
  },
  {
    name: '四平SH09 maps to W2000 SH09#',
    q: '四平SH09',
    expects: ['风机编号「SH09#」', '四平', '上海电气', 'W2000', 'W2000C-93-80'],
    rejects: ['LeapX', '该机型对应的风场如下'],
  },
  {
    name: '四平风场SH09 maps to W2000',
    q: '四平风场SH09',
    expects: ['SH09#', '四平', 'W2000'],
    rejects: ['LeapX', '该机型对应的风场如下'],
  },
  {
    name: '编号SH09 maps to turbine',
    q: '编号SH09',
    expects: ['风机编号「SH09」', '富荣'],
    rejects: ['该机型对应的风场如下'],
  },
  {
    name: 'SH09是什么型号',
    q: 'SH09是什么型号',
    expects: ['风机编号「SH09」', '富荣', 'LeapX'],
    rejects: ['该机型对应的风场如下'],
  },
  {
    name: '富荣SH09',
    q: '富荣SH09',
    expects: ['风机编号「SH09」', '富荣', 'LeapX'],
    rejects: ['W2000'],
  },
  {
    name: '四平C01 maps to 新誉',
    q: '四平C01',
    expects: ['风机编号「C01#」', '四平', '新誉'],
  },
  {
    name: '洮北58号 maps to 歌美飒',
    q: '洮北58号',
    expects: ['58#', '洮北', '歌美飒'],
  },
  {
    name: '富荣SH01 maps to LeapX',
    q: '富荣SH01',
    expects: ['风机编号「SH01」', '富荣', 'LeapX'],
  },
  {
    name: '四平SH01 maps to W2000',
    q: '四平SH01',
    expects: ['风机编号「SH01#」', '四平', 'W2000'],
    rejects: ['LeapX'],
  },
  {
    name: '团结S03 maps to 三一',
    q: '团结S03',
    expects: ['S03', '团结', '三一'],
  },
]

const noMappingAnswerCases = [
  'SH09机舱温度超限',
  '四平风场SH09风机存在机舱温度超限故障，如何处理?',
  '四平 SH09 机舱温度超限',
  'SH09 偏航传感器故障怎么处理',
]

const lookupCases = [
  { id: 'SH09', site: '', expectSite: '富荣', expectModel: 'LeapX' },
  { id: 'SH09', site: '四平', expectSite: '四平', expectModel: 'W2000', expectId: 'SH09#' },
  { id: 'SH09#', site: '四平', expectSite: '四平', expectModel: 'W2000' },
  { id: 'SH09', site: '富荣', expectSite: '富荣', expectModel: 'LeapX' },
  { id: '09', site: '富荣', expectSite: '富荣', expectId: 'SH09' },
  { id: '09#', site: '富荣', expectSite: '富荣', expectId: 'SH09' },
  { id: '75', site: '四平', expectSite: '四平', expectId: 'SH09#' },
  { id: '75#', site: '四平', expectSite: '四平', expectId: 'SH09#' },
  { id: 'C01', site: '四平', expectSite: '四平', expectId: 'C01#' },
  { id: '58#', site: '洮北', expectSite: '洮北', expectId: '58#' },
]

async function main() {
  console.log('=== turbine-mapping-lookup.mjs ===')
  for (const item of extractCases) {
    const ids = extractIdsMjs(item.q)
    check(
      `mjs extract: ${item.q}`,
      item.expectIds.every(id => ids.includes(id)),
      `got ${JSON.stringify(ids)}`,
    )
  }

  for (const item of lookupCases) {
    const entry = lookupMjs(item.id, item.site)
    const ok =
      entry &&
      (!item.expectSite || entry.site === item.expectSite) &&
      (!item.expectModel || String(entry.model).includes(item.expectModel)) &&
      (!item.expectId || entry.turbineId === item.expectId)
    check(
      `mjs lookup: ${item.id}@${item.site || '*'}`,
      Boolean(ok),
      entry ? JSON.stringify(entry) : 'null',
    )
  }

  for (const item of mappingAnswerCases) {
    const answer = resolveTurbineMappingAnswer(item.q)
    check(
      `mjs answer: ${item.name}`,
      includesAll(answer, item.expects) && includesNone(answer, item.rejects),
      answer.slice(0, 180).replace(/\n/g, ' | '),
    )
  }

  for (const q of noMappingAnswerCases) {
    check(
      `mjs no bare-mapping for fault query: ${q.slice(0, 24)}...`,
      !shouldAnswerTurbineMappingQuestion(q) && !resolveTurbineMappingAnswer(q),
    )
  }

  console.log('\n=== src/utils/turbineMapping.ts ===')
  const tm = await loadTsTurbineUtils()
  for (const item of extractCases) {
    const ids = tm.extractTurbineIdsFromText(item.q)
    check(
      `ts extract: ${item.q}`,
      item.expectIds.every(id => ids.includes(id)),
      `got ${JSON.stringify(ids)}`,
    )
  }
  for (const item of lookupCases) {
    const entry = tm.lookupTurbineMapping(item.id, item.site || undefined)
    const ok =
      entry &&
      (!item.expectSite || entry.site === item.expectSite) &&
      (!item.expectModel || String(entry.model).includes(item.expectModel)) &&
      (!item.expectId || entry.turbineId === item.expectId)
    check(
      `ts lookup: ${item.id}@${item.site || '*'}`,
      Boolean(ok),
      entry ? `${entry.turbineId}/${entry.site}/${entry.model}` : 'null',
    )
  }
  for (const item of mappingAnswerCases) {
    const should = tm.shouldAnswerTurbineMappingQuestion(item.q)
    const entry = tm.resolveTurbineContextFromQuery(item.q)
    const answer = entry && should ? tm.renderTurbineMappingAnswer(entry) : ''
    check(
      `ts answer: ${item.name}`,
      should && includesAll(answer, item.expects) && includesNone(answer, item.rejects),
      answer.slice(0, 180).replace(/\n/g, ' | '),
    )
  }
  for (const q of noMappingAnswerCases) {
    check(
      `ts no bare-mapping for fault query: ${q.slice(0, 24)}...`,
      !tm.shouldAnswerTurbineMappingQuestion(q),
    )
  }

  console.log('\n=== windrise farm path ===')
  for (const item of [
    {
      q: 'SH09',
      expects: ['风机编号「SH09」', '富荣', 'LeapX'],
      rejects: ['该机型对应的风场如下', '查询结果：'],
    },
    {
      q: '四平SH09',
      expects: ['风机编号「SH09#」', '四平', 'W2000'],
      rejects: ['该机型对应的风场如下', 'LeapX'],
    },
    {
      q: '编号SH09',
      expects: ['风机编号「SH09」', '富荣'],
      rejects: ['该机型对应的风场如下'],
    },
  ]) {
    const out = await runWindriseFarm(item.q)
    check(
      `windrise farm: ${item.q}`,
      includesAll(out, item.expects) && includesNone(out, item.rejects),
      out.split('\n').find(line => line.includes('风机编号') || line.includes('该机型') || line.includes('查询结果')) || out.slice(0, 160),
    )
  }

  console.log('\n=== llmwiki ask (bundled) ===')
  const llmwiki = await loadLlmwiki()
  for (const item of [
    {
      q: 'SH09',
      expects: ['风机编号「SH09」', '富荣', 'LeapX'],
      rejects: ['该机型对应的风场如下', '机舱温度超限'],
    },
    {
      q: '四平SH09',
      expects: ['SH09#', '四平', 'W2000'],
      rejects: ['LeapX'],
    },
    {
      q: '编号SH09',
      expects: ['风机编号「SH09」', '富荣'],
    },
    {
      q: '四平C01',
      expects: ['风机编号「C01#」', '四平', '新誉'],
    },
    {
      q: '洮北58号',
      expects: ['58#', '洮北', '歌美飒'],
    },
    {
      q: '四平风场SH09风机存在机舱温度超限故障，如何处理?',
      expects: ['机舱温度超限', '270011', '四平', 'W2000'],
      rejects: ['风机编号「SH09」对应 富荣', 'LeapX系列'],
    },
    {
      q: '洮北58号偏航传感器故障怎么处理',
      expects: ['偏航传感器', '洮北'],
      rejects: ['风机编号「58'],
    },
    {
      q: '团结 S03 扭缆',
      expects: ['扭缆', '团结'],
    },
  ]) {
    const result = await llmwiki.call(`ask ${item.q} --limit 4`)
    const text = String(result?.value || result || '')
    check(
      `llmwiki ask: ${item.q.slice(0, 28)}`,
      includesAll(text, item.expects) && includesNone(text, item.rejects),
      text.split('\n').slice(0, 4).join(' | '),
    )
  }

  console.log('\n=== llmwiki via runner (smoke) ===')
  for (const item of [
    {
      q: 'SH09',
      expects: ['风机编号「SH09」', '富荣'],
      rejects: ['该机型对应的风场如下'],
    },
    {
      q: '四平SH09',
      expects: ['四平', 'W2000'],
      rejects: ['LeapX'],
    },
  ]) {
    const text = await runLlmwikiAsk(item.q)
    check(
      `runner ask: ${item.q}`,
      includesAll(text, item.expects) && includesNone(text, item.rejects),
      text.split('\n').slice(0, 3).join(' | '),
    )
  }

  // Python path if available
  console.log('\n=== python web helpers ===')
  const diverse = sampleDiverseTurbineEntries()
  try {
    const { writeFile, unlink } = await import('node:fs/promises')
    const py = process.env.PYTHON || '/opt/miniconda3/bin/python3.13'
    const scriptPath = join(root, 'hn', `_py_turbine_eval_${Date.now()}.py`)
    const pyCases = [
      ['SH09', ['富荣', 'LeapX'], true],
      ['四平SH09', ['四平', 'W2000', 'SH09#'], true],
      ['编号SH09', ['富荣', 'SH09'], true],
      ['富荣 09号', ['富荣', 'SH09'], true],
      ['四平 75号', ['四平', 'SH09#'], true],
      ['四平C01', ['四平', 'C01#', '新誉'], true],
      ['洮北58号', ['洮北', '58#', '歌美飒'], true],
      ['SH09机舱温度超限', [], false],
      ...diverse.slice(0, 40).map(entry => [
        `${entry.site}${entry.turbineId}`,
        [entry.site, entry.turbineId, entry.brand],
        true,
      ]),
    ]
    await writeFile(
      scriptPath,
      `
import dify_web_server_ as s
import json
cases = json.loads(${JSON.stringify(JSON.stringify(pyCases))})
failed = 0
for q, expects, should in cases:
    ans = s.build_windrise_turbine_mapping_answer(q) or ''
    ok = (bool(ans) == should) and all(x in ans for x in expects)
    print(('PASS' if ok else 'FAIL'), q, '=>', (ans.splitlines()[0] if ans else '(empty)'))
    if not ok:
        failed += 1
        print('  expects', expects, 'should', should)
print('PYTHON_FAILED', failed)
`,
      'utf8',
    )
    try {
      const { stdout } = await execFileAsync(py, [scriptPath], {
        cwd: join(root, 'hn'),
        env: {
          ...process.env,
          WINDRISE_CWD: root,
          LLMWIKI_PROJECT: join(root, '风机故障码'),
          PYTHONPATH: [
            join(root, 'hn'),
            join(root, 'hn', '.venv', 'lib', 'python3.13', 'site-packages'),
          ].join(':'),
        },
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      })
      for (const line of stdout.split('\n')) {
        if (line.startsWith('PASS ') || line.startsWith('FAIL ')) {
          check(`py ${line.slice(5)}`, line.startsWith('PASS '))
        }
      }
    } finally {
      await unlink(scriptPath).catch(() => {})
    }
  } catch (error) {
    check('python helpers available', false, error.message)
  }

  console.log(`\n=== diverse IDs across sites (${diverse.length}) ===`)
  for (const entry of diverse) {
    const bareId = String(entry.turbineId).replace(/#$/, '')
    const extractQueries = [
      `${entry.site}${entry.turbineId}`,
      `${entry.site} ${entry.turbineId}`,
      `${entry.site}编号${entry.turbineId}`,
    ]
    if (entry.unitNumber && /^\d+$/.test(String(entry.unitNumber))) {
      extractQueries.push(`${entry.site}${Number.parseInt(entry.unitNumber, 10)}号`)
    }

    for (const q of extractQueries) {
      const ids = extractIdsMjs(q)
      const extractedOk =
        ids.includes(entry.turbineId) ||
        ids.includes(bareId) ||
        ids.includes(`${bareId}#`) ||
        (entry.unitNumber &&
          (ids.includes(String(entry.unitNumber)) ||
            ids.includes(`${Number.parseInt(entry.unitNumber, 10)}#`) ||
            ids.includes(`${String(entry.unitNumber)}#`)))
      check(
        `diverse extract: ${q}`,
        extractedOk,
        `got ${JSON.stringify(ids)} expect ~${entry.turbineId}`,
      )
    }

    const looked = lookupMjs(entry.turbineId, entry.site) || lookupMjs(bareId, entry.site)
    check(
      `diverse lookup: ${entry.turbineId}@${entry.site}`,
      Boolean(
        looked &&
          looked.site === entry.site &&
          looked.turbineId === entry.turbineId &&
          looked.brand === entry.brand,
      ),
      looked ? `${looked.turbineId}/${looked.site}/${looked.brand}` : 'null',
    )

    const answerQ = `${entry.site}${entry.turbineId}`
    const answer = resolveTurbineMappingAnswer(answerQ)
    check(
      `diverse answer: ${answerQ}`,
      includesAll(answer, [entry.site, entry.turbineId, entry.brand]),
      answer.slice(0, 140).replace(/\n/g, ' | '),
    )

    if (entry.unitNumber && /^\d+$/.test(String(entry.unitNumber))) {
      const unitValue = String(entry.unitNumber)
      const sameUnitCount = ALL_TURBINE_ENTRIES.filter(
        item =>
          item.site === entry.site &&
          /^\d+$/.test(String(item.unitNumber || '')) &&
          Number.parseInt(String(item.unitNumber), 10) === Number.parseInt(unitValue, 10),
      ).length
      if (sameUnitCount === 1) {
        const unitQ = `${entry.site}${Number.parseInt(unitValue, 10)}号`
        const unitAnswer = resolveTurbineMappingAnswer(unitQ)
        check(
          `diverse unit: ${unitQ}`,
          includesAll(unitAnswer, [entry.site, entry.turbineId, entry.brand]),
          unitAnswer.slice(0, 140).replace(/\n/g, ' | '),
        )
      }
    }
  }

  console.log('\n=== llmwiki ask diverse sample ===')
  const llmwikiDiverse = await loadLlmwiki()
  const llmwikiSample = diverse.filter((_, index) => index % 2 === 0).slice(0, 28)
  for (const entry of llmwikiSample) {
    const q = `${entry.site}${entry.turbineId}`
    const result = await llmwikiDiverse.call(`ask ${q} --limit 3`)
    const text = String(result?.value || result || '')
    check(
      `llmwiki diverse: ${q}`,
      includesAll(text, [entry.site, entry.turbineId, entry.brand]),
      text.split('\n').slice(0, 3).join(' | '),
    )
  }

  console.log('\n=== cross-site ambiguous IDs (SH/S/C) ===')
  const ambiguousPairs = []
  const byBare = new Map()
  for (const entry of ALL_TURBINE_ENTRIES) {
    if (!isValidTurbineEntry(entry)) continue
    const bare = String(entry.turbineId).replace(/#$/, '').toUpperCase()
    const list = byBare.get(bare) || []
    list.push(entry)
    byBare.set(bare, list)
  }
  for (const [bare, list] of byBare.entries()) {
    const sites = [...new Set(list.map(item => item.site))]
    if (sites.length < 2) continue
    if (!/^(SH|S|C|SY|Y|MY)\d+$/u.test(bare)) continue
    // Keep one pair of distinct sites for each bare id.
    const a = list.find(item => item.site === sites[0])
    const b = list.find(item => item.site === sites[1])
    if (a && b) ambiguousPairs.push([a, b])
  }
  const ambiguousSample = ambiguousPairs.slice(0, 40)
  for (const [left, right] of ambiguousSample) {
    for (const entry of [left, right]) {
      const q = `${entry.site}${entry.turbineId.replace(/#$/, '')}`
      const answer = resolveTurbineMappingAnswer(q)
      check(
        `ambiguous map: ${q}`,
        includesAll(answer, [entry.site, entry.brand]) &&
          (answer.includes(entry.turbineId) || answer.includes(entry.turbineId.replace(/#$/, ''))),
        answer.slice(0, 140).replace(/\n/g, ' | '),
      )
    }
    // Bare id without site should still answer something coherent (first/global), not crash.
    const bare = left.turbineId.replace(/#$/, '')
    const bareAnswer = resolveTurbineMappingAnswer(bare)
    check(
      `ambiguous bare still answers: ${bare}`,
      Boolean(bareAnswer) && bareAnswer.includes('风机编号'),
      bareAnswer.slice(0, 120).replace(/\n/g, ' | '),
    )
  }

  console.log('\n=== site+turbine fault routing sample ===')
  const faultCases = [
    ['四平SH09机舱温度超限怎么处理', ['机舱温度', '四平'], ['LeapX', '风机编号「SH09」对应 富荣']],
    ['富荣SH09机舱温度超限怎么处理', ['富荣', '上海电气'], ['风机编号「SH09」对应 四平']],
    ['洮北58号偏航传感器故障怎么处理', ['偏航传感器', '洮北', '歌美飒'], ['故障码 58 未找到']],
    ['团结S03扭缆怎么处理', ['扭缆', '团结'], ['本地答案：S03']],
    ['前进S17扭缆', ['前进', '三一'], ['本地答案：S17']],
    ['四平C01 709', ['709', '四平'], []],
    ['什花道SY01扭缆', ['什花道'], ['本地答案：SY01']],
    ['镇赉H01#风速仪故障', ['镇赉'], ['本地答案：H01']],
    ['新华A01#扭缆', ['新华'], ['本地答案：A01']],
    ['裕民CL05是什么型号', ['裕民', 'CL05', '运达'], ['该机型对应的风场如下']],
    ['八面ZC28是什么型号', ['八面', 'ZC28', '中车山东'], ['该机型对应的风场如下']],
    ['同发A01#是什么型号', ['同发', 'A01#', '华锐'], ['该机型对应的风场如下']],
  ]
  for (const [q, expects, rejects] of faultCases) {
    const result = await llmwikiDiverse.call(`ask ${q} --limit 4`)
    const text = String(result?.value || result || '')
    check(
      `route: ${q.slice(0, 28)}`,
      includesAll(text, expects) && includesNone(text, rejects),
      text.split('\n').slice(0, 4).join(' | '),
    )
  }

  console.log('\n=== windrise farm more IDs ===')
  for (const q of [
    '富荣SH01',
    '四平SH01',
    '前进S17',
    '八面ZC28',
    '裕民CL25',
    '编号SH22',
    '洮北83#',
  ]) {
    const out = await runWindriseFarm(q)
    check(
      `windrise farm more: ${q}`,
      out.includes('风机编号') && !out.includes('该机型对应的风场如下') && !out.includes('查询结果：'),
      out.split('\n').find(line => line.includes('风机编号') || line.includes('该机型') || line.includes('查询结果') || line.includes('没有')) || out.slice(0, 160),
    )
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) process.exit(1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})

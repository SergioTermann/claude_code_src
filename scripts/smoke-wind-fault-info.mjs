#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRoot = join(root, '风机故障码')
const sourceDir = join(sourceRoot, '故障信息整理')
const project = join(root, 'wind-llmwiki')
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const indexPath = join(project, 'fault-index.jsonl')

const records = await loadJsonl(indexPath)
const fresh = records.filter(record => String(record.source ?? '').startsWith('故障信息整理/'))
const sourceRows = await collectSourceRows(sourceDir)

await step('fault-info markdown rows are all indexed', async () => {
  const sourceSet = new Set(sourceRows.map(row => row.source))
  const badSources = fresh.filter(record => !sourceSet.has(record.source))
  if (fresh.length === 0) {
    throw new Error('No fault-info records were indexed')
  }
  if (badSources.length > 0) {
    throw new Error(`Indexed records without source rows:\n${badSources.slice(0, 20).map(formatRecord).join('\n')}`)
  }
})

await step('fault-info records have searchable core fields', async () => {
  const bad = fresh.filter(record => {
    const haystack = [
      record.code,
      record.name,
      record.brand,
      record.model,
      record.reason,
      record.solution,
      record.reset,
      record.logic,
      record.program,
      record.text,
    ].filter(Boolean).join(' ')
    return !haystack.includes(String(record.code ?? '')) || !haystack.includes(String(record.name ?? ''))
  })
  if (bad.length > 0) {
    throw new Error(`Records missing searchable code/name:\n${bad.slice(0, 20).map(formatRecord).join('\n')}`)
  }
})

await step('fault-info program fields are preserved structurally', async () => {
  const record = findRecord({ brand: '明阳', model: 'MY1.5Se系列', code: 'SC01_01_001' })
  if (!record) throw new Error('Missing SC01_01_001 representative record')
  assertIncludes(record.program ?? '', '偏航程序：100')
  assertIncludes(record.program ?? '', '制动程序：210')
  assertEqual(record.yawProgram, '100', 'SC01_01_001 yaw program')
  assertEqual(record.brakeProgram, '210', 'SC01_01_001 brake program')
})

await step('fault-info program fields are rendered in llmwiki answers', async () => {
  const stdout = await runLlmwikiAsk('SC01_01_001 明阳 MY1.5Se')
  assertIncludes(stdout, '程序：偏航程序：100；制动程序：210')
  assertIncludes(stdout, '来源：故障信息整理/明阳/明阳MY1.5Se系列/明阳MY1.5Se系列风机故障处理手册_1_SC01_01_001.md:1')
})

await step('fault-info fault names can reverse lookup fault codes', async () => {
  const stdout = await runWindrise('变桨急停引起机组安全链断开 对应什么故障码')
  assertIncludes(stdout, 'SC01_01_001')
  assertIncludes(stdout, '变桨急停引起机组安全链断开')
  assertNotIncludes(stdout, '没找到相关内容')
})

await step('fault-info site/model mapping queries stay in local mapping', async () => {
  const stdout = await runWindrise('什花道 EN-156/5.0 是哪个厂家哪个系列')
  assertIncludes(stdout, '什花道风电场')
  assertIncludes(stdout, '远景 NGP主控系列')
  assertIncludes(stdout, 'EN-156/5.0')
  assertNotIncludes(stdout, '广东什花道科技有限公司')
})

await step('fault-info conversation memory survives a follow-up', async () => {
  const stdout = await runWindriseSession([
    'SC01_01_001 明阳 MY1.5Se 是什么故障',
    '它的故障码是什么',
  ])
  assertIncludes(stdout, '变桨急停引起机组安全链断开')
  assertIncludes(stdout, 'SC01_01_001')
  assertNotIncludes(stdout, '没找到相关内容')
})

await step('fault-info fault-name queries with model are not swallowed by model mapping', async () => {
  const stdout = await runWindrise('EN-156/5.0 偏航电机加热器保护空开跳开')
  assertIncludes(stdout, 'SC02_02_007')
  assertIncludes(stdout, '偏航电机加热器保护空开跳开')
  assertIncludes(stdout, '风场：什花道')
  assertIncludes(stdout, '具体型号：EN-156/5.0、EN-156/3.3')
  assertNotIncludes(stdout, '该机型对应的风场如下')
})

await step('fault-info classification is not folded into fault code', async () => {
  const record = fresh.find(item =>
    item.brand === '上海电气' &&
    item.model === 'W1250系列' &&
    item.source === '故障信息整理/上海电气/上海电气W1250系列/上海电气W1250系列风机变频器故障处理手册_1_1400.md:1'
  )
  if (!record) throw new Error('Missing W1250 representative record')
  assertEqual(record.code, '1400', 'W1250 code')
  assertIncludes(record.name || record.text || '', '故障')
})

await step('fault-info brand/model buckets are covered', async () => {
  const buckets = groupBy(fresh, record => `${record.brand || '未知'} / ${record.model || '未知'}`)
  const expected = [
    '三一 / 6.XMW双馈系列',
    '三一 / SE8715系列',
    '三一 / 高速系列',
    '上海电气 / W1250系列',
    '上海电气 / W2000系列',
    '明阳 / MY1.5Se系列',
    '运达 / WD2500系列',
    '远景 / NGP主控系列',
  ]
  for (const key of expected) {
    if (!buckets[key]?.length) throw new Error(`Missing bucket: ${key}`)
  }
})

await step('real /llmwiki search hits representative fault-info records', async () => {
  const probes = [
    findRecord({ brand: '三一', model: '6.XMW双馈系列', code: '721' }),
    findRecord({ brand: '三一', model: 'SE8715系列', code: '415' }),
    findRecord({ brand: '三一', model: '高速系列', code: '2436' }),
    findRecord({ brand: '上海电气', model: 'W1250系列' }),
    findRecord({ brand: '上海电气', model: 'W2000系列' }),
    findRecord({ brand: '明阳', model: 'MY1.5Se系列', code: 'SC01_03_006' }),
    findRecord({ brand: '运达', model: 'WD2500系列', code: '5006' }),
    findRecord({ brand: '远景', model: 'NGP主控系列' }),
    ...deterministicSample(fresh, 16),
  ].filter(Boolean)

  const failures = []
  for (const record of probes) {
    const query = [record.code, record.brand, record.model, record.name].filter(Boolean).join(' ')
    const stdout = await runLlmwikiSearch(query)
    if (!stdout.includes(record.source) && !stdout.includes(record.code)) {
      failures.push({ record, stdout })
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Representative searches failed:\n${failures.slice(0, 8).map(item => `${formatRecord(item.record)}\n${item.stdout}`).join('\n\n')}`,
    )
  }
})

console.log(JSON.stringify({
  sourceRows: sourceRows.length,
  indexedFaultInfo: fresh.length,
  brands: countBy(fresh, record => record.brand || '未知'),
  models: countBy(fresh, record => `${record.brand || '未知'} / ${record.model || '未知'}`),
}, null, 2))
console.log('wind fault-info smoke checks passed')

async function loadJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

async function collectSourceRows(dir) {
  const rows = []
  for (const filePath of await collectMarkdownFiles(dir)) {
    const rel = relative(sourceRoot, filePath)
    const content = await readFile(filePath, 'utf8')
    content.split(/\r?\n/).forEach((line, index) => {
      const text = line.trim()
      if (!text) return
      rows.push({ source: `${rel}:${index + 1}`, text })
    })
  }
  return rows
}

async function collectMarkdownFiles(dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const child = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await collectMarkdownFiles(child))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(child)
  }
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

function findRecord(criteria) {
  return fresh.find(record =>
    Object.entries(criteria).every(([key, value]) => String(record[key] ?? '') === value),
  )
}

function deterministicSample(items, count) {
  if (items.length <= count) return items
  const output = []
  const stepSize = Math.max(1, Math.floor(items.length / count))
  for (let index = 0; index < items.length && output.length < count; index += stepSize) {
    output.push(items[index])
  }
  return output
}

async function runLlmwikiSearch(query) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', '--max-turns', '1', '/llmwiki', 'search', query, '--limit', '12'],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: project,
      },
      maxBuffer: 1024 * 1024 * 16,
    },
  )
  return stdout
}

async function runLlmwikiAsk(query) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', '--max-turns', '1', '/llmwiki', 'ask', query, '--limit', '6'],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: project,
      },
      maxBuffer: 1024 * 1024 * 16,
    },
  )
  return stdout
}

async function runWindrise(query) {
  const { stdout } = await execFileAsync(
    join(root, 'bin', 'windrise'),
    [query],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: project,
      },
      maxBuffer: 1024 * 1024 * 16,
    },
  )
  return stdout
}

async function runWindriseSession(lines) {
  const payload = lines.join('\n')
  const script = `printf '%s\nexit\n' ${JSON.stringify(payload)} | ${JSON.stringify(join(root, 'bin', 'windrise'))} ask`
  const { stdout } = await execFileAsync('/bin/zsh', ['-lc', script], {
    cwd: root,
    env: {
      ...process.env,
      LLMWIKI_PROJECT: project,
    },
    maxBuffer: 1024 * 1024 * 16,
  })
  return stdout
}

async function step(name, fn) {
  process.stdout.write(`- ${name}... `)
  try {
    await fn()
    console.log('ok')
  } catch (error) {
    console.log('failed')
    throw error
  }
}

function groupBy(items, keyFn) {
  return items.reduce((groups, item) => {
    const key = keyFn(item)
    groups[key] ??= []
    groups[key].push(item)
    return groups
  }, {})
}

function countBy(items, keyFn) {
  return Object.fromEntries(
    Object.entries(groupBy(items, keyFn)).map(([key, values]) => [key, values.length]),
  )
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}

function assertIncludes(value, expected) {
  if (!String(value).includes(expected)) {
    throw new Error(`expected "${value}" to include "${expected}"`)
  }
}

function assertNotIncludes(value, expected) {
  if (String(value).includes(expected)) {
    throw new Error(`expected "${value}" to not include "${expected}"`)
  }
}

function formatRecord(record) {
  return `${record.source} ${record.brand}/${record.model} ${record.code} ${record.name}`
}

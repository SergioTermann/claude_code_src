#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const projectPath = resolve(process.argv[2] || join(root, '风机故障码'))
const outPath = join(projectPath, 'fault-index.jsonl')
const summaryPath = join(projectPath, 'fault-index-summary.json')

const FIELD_KEYS = [
  '变频器故障代码',
  '变频器故障码',
  '集控是否可复位',
  'Unnamed: 3',
  '故障代码',
  '故障描述/现象',
  '故障描述',
  '故障名称(中文)',
  '故障名称',
  '故障名',
  '中文名称',
  '故障信息',
  '故障解释',
  '故障现象',
  '故障现象及处理方法',
  '故障原因',
  '故障处理方法',
  '故障处理指导',
  '故障处理',
  '解决方案',
  '故障逻辑',
  '故障时间',
  '故障设置值',
  '复位',
  '复位情况',
  '复位方式',
  '复位条件',
  '复位权限',
  '状态代码',
  '故障代号',
  '故障码',
  '信号部位',
  '风机状态',
  '程序锁定',
  '不影响可利用率',
  '服务菜单中是否显示',
  '扫描周期',
  '检查部位',
  '系统',
  '故障分类',
  '故障类型',
  '故障属性',
  'SYJX（故障属性）',
  '停机级别',
  '自启动',
  '风场',
  '品牌',
  '机型',
  '编号',
  '英文名称',
  '报警',
  '序号',
  '解释',
]

const records = []
const files = await collectFiles(projectPath)

for (const filePath of files) {
  if (!filePath.endsWith('.md')) continue
  const relPath = relative(projectPath, filePath)
  const content = await readFile(filePath, 'utf8')
  content.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim()
    if (!text) return
    const fields = parseChineseFields(text)
    if (!isFaultRecordFields(fields)) return
    const code = faultCodeFromFields(fields)
    if (!code) return
    records.push(normalizeRecord(fields, code, `${relPath}:${index + 1}`, text))
  })
}

const deduped = dedupeRecords(records)
await writeFile(outPath, `${deduped.map(record => JSON.stringify(record)).join('\n')}\n`)
await writeFile(
  summaryPath,
  `${JSON.stringify(buildSummary(deduped), null, 2)}\n`,
)

console.log(`Wrote ${deduped.length} records`)
console.log(outPath)
console.log(summaryPath)

async function collectFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(childPath)))
    } else if (entry.isFile()) {
      files.push(childPath)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function parseChineseFields(value) {
  const positions = FIELD_KEYS.map(key => ({ key, index: value.indexOf(`${key}：`) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)
  const fields = new Map()

  positions.forEach((item, index) => {
    const start = item.index + item.key.length + 1
    const end =
      index + 1 < positions.length ? positions[index + 1].index : value.length
    const raw = value.slice(start, end)
    fields.set(item.key, raw.replace(/[，,；;。]\s*$/, '').trim())
  })

  return fields
}

function field(fields, ...keys) {
  for (const key of keys) {
    const value = fields.get(key)
    if (value) return value
  }
  return ''
}

function isFaultRecordFields(fields) {
  if (
    field(
      fields,
      '故障代码',
      '故障码',
      '状态代码',
      '变频器故障代码',
      '变频器故障码',
      '故障代号',
    )
  ) {
    return true
  }

  return Boolean(
    fields.get('编号') &&
      field(fields, '中文名称', '英文名称', '报警', '解释', '故障处理指导'),
  )
}

function faultCodeFromFields(fields) {
  return field(
    fields,
    '故障代码',
    '故障码',
    '状态代码',
    '变频器故障代码',
    '变频器故障码',
    '故障代号',
    '编号',
  )
}

function faultNameFromFields(fields) {
  return cleanFaultName(
    field(
      fields,
      '故障名称',
      '故障名称(中文)',
      '故障名',
      '中文名称',
      '故障描述/现象',
      '故障描述',
      '故障现象',
      '故障信息',
      '故障解释',
      '报警',
      '解释',
      '故障',
    ),
  )
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

function normalizeRecord(fields, code, source, text) {
  return compactObject({
    code,
    name: faultNameFromFields(fields),
    site: field(fields, '风场'),
    brand: field(fields, '品牌'),
    model: field(fields, '机型'),
    system: field(fields, '系统'),
    category: field(fields, '故障分类', '故障类型', '故障属性', 'SYJX（故障属性）'),
    reason: field(fields, '故障原因'),
    solution: field(fields, '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位'),
    reset: field(fields, '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
    logic: field(fields, '故障逻辑', '解释'),
    alarm: field(fields, '报警'),
    source,
    text,
  })
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== ''),
  )
}

function dedupeRecords(input) {
  const seen = new Set()
  const output = []
  for (const record of input) {
    const key = JSON.stringify([
      record.code,
      record.brand || '',
      record.model || '',
      record.name || '',
      record.source,
    ])
    if (seen.has(key)) continue
    seen.add(key)
    output.push(record)
  }
  return output
}

function buildSummary(input) {
  const byBrand = {}
  const byCodeLength = {}
  for (const record of input) {
    const brand = record.brand || '未知'
    byBrand[brand] = (byBrand[brand] || 0) + 1
    const codeLength = String(record.code).length
    byCodeLength[codeLength] = (byCodeLength[codeLength] || 0) + 1
  }
  return {
    projectPath,
    recordCount: input.length,
    generatedAt: new Date().toISOString(),
    byBrand,
    byCodeLength,
  }
}

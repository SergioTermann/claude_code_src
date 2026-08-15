#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandTurbineIdSpec } from './turbine-id-utils.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const unzipSync = loadUnzipSync()
const projectPath = resolve(process.argv[2] || join(root, '风机故障码'))
const outPath = join(projectPath, 'fault-index.jsonl')
const summaryPath = join(projectPath, 'fault-index-summary.json')

const UNIT_NUMBER_ALIASES = new Set([
  '编号',
  '风机编号',
  '风机号',
  '机位号',
])

const LABEL_ID_ALIASES = new Set([
  '机组编号',
  '机组编号/标牌',
  '标牌',
  '对应编号',
  '对应机组',
  '对应风机',
])

const TABLE_HEADER_ALIASES = new Map([
  ['故障代码', '故障代码'],
  ['故障码', '故障代码'],
  ['代码', '故障代码'],
  ['软件故障', '故障代码'],
  ['状态代码', '故障代码'],
  ['故障描述', '故障描述'],
  ['描述', '故障描述'],
  ['解释', '故障描述'],
  ['故障名称', '故障名称'],
  ['故障原因', '产生原因'],
  ['处理方法', '处理方法'],
  ['排除方法', '处理方法'],
  ['信号部位', '信号部位'],
  ['复位方式', '复位方式'],
  ['复位', '复位'],
  ['复位程序', '复位程序'],
  ['故障分类', '故障分类'],
  ['等级', '故障等级'],
  ['英文故障描述', '英文名称'],
  ['风机状态', '风机状态'],
  ['检查部位', '检查部位'],
  ['报警属性', '报警'],
])

const FIELD_KEYS = [
  '变频器故障代码',
  '变频器故障码',
  '对应的变频器故障编号',
  '变频器故障说明，以及相应处理办法',
  '集控是否可复位',
  'Unnamed: 1',
  'Unnamed: 2',
  'Unnamed: 3',
  '故障代码',
  '分类',
  '故障描述/现象',
  '故障描述',
  '描述',
  '故障名称(中文)',
  '故障名称',
  '故障名',
  '中文名称',
  '中文描述',
  '故障信息',
  '故障解释',
  '故障现象',
  '故障现象及处理方法',
  '产生原因',
  '机组状态',
  '故障原因分析',
  '故障原因',
  '可能原因',
  '故障触发条件',
  '触发条件',
  '触发和复位条件',
  '故障排查及处理',
  '故障维修策略',
  '故障类别',
  '部件',
  '偏航等级',
  '故障等级',
  '刹车等级',
  '停机等级BP',
  '复位级别RP',
  '延时时间',
  '触发延时',
  '复位延时',
  '复位/远程',
  '正常停机',
  '快速停机',
  '紧急停机',
  '停机程序',
  '禁止自动复位',
  '禁止所有偏航',
  '自动复位时间',
  '断安全链',
  'PLC反馈点',
  '处理方法',
  '故障处理方法',
  '故障处理指导',
  '故障处理',
  '排查操作步骤',
  '检修指导',
  '刹车级别BP',
  '刹车级别',
  '解决方案',
  '故障逻辑',
  '故障时间',
  '故障设置值',
  '信号源',
  '设置延迟',
  '制动程序',
  '报警程序',
  '偏航程序',
  '复位延迟',
  '复位程序',
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
  '映射型号',
  '具体型号',
  '风机编号',
  '风机号',
  '机位号',
  '机组编号',
  '对应编号',
  '对应机组',
  '对应风机',
  '刹车号',
  '编号',
  '英文名称',
  '报警',
  '序号',
  '解释',
]

const records = []
const files = await collectFiles(projectPath)
const { mapping: freshMapping, siteBrandIndex } = await loadFreshFaultMapping(projectPath)

for (const filePath of files) {
  if (!filePath.endsWith('.md')) continue
  const relPath = relative(projectPath, filePath)
  const content = await readFile(filePath, 'utf8')
  const siteContext = inferSiteFolderContext(relPath)
  if (siteContext) {
    const tableRecords = parseMarkdownTableRecords(
      content,
      relPath,
      siteContext,
      siteBrandIndex,
      freshMapping,
    )
    if (tableRecords.length > 0) {
      records.push(...tableRecords)
      continue
    }
  }
  for (const line of mergeWrappedRecordLines(content.split(/\r?\n/))) {
    const fields = parseChineseFields(line.text)
    if (!isFaultRecordFields(fields)) continue
    const code = faultCodeFromFields(fields)
    if (!code) continue
    records.push(
      applyFreshFaultMapping(
        normalizeRecord(fields, code, `${relPath}:${line.lineNumber}`, line.text),
        freshMapping,
      ),
    )
  }
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

function mergeWrappedRecordLines(rawLines) {
  const lines = []
  rawLines.forEach((rawLine, index) => {
    const text = rawLine.trim()
    if (!text) return
    const fields = parseChineseFields(text)
    const previous = lines[lines.length - 1]
    if (fields.size === 0 && previous?.isRecord) {
      previous.text += text
      return
    }
    lines.push({
      text,
      lineNumber: index + 1,
      isRecord:
        isFaultRecordFields(fields) && Boolean(faultCodeFromFields(fields)),
    })
  })
  return lines
}

function parseChineseFields(value) {
  const positions = FIELD_KEYS.map(key => ({ key, index: value.indexOf(`${key}：`) }))
    .filter(item => {
      if (item.index < 0) return false
      if (item.index === 0) return true
      return /[\s，,；;。]/u.test(value[item.index - 1] ?? '')
    })
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
  return cleanFaultCode(
    field(
      fields,
      '故障代码',
      '故障码',
      '状态代码',
      '变频器故障代码',
      '变频器故障码',
      '故障代号',
      '编号',
    ),
  )
}

function cleanFaultCode(value) {
  let normalized = clean(value)
  const metadataIndex = normalized.search(
    /[，,；;。]\s*(?:对应|故障|分类|unnamed|bachmann|abb|描述|产生原因|机组状态|处理方法|触发|刹车|制动|报警|偏航|复位|设置|信号源|等级)/i,
  )
  if (metadataIndex > 0) normalized = normalized.slice(0, metadataIndex).trim()
  const trailingCode = normalized.match(/\b([a-z]+_?\d+)\b$/i)?.[1]
  if (trailingCode && /\s/.test(normalized)) return trailingCode
  return normalized
}

function faultNameFromFields(fields) {
  const explicitName = field(
    fields,
    '故障名称',
    '故障名称(中文)',
    '故障名',
    '中文名称',
    '中文描述',
    '故障描述/现象',
    '故障描述',
    '描述',
    '故障现象',
      '故障信息',
      '故障解释',
      '对应的变频器故障编号',
      '报警',
    '解释',
    '故障',
  )
  if (explicitName) return cleanFaultName(explicitName)
  return inferFaultNameFromReason(field(fields, '产生原因', '故障原因'))
}

function cleanFaultName(value) {
  return value
    .replace(/，?故障名称\(英文\)：.*$/i, '')
    .replace(/，?等级：.*$/i, '')
    .replace(/，?故障变量：.*$/i, '')
    .replace(/，?故障使能：.*$/i, '')
    .replace(/，?故障触发条件：.*$/i, '')
    .replace(/，?刹车号：.*$/i, '')
    .replace(/，?故障描述：.*$/i, '')
    .replace(/[，,；;。]\s*$/g, '')
    .trim()
}

function inferFaultNameFromReason(value) {
  const normalized = clean(value)
  if (!normalized) return ''
  return normalized
    .split(/[，,；;。]/u)[0]
    .replace(/^(?:由于|因为|因)/u, '')
    .replace(/(?:导致|造成|引起|出现|触发)$/u, '')
    .trim()
}

function normalizeRecord(fields, code, source, text) {
  return compactObject({
    code,
    name: faultNameFromFields(fields),
    site: field(fields, '风场'),
    brand: field(fields, '品牌'),
    model: field(fields, '机型'),
    standardModel: field(fields, '映射型号', '具体型号'),
    turbineIds: field(fields, '风机编号', '风机号', '机位号', '机组编号', '对应编号', '对应机组', '对应风机'),
    system: field(fields, '系统', '部件'),
    category: field(fields, '故障分类', '故障类型', '故障类别', '故障属性', 'SYJX（故障属性）'),
    classification: field(fields, '分类'),
    reason: field(fields, '产生原因', '故障原因', '故障原因分析', '可能原因'),
    solution: field(fields, '排查操作步骤', '处理方法', '故障处理', '故障处理方法', '故障处理指导', '检修指导', '故障维修策略', '故障排查及处理', '故障现象及处理方法', '变频器故障说明，以及相应处理办法', '解决方案', '检查部位'),
    reset: field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
    logic: field(fields, '故障逻辑', '故障触发条件', '触发条件', '解释'),
    signal: field(fields, '信号源', '信号部位'),
    delay: field(fields, '设置延迟'),
    yawProgram: field(fields, '偏航程序'),
    brakeProgram: field(fields, '制动程序'),
    alarmProgram: field(fields, '报警程序'),
    resetDelay: field(fields, '复位延迟'),
    resetProgram: field(fields, '复位程序'),
    program: programSummary(fields),
    alarm: field(fields, '报警'),
    source,
    text,
  })
}

async function loadFreshFaultMapping(basePath) {
  const mappingPath =
    (await fileExists(join(basePath, '故障信息整理', '场站-型号映射表.xlsx')))
      ? join(basePath, '故障信息整理', '场站-型号映射表.xlsx')
      : join(basePath, '故障码0610', '场站-型号映射表.xlsx')
  let buffer
  try {
    buffer = await readFile(mappingPath)
  } catch {
    return { mapping: new Map(), siteBrandIndex: new Map() }
  }

  const rows = parseMappingWorkbook(buffer)
  const mapping = new Map()
  const siteBrandIndex = new Map()
  for (const row of rows) {
    const key = mappingKey(row.brand, row.model)
    const entry = mapping.get(key) ?? {
      sites: new Set(),
      types: new Set(),
      turbineIds: new Set(),
      typeIds: new Map(),
    }
    entry.sites.add(row.site)
    if (row.type) entry.types.add(row.type)
    for (const turbineId of expandTurbineIdSpec(row.labelIds || row.turbineIds)) {
      entry.turbineIds.add(turbineId)
      if (row.type) {
        const typeSet = entry.typeIds.get(row.type) ?? new Set()
        typeSet.add(turbineId)
        entry.typeIds.set(row.type, typeSet)
      }
    }
    mapping.set(key, entry)

    const siteBrandKey = `${row.site}\u0000${row.brand}`
    const siteBrandEntry = siteBrandIndex.get(siteBrandKey) ?? {
      site: row.site,
      brand: row.brand,
      models: new Set(),
      types: new Set(),
    }
    siteBrandEntry.models.add(row.model)
    if (row.type) siteBrandEntry.types.add(row.type)
    siteBrandIndex.set(siteBrandKey, siteBrandEntry)
  }
  return { mapping, siteBrandIndex }
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

function parseMappingWorkbook(buffer) {
  const zip = unzipSync(new Uint8Array(buffer))
  const decoder = new TextDecoder('utf8')
  const sharedXml = zip['xl/sharedStrings.xml']
    ? decoder.decode(zip['xl/sharedStrings.xml'])
    : ''
  const shared = parseSharedStrings(sharedXml)
  const sheetName = Object.keys(zip)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort()[0]
  if (!sheetName) return []

  const rows = []
  const sheetXml = decoder.decode(zip[sheetName])
  for (const rowXml of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
    const row = {}
    for (const cellXml of rowXml[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attrs = cellXml[1]
      const body = cellXml[2] ?? ''
      const ref = attrs.match(/\br="([A-Z]+)\d+"/u)?.[1]
      if (!ref) continue
      row[ref] = readCellValue(attrs, body, shared)
    }
    if (Object.values(row).some(Boolean)) rows.push(row)
  }

  const header = rows[0] || {}
  const unitNumberColumn = findColumnByAliases(header, UNIT_NUMBER_ALIASES)
  const labelIdColumn = findColumnByAliases(header, LABEL_ID_ALIASES)
  const output = []
  let site = ''
  let brand = ''
  let model = ''
  for (const row of rows.slice(1)) {
    site = clean(row.A) || site
    brand = clean(row.B) || brand
    model = clean(row.C) || model
    const type = clean(row.D)
    const unitNumbers = unitNumberColumn ? clean(row[unitNumberColumn]) : ''
    const labelIds = labelIdColumn ? clean(row[labelIdColumn]) : unitNumbers
    if (!site || !brand || !model) continue
    output.push({ site, brand, model, type, unitNumbers, labelIds, turbineIds: labelIds })
  }
  return output
}

function inferSiteFolderContext(relPath) {
  const parts = relPath.split('/')
  const baseIdx = parts.indexOf('故障信息整理')
  if (baseIdx < 0 || baseIdx + 1 >= parts.length) return null
  const siteFolder = parts[baseIdx + 1] || ''
  const brandFolder = parts[baseIdx + 2] || ''
  const site = siteFolder.replace(/^\d+\s+/u, '').trim()
  const brand = inferBrandFromFolder(brandFolder)
  if (!site || !brand) return null
  return { site, brand, brandFolder }
}

function inferBrandFromFolder(folderName) {
  let name = clean(folderName)
    .replace(/^\d+\.\s*/u, '')
    .replace(/\(.*$/u, '')
    .trim()
  for (const keyword of [
    '故障代码手册',
    '故障代码',
    '风机故障码',
    '可复位故障码',
  ]) {
    const index = name.indexOf(keyword)
    if (index > 0) {
      name = name.slice(0, index)
      break
    }
  }
  return name.replace(/-软件$/u, '').trim()
}

function parseMarkdownTableRecords(
  content,
  relPath,
  siteContext,
  siteBrandIndex,
  freshMapping,
) {
  const lines = content.split(/\r?\n/)
  const rows = parseMarkdownTableRows(lines)
  if (rows.length === 0) return []

  const output = []
  for (const row of rows) {
    const fields = mapTableRowToFields(row.headers, row.cells)
    if (!isFaultRecordFields(fields)) continue
    const code = faultCodeFromFields(fields)
    if (!code) continue
    const enriched = enrichSiteFolderRecord(
      normalizeRecord(
        fields,
        code,
        `${relPath}:${row.lineNumber}`,
        buildTableRecordText(fields, siteContext),
      ),
      siteContext,
      siteBrandIndex,
    )
    output.push(applyFreshFaultMapping(enriched, freshMapping))
  }
  return output
}

function parseMarkdownTableRows(lines) {
  const rows = []
  let headerLine = ''
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line.startsWith('|')) continue
    if (/^\|\s*[-:]/.test(line)) {
      if (!headerLine) continue
      const headers = parseTableCells(headerLine)
      for (let rowIndex = index + 1; rowIndex < lines.length; rowIndex += 1) {
        const rowLine = lines[rowIndex].trim()
        if (!rowLine.startsWith('|') || /^\|\s*[-:]/.test(rowLine)) break
        const cells = parseTableCells(rowLine)
        if (cells.every(cell => !cell)) continue
        rows.push({ headers, cells, lineNumber: rowIndex + 1 })
      }
      headerLine = ''
      continue
    }
    headerLine = line
  }
  return rows
}

function parseTableCells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map(cell => cell.replace(/<br\s*\/?>/giu, ' ').trim())
}

function mapTableRowToFields(headers, cells) {
  const fields = new Map()
  headers.forEach((header, index) => {
    const value = clean(cells[index] ?? '')
    if (!value) return
    const normalizedHeader = clean(header)
    const fieldKey = TABLE_HEADER_ALIASES.get(normalizedHeader)
    if (fieldKey) {
      fields.set(fieldKey, value)
      return
    }
    if (/^unnamed:\s*1$/iu.test(normalizedHeader)) {
      if (/^SC\d/i.test(value)) {
        fields.set('故障代码', value)
      } else if (!fields.has('故障名称') && !fields.has('故障描述')) {
        fields.set('故障名称', value)
      }
    }
  })
  if (!fields.has('故障名称') && fields.has('故障描述')) {
    fields.set('故障名称', fields.get('故障描述'))
  }
  return fields
}

function buildTableRecordText(fields, siteContext) {
  const parts = []
  if (siteContext.site) parts.push(`场站：${siteContext.site}`)
  if (siteContext.brand) parts.push(`品牌：${siteContext.brand}`)
  for (const key of [
    '故障代码',
    '故障名称',
    '故障描述',
    '产生原因',
    '处理方法',
    '信号部位',
    '复位方式',
    '复位',
    '故障分类',
  ]) {
    const value = fields.get(key)
    if (value) parts.push(`${key}：${value}`)
  }
  return `${parts.join('。')}。`
}

function enrichSiteFolderRecord(record, siteContext, siteBrandIndex) {
  const key = `${siteContext.site}\u0000${siteContext.brand}`
  const entry = siteBrandIndex.get(key)
  const model = entry ? [...entry.models].join('、') : ''
  const standardModel = entry ? [...entry.types].join('、') : ''
  return compactObject({
    ...record,
    site: record.site || siteContext.site,
    brand: record.brand || siteContext.brand,
    model: record.model || model,
    standardModel: record.standardModel || standardModel,
  })
}

function findColumnByAliases(header, aliases) {
  for (const [column, title] of Object.entries(header || {})) {
    if (aliases.has(cleanHeader(title))) return column
  }
  return ''
}

function cleanHeader(value) {
  return clean(value).replace(/\s+/g, '')
}

function columnNumber(column) {
  return String(column || '')
    .toUpperCase()
    .split('')
    .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0)
}

function parseSharedStrings(xml) {
  if (!xml) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map(match =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map(item => decodeXml(item[1]))
      .join(''),
  )
}

function readCellValue(attrs, body, shared) {
  const type = attrs.match(/\bt="([^"]+)"/u)?.[1]
  if (type === 's') {
    const index = Number(body.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? -1)
    return shared[index] ?? ''
  }
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)]
      .map(match => decodeXml(match[1]))
      .join('')
  }
  return decodeXml(body.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? '')
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function applyFreshFaultMapping(record, mapping) {
  if (
    !record.source?.startsWith('故障码0610/') &&
    !record.source?.startsWith('故障信息整理/')
  ) {
    return record
  }
  const entry = mapping.get(mappingKey(record.brand, record.model))
  if (!entry) return record

  const site = [...entry.sites].join('、')
  const standardModel = [...entry.types].join('、')
  const turbineIds = selectTurbineIdsForRecord(record, entry)
  const next = {
    ...record,
    site: record.site || site,
    standardModel: record.standardModel || standardModel,
    turbineIds: record.turbineIds || turbineIds,
  }
  const prefixes = [
    next.site && !record.text.includes('场站：') ? `场站：${next.site}。` : '',
    next.standardModel && !record.text.includes('映射型号：') ? `映射型号：${next.standardModel}。` : '',
    next.turbineIds && !record.text.includes('风机编号：') ? `风机编号：${next.turbineIds}。` : '',
  ].filter(Boolean)
  if (prefixes.length > 0) {
    next.text = `${prefixes.join('')}${record.text}`
  }
  return compactObject(next)
}

function selectTurbineIdsForRecord(record, entry) {
  const matched = new Set()
  for (const [type, ids] of entry.typeIds.entries()) {
    if (recordMatchesMappedType(record, type)) {
      for (const id of ids) matched.add(id)
    }
  }
  const selected = matched.size > 0 ? matched : entry.turbineIds
  return [...selected].join('、')
}

function recordMatchesMappedType(record, type) {
  const needle = normalizeMappingSearchText(type)
  if (!needle) return false
  const haystack = normalizeMappingSearchText(
    [
      record.standardModel,
      record.text,
      record.source,
    ].filter(Boolean).join(' '),
  )
  return haystack.includes(needle)
}

function mappingKey(brand, model) {
  return `${clean(brand).toLowerCase()}\u0000${clean(model).toLowerCase()}`
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function splitMappingValues(value) {
  return clean(value)
    .split(/[、,，;；/]/u)
    .map(item => clean(item))
    .filter(Boolean)
}

function normalizeMappingSearchText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function programSummary(fields) {
  return [
    labeledField(fields, '偏航程序'),
    labeledField(fields, '制动程序'),
    labeledField(fields, '报警程序'),
    labeledField(fields, '复位程序'),
    labeledField(fields, '复位延迟'),
    labeledField(fields, '设置延迟'),
  ]
    .filter(Boolean)
    .join('；')
}

function labeledField(fields, key) {
  const value = field(fields, key)
  return value ? `${key}：${value}` : ''
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== ''),
  )
}

function loadUnzipSync() {
  const modulePath = process.env.FFLATE_MODULE_PATH
  if (modulePath) {
    return require(modulePath).unzipSync
  }
  return require('fflate').unzipSync
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

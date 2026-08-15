#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const unzipSync = loadUnzipSync()
const mappingPath = resolve(
  process.argv[2] || join(root, '风机故障码', '故障信息整理', '场站-型号映射表.xlsx'),
)
const outPath = resolve(
  process.argv[3] || join(root, 'src', 'data', 'windFarmModels.json'),
)
const basePath = process.argv[4] ? resolve(process.argv[4]) : outPath

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

const rows = parseMappingWorkbook(await readFile(mappingPath))
const baseEntries = await readOptionalJson(basePath)
const entries = buildWindFarmModels(rows, baseEntries)
await writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')

console.log(`Wrote ${entries.length} wind farm model entries`)
console.log(outPath)

async function readOptionalJson(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function buildWindFarmModels(rows, baseEntries = []) {
  const bySite = new Map()
  for (const row of rows) {
    const siteName = row.site.endsWith('风电场') ? row.site : `${row.site}风电场`
    const key = normalizeKey(siteName)
    const entry = bySite.get(key) ?? {
      site: siteName,
      aliases: [],
      models: [],
    }
    pushUnique(entry.aliases, row.site)
    const modelText = formatModelText(row)
    if (modelText) pushUnique(entry.models, modelText)
    bySite.set(key, entry)
  }

  const generatedEntries = [...bySite.values()]
    .map(entry => ({
      site: entry.site,
      aliases: entry.aliases.filter(alias => normalizeKey(alias) !== normalizeKey(entry.site)),
      models: entry.models,
    }))

  const generatedKeys = new Set(generatedEntries.map(entry => normalizeKey(entry.site)))
  const merged = []
  for (const entry of baseEntries) {
    if (!entry?.site || generatedKeys.has(normalizeKey(entry.site))) continue
    merged.push({
      site: clean(entry.site),
      aliases: Array.isArray(entry.aliases) ? entry.aliases.map(clean).filter(Boolean) : [],
      models: Array.isArray(entry.models) ? entry.models.map(clean).filter(Boolean) : [],
    })
  }
  merged.push(...generatedEntries)

  return merged
    .sort((a, b) => a.site.localeCompare(b.site, 'zh-Hans-CN'))
}

function formatModelText(row) {
  const brand = clean(row.brand)
  const model = clean(row.model)
  const type = clean(row.type)
  const turbineIds = clean(row.turbineIds)
  if (!brand || !model) return ''

  const details = []
  if (type) details.push(`具体型号：${type}`)
  if (turbineIds) details.push(`风机编号：${turbineIds}`)
  return `${brand} ${model}${details.length > 0 ? `（${details.join('；')}）` : ''}`
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

  const sheetRows = []
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
    if (Object.values(row).some(Boolean)) sheetRows.push(row)
  }

  const header = sheetRows[0] || {}
  const labelIdColumn = findColumnByAliases(header, LABEL_ID_ALIASES)
  const unitNumberColumn = findColumnByAliases(header, UNIT_NUMBER_ALIASES)
  const rows = []
  let site = ''
  let brand = ''
  let model = ''
  for (const row of sheetRows.slice(1)) {
    site = clean(row.A) || site
    brand = clean(row.B) || brand
    model = clean(row.C) || model
    const type = clean(row.D)
    const labelIds = labelIdColumn ? clean(row[labelIdColumn]) : ''
    const unitNumbers = unitNumberColumn ? clean(row[unitNumberColumn]) : ''
    const turbineIds = labelIds || unitNumbers
    if (!site || !brand || !model) continue
    rows.push({ site, brand, model, type, turbineIds })
  }
  return rows
}

function findColumnByAliases(header, aliases) {
  for (const [column, title] of Object.entries(header || {})) {
    if (aliases.has(cleanHeader(title))) return column
  }
  return ''
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

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
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

function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function pushUnique(values, value) {
  const normalized = clean(value)
  if (!normalized || values.includes(normalized)) return
  values.push(normalized)
}

function loadUnzipSync() {
  const modulePath = process.env.FFLATE_MODULE_PATH
  if (modulePath) {
    return require(modulePath).unzipSync
  }
  return require('fflate').unzipSync
}

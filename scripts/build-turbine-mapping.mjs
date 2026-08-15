#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clean,
  normalizeTurbineId,
  zipExpandedTurbineRows,
} from './turbine-id-utils.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const unzipSync = loadUnzipSync()
const mappingPath = resolve(
  process.argv[2] || join(root, '风机故障码', '故障信息整理', '场站-型号映射表.xlsx'),
)
const outPath = resolve(
  process.argv[3] || join(root, 'src', 'data', 'turbineMapping.json'),
)

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
const entries = buildTurbineMapping(rows)
await writeFile(outPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')

console.log(`Wrote ${entries.length} turbine mapping entries`)
console.log(outPath)

function buildTurbineMapping(rows) {
  const bySiteAndId = new Map()
  for (const row of rows) {
    const siteName = row.site.endsWith('风电场') ? row.site : `${row.site}风电场`
    const turbines = zipExpandedTurbineRows(row.labelIds, row.unitNumbers)
    for (const turbine of turbines) {
      const key = normalizeTurbineId(turbine.labelId)
      if (!key) continue
      const compositeKey = `${normalizeSiteKey(row.site)}\u0000${key}`
      bySiteAndId.set(compositeKey, {
        turbineId: key,
        unitNumber: turbine.unitNumber || '',
        site: clean(row.site),
        siteFull: siteName,
        brand: clean(row.brand),
        model: clean(row.model),
        standardModel: clean(row.type),
      })
    }
  }
  return [...bySiteAndId.values()].sort((a, b) =>
    a.site.localeCompare(b.site, 'zh-Hans-CN') ||
    a.turbineId.localeCompare(b.turbineId, 'en', { numeric: true }),
  )
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
  const unitNumberColumn = findColumnByAliases(header, UNIT_NUMBER_ALIASES)
  const labelIdColumn = findColumnByAliases(header, LABEL_ID_ALIASES)
  const rows = []
  let site = ''
  let brand = ''
  let model = ''
  for (const row of sheetRows.slice(1)) {
    site = clean(row.A) || site
    brand = clean(row.B) || brand
    model = clean(row.C) || model
    const type = clean(row.D)
    const unitNumbers = unitNumberColumn ? clean(row[unitNumberColumn]) : ''
    const labelIds = labelIdColumn ? clean(row[labelIdColumn]) : unitNumbers
    if (!site || !brand || !model || !labelIds) continue
    rows.push({ site, brand, model, type, unitNumbers, labelIds })
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

function cleanHeader(value) {
  return clean(value).replace(/\s+/g, '')
}

function normalizeSiteKey(value) {
  return clean(value)
    .replace(/风电场$/u, '')
    .toLowerCase()
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function loadUnzipSync() {
  const modulePath = process.env.FFLATE_MODULE_PATH
  if (modulePath) {
    return require(modulePath).unzipSync
  }
  return require('fflate').unzipSync
}

#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'offline-dist')
const BASE_GLOB_PREFIX = 'windrise-ubuntu-offline-'
const SOURCE_DIR_NAME = '风机故障码'
const FRESH_DIR_NAME = '故障码0610'
const STANDARD_MAPPING_NAME = '00 表达式规则涉及的要配置的标准化-型号和故障手册.md'
const XLSX_MAPPING_NAME = '场站-型号映射表.xlsx'

const args = parseArgs(process.argv.slice(2))
const stamp = timestamp()
const buildRoot = resolve(args.buildRoot ?? `/tmp/windrise-0610-only-build-${stamp}`)
const outDir = resolve(args.outDir ?? OUT_DIR)
const baseBundle = resolve(args.baseBundle ?? await findNewestBaseBundle(outDir))
const extractDir = join(buildRoot, 'extract')
const projectRoot = join(extractDir, 'windrise')
const bundleName = `windrise-ubuntu-vllm-0610-only-${stamp}.tar.gz`
const bundlePath = join(outDir, bundleName)
const deliveryDir = join(outDir, `windrise-ubuntu-vllm-0610-only-delivery-${stamp}`)

await main()

async function main() {
  console.log(`Base bundle: ${baseBundle}`)
  console.log(`Build root: ${buildRoot}`)

  await rm(buildRoot, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  console.log('[1/6] Extracting base Ubuntu offline runtime')
  await execFileAsync('tar', ['-xzf', baseBundle, '-C', extractDir], {
    maxBuffer: 1024 * 1024 * 64,
  })

  console.log('[2/6] Replacing packaged project with current workspace')
  await rm(projectRoot, { recursive: true, force: true })
  await mkdir(projectRoot, { recursive: true })
  await execFileAsync(
    'rsync',
    [
      '-a',
      '--delete',
      '--exclude',
      '.git',
      '--exclude',
      '.DS_Store',
      '--exclude',
      'node_modules',
      '--exclude',
      'offline-dist',
      '--exclude',
      'hn/.venv',
      '--exclude',
      'hn/logs',
      '--exclude',
      'hn/.env',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/.env',
      '--exclude',
      '__pycache__',
      '--exclude',
      'hn/__pycache__',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/__pycache__',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/offline_install',
      '--exclude',
      'hn/chat_users.db',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/chat_users.db',
      '--exclude',
      'hn/bootstrap_admin_credentials.txt',
      '--exclude',
      'hn/flask_secret_key',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/flask_secret_key',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal.tar.gz',
      '--exclude',
      '*.pyc',
      `${ROOT}/`,
      `${projectRoot}/`,
    ],
    { maxBuffer: 1024 * 1024 * 64 },
  )

  console.log('[3/6] Building 0610-only fault data with site/model mapping')
  await cp(join(projectRoot, 'deploy', 'ubuntu-offline', 'run-web.sh'), join(extractDir, 'run-web.sh'))
  await cp(join(projectRoot, 'deploy', 'ubuntu-offline', 'install_offline.sh'), join(extractDir, 'install_offline.sh'))
  await chmod(join(extractDir, 'run-web.sh'), 0o755)
  await chmod(join(extractDir, 'install_offline.sh'), 0o755)
  await cp(
    join(projectRoot, 'deploy', 'ubuntu-offline', 'windrise-bash'),
    join(projectRoot, 'bin', 'windrise-bash'),
  )
  await chmod(join(projectRoot, 'bin', 'windrise'), 0o755)
  await chmod(join(projectRoot, 'bin', 'windrise-bash'), 0o755)
  const result = await make0610OnlyProject(projectRoot)

  console.log('[4/6] Rebuilding LLMWiki from 0610-only data')
  await execFileAsync(process.execPath, [join(projectRoot, 'scripts', 'build-wind-llmwiki.mjs')], {
    cwd: projectRoot,
    env: process.env,
    maxBuffer: 1024 * 1024 * 64,
  })
  await write0610Readmes(extractDir, projectRoot, result)

  console.log('[5/6] Writing 0610-only Ubuntu offline bundle')
  await execFileAsync('tar', ['-czf', bundlePath, '-C', extractDir, '.'], {
    maxBuffer: 1024 * 1024 * 64,
  })

  console.log('[6/6] Writing delivery directory and checksums')
  await rm(deliveryDir, { recursive: true, force: true })
  await mkdir(deliveryDir, { recursive: true })
  await cp(bundlePath, join(deliveryDir, bundleName))
  const sha256 = await fileSha256(bundlePath)
  await writeFile(join(deliveryDir, 'SHA256SUMS.txt'), `${sha256}  ${bundleName}\n`, 'utf8')
  await writeFile(join(deliveryDir, 'README_0610_ONLY.md'), deliveryReadme(bundleName, result), 'utf8')

  console.log(JSON.stringify({
    bundle: bundlePath,
    delivery: deliveryDir,
    sha256,
    records: result.recordCount,
    sites: result.bySite,
    brands: result.byBrand,
    models: result.byModel,
  }, null, 2))
}

async function make0610OnlyProject(root) {
  const sourceRoot = join(root, SOURCE_DIR_NAME)
  const freshSource = join(sourceRoot, FRESH_DIR_NAME)
  const sourceBackup = join(dirname(sourceRoot), '.0610-only-source')
  const indexPath = join(sourceRoot, 'fault-index.jsonl')
  const summaryPath = join(sourceRoot, 'fault-index-summary.json')
  const mappingPath = join(freshSource, XLSX_MAPPING_NAME)

  const mappingRows = parseMappingWorkbook(await readFile(mappingPath))
  const mapping = buildSiteModelMapping(mappingRows)
  const originalRecords = await readJsonl(indexPath)
  const records = originalRecords
    .filter(record => String(record.source ?? '').startsWith(`${FRESH_DIR_NAME}/`))
    .map(normalize0610Record)
    .map(record => applySiteMapping(record, mapping.byBrandModel))

  if (records.length === 0) {
    throw new Error('No 0610 records were found in fault-index.jsonl')
  }

  const missing = records.filter(record => !record.site)
  if (missing.length > 0) {
    const preview = missing.slice(0, 10).map(record => `${record.brand}/${record.model} ${record.code}`).join(', ')
    throw new Error(`Some 0610 records did not match the site/model table: ${preview}`)
  }

  await rm(sourceBackup, { recursive: true, force: true })
  await cp(freshSource, sourceBackup, { recursive: true })
  await rm(sourceRoot, { recursive: true, force: true })
  await mkdir(sourceRoot, { recursive: true })
  await cp(sourceBackup, join(sourceRoot, FRESH_DIR_NAME), { recursive: true })
  await rm(sourceBackup, { recursive: true, force: true })

  await writeFile(indexPath, records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  const summary = summarize(records, root)
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8')
  await writeFile(
    join(sourceRoot, STANDARD_MAPPING_NAME),
    renderStandardMapping(mapping.uniqueRows),
    'utf8',
  )
  await rm(join(root, 'wind-llmwiki'), { recursive: true, force: true })

  return {
    recordCount: records.length,
    mappingRows: mappingRows.length,
    bySite: summary.bySite,
    byBrand: summary.byBrand,
    byModel: summary.byModel,
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
  if (!sheetName) throw new Error('No worksheet found in mapping xlsx')

  const sheetXml = decoder.decode(zip[sheetName])
  const rows = []
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

  const output = []
  let site = ''
  let brand = ''
  let model = ''
  for (const row of rows.slice(1)) {
    site = clean(row.A) || site
    brand = clean(row.B) || brand
    model = clean(row.C) || model
    const type = clean(row.D)
    if (!site || !brand || !model) continue
    output.push({ site, brand, model, type })
  }
  return output
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

function buildSiteModelMapping(rows) {
  const byBrandModel = new Map()
  const grouped = new Map()
  for (const row of rows) {
    const key = mappingKey(row.brand, row.model)
    const entry = byBrandModel.get(key) ?? {
      brand: row.brand,
      model: row.model,
      sites: new Set(),
      types: new Set(),
    }
    entry.sites.add(row.site)
    if (row.type) entry.types.add(row.type)
    byBrandModel.set(key, entry)

    const groupedKey = `${row.site}\u0000${row.brand}\u0000${row.model}`
    const groupedEntry = grouped.get(groupedKey) ?? {
      site: row.site,
      brand: row.brand,
      model: row.model,
      types: new Set(),
    }
    if (row.type) groupedEntry.types.add(row.type)
    grouped.set(groupedKey, groupedEntry)
  }

  return {
    byBrandModel,
    uniqueRows: [...grouped.values()].map(row => ({
      ...row,
      types: [...row.types],
    })),
  }
}

function applySiteMapping(record, byBrandModel) {
  const entry = byBrandModel.get(mappingKey(record.brand, record.model))
  const site = entry ? [...entry.sites].join('、') : ''
  const typeText = entry?.types?.size ? [...entry.types].join('、') : ''
  const next = { ...record, site }
  if (typeText) next.standardModel = typeText

  const text = clean(next.text)
  const sitePrefix = site ? `场站：${site}。` : ''
  const typePrefix = typeText ? `映射型号：${typeText}。` : ''
  if (sitePrefix && !text.includes(sitePrefix)) {
    next.text = `${sitePrefix}${typePrefix}${text}`
  }
  return next
}

function normalize0610Record(record) {
  const next = { ...record }
  next.code = clean(next.code).replace(/。对应的变频器故障$/u, '')
  next.source = clean(next.source).replace(/^故障�+0610\//u, `${FRESH_DIR_NAME}/`)

  if (!clean(next.name)) {
    const fallbackName =
      matchTextField(next.text, '对应的变频器故障编号') ||
      matchTextField(next.text, '故障名称') ||
      matchTextField(next.text, '故障描述')
    if (fallbackName && fallbackName !== '-') next.name = fallbackName
  }

  if (!clean(next.solution)) {
    const solution = matchTextField(next.text, '变频器故障说明，以及相应处理办法')
    if (solution && solution !== '-') next.solution = solution
  }

  return next
}

function matchTextField(text, field) {
  const match = clean(text).match(new RegExp(`${escapeRegExp(field)}：([^。]+)`))
  return clean(match?.[1])
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function summarize(records, root) {
  return {
    projectPath: join(root, SOURCE_DIR_NAME),
    recordCount: records.length,
    generatedAt: new Date().toISOString(),
    bySite: countBy(records, record => record.site || '未映射'),
    byBrand: countBy(records, record => record.brand || '未知'),
    byModel: countBy(records, record => `${record.brand || '未知'} / ${record.model || '未知'}`),
    byCodeLength: countBy(records, record => String(record.code ?? '').length),
  }
}

function renderStandardMapping(rows) {
  return [
    '# 0610 场站-型号映射表',
    '',
    '本文件由 `故障码0610/场站-型号映射表.xlsx` 生成，只用于 0610-only 离线包。',
    '',
    ...rows.map(row =>
      `- 场站：${row.site}，品牌：${row.brand}，型号名称：${row.model}，台数：${row.types.length || 1}，对应编号：${row.types.join('、') || row.model}`,
    ),
    '',
  ].join('\n')
}

async function write0610Readmes(extractDir, projectRoot, result) {
  const readmePath = join(extractDir, 'README_OFFLINE_UBUNTU.md')
  const existing = await readFile(readmePath, 'utf8').catch(() => '')
  const note = [
    '# Windrise Ubuntu 0610-only 离线运行包',
    '',
    '这个包只包含 `风机故障码/故障码0610` 数据和基于该数据重建的 `wind-llmwiki`。',
    '其他故障码资料、索引记录和图谱节点已从包内移除。',
    '',
    `0610 故障记录：${result.recordCount}`,
    `场站映射：${Object.keys(result.bySite).join('、')}`,
    '',
  ].join('\n')
  await writeFile(readmePath, `${note}\n${existing}`, 'utf8')
  await writeFile(join(projectRoot, 'README_0610_ONLY.md'), deliveryReadme('本包内文件', result), 'utf8')
}

function deliveryReadme(bundleName, result) {
  return [
    '# Windrise Ubuntu 0610-only 交付包',
    '',
    `包文件：\`${bundleName}\``,
    '',
    '内容范围：',
    '',
    '- 只包含 `风机故障码/故障码0610/` 原始资料。',
    '- `风机故障码/fault-index.jsonl` 只包含 0610 的故障记录。',
    '- `wind-llmwiki/` 已用 0610-only 索引重新生成。',
    '- 场站按 `故障码0610/场站-型号映射表.xlsx` 映射写入索引。',
    '- Web/CLI 默认连接本机 LM Studio OpenAI 兼容接口：`LMSTUDIO_BASE_URL=http://127.0.0.1:1234`。',
    '- 包内不携带本机 `hn/.env`、Dify key、运行数据库或 Flask secret。',
    '',
    '0610 数据规模：',
    '',
    `- 故障记录：${result.recordCount}`,
    `- 场站：${Object.entries(result.bySite).map(([key, value]) => `${key} ${value}`).join('；')}`,
    `- 品牌：${Object.entries(result.byBrand).map(([key, value]) => `${key} ${value}`).join('；')}`,
    '',
    '离线 Ubuntu 上使用方式：解压后运行 `bash install_offline.sh`，再运行 `./run-web.sh`。',
    '如本地 LM Studio 地址或模型名不同，启动前设置 `LMSTUDIO_BASE_URL` 和 `LMSTUDIO_MODEL`。',
    '',
  ].join('\n')
}

async function findNewestBaseBundle(outDir) {
  const entries = await readdir(outDir).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.startsWith(BASE_GLOB_PREFIX) || !entry.endsWith('.tar.gz')) continue
    const full = join(outDir, entry)
    const info = await stat(full)
    candidates.push({ path: full, mtime: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates[0]) {
    throw new Error(`No base Ubuntu offline bundle found in ${outDir}`)
  }
  return candidates[0].path
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
}

function countBy(items, keyFn) {
  const counts = {}
  for (const item of items) {
    const key = keyFn(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')),
  )
}

function clean(value) {
  return String(value ?? '').trim()
}

function mappingKey(brand, model) {
  return `${clean(brand)}\u0000${clean(model)}`
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

async function fileSha256(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

function timestamp() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]
    if (item === '--base-bundle') parsed.baseBundle = argv[++index]
    else if (item.startsWith('--base-bundle=')) parsed.baseBundle = item.slice('--base-bundle='.length)
    else if (item === '--out-dir') parsed.outDir = argv[++index]
    else if (item.startsWith('--out-dir=')) parsed.outDir = item.slice('--out-dir='.length)
    else if (item === '--build-root') parsed.buildRoot = argv[++index]
    else if (item.startsWith('--build-root=')) parsed.buildRoot = item.slice('--build-root='.length)
    else if (item === '--help' || item === '-h') {
      console.log(`Usage: node ${relative(ROOT, fileURLToPath(import.meta.url))} [--base-bundle <tar.gz>] [--out-dir <dir>] [--build-root <dir>]`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${item}`)
    }
  }
  return parsed
}

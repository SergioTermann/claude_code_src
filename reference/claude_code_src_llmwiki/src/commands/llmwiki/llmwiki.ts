import { basename, isAbsolute, join, relative, resolve } from 'path'
import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import {
  LLMWIKI_APP_STATE_PATH,
  loadLLMWikiProjectsFromAppState,
  selectLLMWikiProject,
  type LLMWikiProject,
} from '../../utils/llmwikiDiscovery.js'

type FileSnapshot = {
  files?: Record<string, unknown>
  updatedAt?: number
  version?: number
}

type ParsedArgs = {
  command: string
  rest: string[]
  projectPath?: string
  limit?: number
  depth?: number
}

type SearchMatch = {
  score: number
  location: string
  snippet: string
  record?: FaultRecord
}

type FaultRecord = {
  code: string
  name: string
  site: string
  brand: string
  model: string
  standardModel: string
  description: string
  reason: string
  solution: string
  reset: string
  logic: string
  signal: string
  delay: string
  program: string
  yawProgram: string
  brakeProgram: string
  alarmProgram: string
  resetDelay: string
  resetProgram: string
  system: string
  category: string
  location: string
  text: string
}

type FaultRecordGroup = {
  code: string
  name: string
  brand: string
  sites: string[]
  models: string[]
  standardModels: string[]
  systems: string[]
  categories: string[]
  descriptions: string[]
  reasons: string[]
  solutions: string[]
  resets: string[]
  logics: string[]
  programs: string[]
  locations: string[]
  records: FaultRecord[]
}

type SearchTerm = {
  value: string
  weight: number
  required?: boolean
  numeric?: boolean
  weak?: boolean
}

const WIKI_DIR = 'wiki'
const SNAPSHOT_PATH = join('.llm-wiki', 'file-snapshot.json')
const FAULT_INDEX_FILE = 'fault-index.jsonl'
const FAULT_INDEX_SUMMARY_FILE = 'fault-index-summary.json'
const MAX_SEARCH_FILES = 10000
const MAX_SEARCH_RESULTS = 12
const MAX_READ_CHARS = 30000
const MAX_LIST_ITEMS = 80
const DEFAULT_TREE_DEPTH = 2
const STRUCTURED_FAULT_MATCH_PRIORITY = 100000

export const call: LocalCommandCall = async args => {
  try {
    const parsed = parseArgs(args)

    if (parsed.command === 'help') {
      return text(helpText())
    }

    if (parsed.command === 'projects') {
      return text(await renderProjects())
    }

    const project = await selectLLMWikiProject(parsed.projectPath)
    if (!project) {
      return text(
        `No LLMWiki project found.\n\nChecked LLMWIKI_PROJECT, LLMWIKI_DIR, current directory ancestors, and ${LLMWIKI_APP_STATE_PATH}.`,
      )
    }

    switch (parsed.command) {
      case '':
      case 'overview':
      case 'list':
        return text(await renderOverview(project, parsed.limit))
      case 'tree':
        return text(
          await renderTree(project, parsed.rest.join(' ').trim(), parsed),
        )
      case 'search':
        return text(
          await searchProject(
            project,
            parsed.rest.join(' ').trim(),
            parsed.limit,
          ),
        )
      case 'ask':
      case 'answer':
        return text(
          await answerFromProject(
            project,
            parsed.rest.join(' ').trim(),
            parsed.limit,
          ),
        )
      case 'read':
      case 'show':
        return text(
          await readProjectPath(project, parsed.rest.join(' ').trim()),
        )
      case 'path':
        return text(`${project.name}\n${project.path}`)
      default:
        return text(
          `Unknown llmwiki command: ${parsed.command}\n\n${helpText()}`,
        )
    }
  } catch (error) {
    return text(`LLMWiki error: ${toMessage(error)}`)
  }
}

function text(value: string): LocalCommandResult {
  return { type: 'text', value }
}

function helpText(): string {
  return [
    'LLMWiki commands:',
    '  /llmwiki',
    '  /llmwiki projects',
    '  /llmwiki tree [path]',
    '  /llmwiki search <query>',
    '  /llmwiki ask <question>',
    '  /llmwiki read <project-relative-path>',
    '  /llmwiki path',
    '',
    'Options:',
    '  --project <path>  Use a specific .llm-wiki project or text knowledge directory',
    '  --limit <n>      Limit search results or listed entries',
    '  --depth <n>      Limit tree depth',
  ].join('\n')
}

function parseArgs(args: string): ParsedArgs {
  const tokens = tokenize(args)
  let projectPath: string | undefined
  let limit: number | undefined
  let depth: number | undefined
  const rest: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--project' || token === '-p') {
      projectPath = tokens[++i]
      continue
    }
    if (token.startsWith('--project=')) {
      projectPath = token.slice('--project='.length)
      continue
    }
    if (token === '--limit' || token === '-n') {
      limit = parsePositiveInt(tokens[++i])
      continue
    }
    if (token.startsWith('--limit=')) {
      limit = parsePositiveInt(token.slice('--limit='.length))
      continue
    }
    if (token === '--depth') {
      depth = parsePositiveInt(tokens[++i])
      continue
    }
    if (token.startsWith('--depth=')) {
      depth = parsePositiveInt(token.slice('--depth='.length))
      continue
    }
    rest.push(token)
  }

  return {
    command: rest[0]?.toLowerCase() ?? '',
    rest: rest.slice(1),
    projectPath,
    limit,
    depth,
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input.trim()) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

async function renderProjects(): Promise<string> {
  const projects = await loadLLMWikiProjectsFromAppState()
  if (projects.length === 0) {
    return `No LLMWiki projects found in ${LLMWIKI_APP_STATE_PATH}.`
  }

  return [
    'LLMWiki projects:',
    ...projects.map(project => {
      const suffix = project.lastOpened
        ? ` (last opened ${new Date(project.lastOpened).toLocaleString()})`
        : ''
      return `- ${project.name}: ${project.path}${suffix}`
    }),
  ].join('\n')
}

async function renderOverview(
  project: LLMWikiProject,
  limit = MAX_LIST_ITEMS,
): Promise<string> {
  const contentRoot = await getContentRoot(project.path)
  const wikiFiles = await collectFiles([contentRoot])
  const indexedFiles = await loadIndexedFiles(project.path)
  const lines = [
    `LLMWiki project: ${project.name}`,
    `Path: ${project.path}`,
    `Wiki files: ${wikiFiles.length}`,
    `Indexed files: ${indexedFiles.length}`,
    '',
  ]

  const summaryFiles = ['overview.md', 'index.md', 'log.md']
  for (const file of summaryFiles) {
    const absolutePath = join(contentRoot, file)
    if (await exists(absolutePath)) {
      lines.push(`== ${file} ==`)
      lines.push(trimForDisplay(await readFile(absolutePath, 'utf8'), 4000))
      lines.push('')
    }
  }

  lines.push('Wiki entries:')
  lines.push(...(await listDirectory(contentRoot, project.path, limit)))
  lines.push('')
  lines.push(
    'Use /llmwiki tree, /llmwiki search <query>, or /llmwiki read <path>.',
  )
  return lines.join('\n').trim()
}

async function renderTree(
  project: LLMWikiProject,
  inputPath: string,
  parsed: ParsedArgs,
): Promise<string> {
  const root = inputPath
    ? await resolveProjectPath(project.path, inputPath)
    : await getContentRoot(project.path)
  const info = await stat(root)
  if (!info.isDirectory()) {
    return `${relative(project.path, root)} is not a directory.`
  }

  const lines = [`${relative(project.path, root) || '.'}/`]
  await appendTreeLines(
    root,
    project.path,
    lines,
    parsed.depth ?? DEFAULT_TREE_DEPTH,
    parsed.limit ?? MAX_LIST_ITEMS,
  )
  return lines.join('\n')
}

async function listDirectory(
  dirPath: string,
  projectPath: string,
  limit = MAX_LIST_ITEMS,
): Promise<string[]> {
  let entries = []
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return ['- No wiki directory found']
  }

  return entries
    .filter(entry => !entry.name.startsWith('.'))
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(entry => {
      const suffix = entry.isDirectory() ? '/' : ''
      return `- ${relative(projectPath, join(dirPath, entry.name))}${suffix}`
    })
}

async function appendTreeLines(
  dirPath: string,
  projectPath: string,
  lines: string[],
  depth: number,
  limit: number,
  prefix = '',
): Promise<void> {
  if (depth <= 0 || lines.length >= limit + 1) return

  let entries = []
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return
  }

  const visibleEntries = entries
    .filter(entry => !entry.name.startsWith('.'))
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name),
    )

  for (const entry of visibleEntries) {
    if (lines.length >= limit + 1) {
      lines.push(`[truncated at ${limit} entries]`)
      return
    }

    const childPath = join(dirPath, entry.name)
    const suffix = entry.isDirectory() ? '/' : ''
    lines.push(`${prefix}- ${relative(projectPath, childPath)}${suffix}`)

    if (entry.isDirectory()) {
      await appendTreeLines(
        childPath,
        projectPath,
        lines,
        depth - 1,
        limit,
        `${prefix}  `,
      )
    }
  }
}

async function searchProject(
  project: LLMWikiProject,
  query: string,
  limit = MAX_SEARCH_RESULTS,
): Promise<string> {
  if (!query) return 'Usage: /llmwiki search <query>'

  const matches = await collectSearchMatches(project, query, limit)
  if (matches.length === 0) {
    return `No matches for "${query}" in ${project.path}.`
  }

  if (shouldRenderExactFaultCodeAnswer(query, matches)) {
    return renderExactFaultCodeAnswer(query, matches)
  }
  if (shouldRenderFaultCodeLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderFaultNameLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }

  return [
    `Matches for "${query}" in ${project.name}:`,
    ...matches.map(renderSearchMatch),
  ].join('\n\n')
}

async function collectSearchMatches(
  project: LLMWikiProject,
  query: string,
  limit = MAX_SEARCH_RESULTS,
): Promise<SearchMatch[]> {
  const searchableRoots = [
    await getContentRoot(project.path),
    join(project.path, 'purpose.md'),
    join(project.path, 'schema.md'),
    ...(await loadIndexedFiles(project.path)),
  ]
  const files = (await collectFiles(searchableRoots)).filter(
    file => !isIgnoredSearchFile(project.path, file),
  )
  const terms = buildSearchTerms(query)
  const structuredMatches = await collectStructuredFaultMatches(
    project,
    files,
    query,
    terms,
    limit,
  )
  if (isFaultCodeQuery(query) || isFaultCodeLookupQuery(query)) {
    return structuredMatches
  }

  const results: SearchMatch[] = []

  for (const filePath of files.slice(0, MAX_SEARCH_FILES)) {
    let content = ''
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    const lower = content.toLowerCase()
    const pathLower = relative(project.path, filePath).toLowerCase()
    const pathScore = scoreSearchText(pathLower, terms)
    const contentScore = scoreSearchText(lower, terms)
    if (!isSearchHit(pathLower, lower, pathScore, contentScore, terms)) continue

    const match = bestLineMatch(content, terms)
    const fieldScore = scoreFaultCodeFields(content, terms)
    const coverageScore = scoreQueryCoverage(content, terms)
    const snippetIndex = firstTermIndex(lower, terms)
    const snippet = match
      ? match.text
      : makeSnippet(content, snippetIndex >= 0 ? snippetIndex : 0)
    const location = match
      ? `${relative(project.path, filePath)}:${match.lineNumber}`
      : relative(project.path, filePath)
    const score =
      pathScore * 3 +
      contentScore +
      fieldScore +
      coverageScore +
      (match?.score ?? 0)
    results.push({ score, location, snippet })
  }

  const prioritizedStructuredMatches = structuredMatches.map(match => ({
    ...match,
    score: match.score + STRUCTURED_FAULT_MATCH_PRIORITY,
  }))
  const combined = [...prioritizedStructuredMatches, ...results]
    .sort(
      (a, b) =>
        Number(Boolean(b.record)) - Number(Boolean(a.record)) ||
        b.score - a.score,
    )
    .slice(0, limit)

  if (combined.length > 0) return combined
  return await collectLooseSearchMatches(project, files, query, terms, limit)
}

function renderSearchMatch(match: SearchMatch): string {
  return `${match.location}\n${match.snippet}`
}

function isIgnoredSearchFile(projectPath: string, filePath: string): boolean {
  const relativePath = relative(projectPath, filePath)
  return basename(relativePath) === '故障码检索测试用例表.md'
}

async function answerFromProject(
  project: LLMWikiProject,
  query: string,
  limit = 6,
): Promise<string> {
  if (!query) return 'Usage: /llmwiki ask <question>'

  const matches = await collectSearchMatches(project, query, limit)
  if (matches.length === 0) {
    return `No matches for "${query}" in ${project.path}.`
  }

  if (shouldRenderExactFaultCodeAnswer(query, matches)) {
    return renderExactFaultCodeAnswer(query, matches)
  }
  if (shouldRenderFaultCodeLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderFaultNameLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }

  const primary = matches[0]
  const fields = parseChineseFields(primary.snippet)
  const code = primary.record?.code || faultCodeFromFields(fields)
  const name = cleanFaultName(primary.record?.name || faultNameFromFields(fields))
  const description =
    primary.record?.description ||
    field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象')
  const reason = primary.record?.reason || field(fields, '故障原因')
  const solution =
    primary.record?.solution ||
    field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位')
  const reset =
    primary.record?.reset ||
    field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3')
  const logic = primary.record?.logic || field(fields, '故障逻辑')
  const signal = primary.record?.signal || field(fields, '信号源', '信号部位')
  const delay = primary.record?.delay || field(fields, '设置延迟')
  const program = primary.record?.program || programSummary(fields)
  const site = primary.record?.site || field(fields, '风场')
  const brand = primary.record?.brand || field(fields, '品牌')
  const model = primary.record?.model || field(fields, '机型')
  const standardModel =
    primary.record?.standardModel || field(fields, '映射型号', '具体型号')
  const coverageLines = primary.record ? renderFaultRecordCoverage([primary.record]) : []

  const lines = [
    `本地答案：${query}`,
    '',
    code && name
      ? `结论：${code} 为「${name}」。`
      : `结论：本地知识库命中 ${matches.length} 条相关资料。`,
    site || brand || model
      ? `对象：${[
          site,
          brand,
          model,
          standardModel ? `具体型号：${standardModel}` : '',
        ]
          .filter(Boolean)
          .join(' / ')}`
      : '',
    brand ? `品牌：${brand}` : '',
    model ? `机型：${model}` : '',
    standardModel ? `具体型号：${standardModel}` : '',
    code ? `故障代码：${formatFaultCodeForAnswer(code)}` : '',
    name ? `故障名称：${name}` : '',
    coverageLines.length > 0 ? '风场/机型：' : '',
    ...coverageLines.map(line => `- ${line}`),
    description ? `故障描述：${formatFaultTextForAnswer(description)}` : '',
    reason ? `原因：${formatFaultTextForAnswer(reason)}` : '',
    signal ? `信号源：${formatFaultTextForAnswer(signal)}` : '',
    delay ? `延迟：${formatFaultTextForAnswer(delay)}` : '',
    program ? `程序：${formatFaultTextForAnswer(program)}` : '',
    solution ? `处理：${formatFaultTextForAnswer(solution)}` : '',
    reset ? `${resetLabelForFaultRecord(primary.record)}：${formatFaultTextForAnswer(reset)}` : '',
    logic ? `逻辑：${formatFaultTextForAnswer(logic)}` : '',
    `来源：${displaySearchMatchLocation(primary)}`,
  ].filter(Boolean)

  if (!reason && !solution && !name) {
    lines.push('', '原始命中：', primary.snippet)
  }

  const extraSources = relatedSupplementalMatches(primary, matches)
    .slice(0, 3)
    .map(match => `- ${displaySearchMatchLocation(match)}`)
  if (extraSources.length > 0) {
    lines.push('', '补充来源：', ...extraSources)
  }

  return lines.join('\n')
}

function shouldRenderExactFaultCodeAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const records = matches
    .map(match => match.record)
    .filter(isFaultRecord)
    .filter(record => faultCodesEqual(record.code, codes[0] ?? ''))
  if (records.length < 1) return false

  return true
}

function renderExactFaultCodeAnswer(
  query: string,
  matches: SearchMatch[],
): string {
  const codes = extractFaultCodes(query)
  const exactRecords =
    codes.length === 1
      ? matches
          .map(match => match.record)
          .filter(isFaultRecord)
          .filter(record => faultCodesEqual(record.code, codes[0] ?? ''))
      : matches.map(match => match.record).filter(isFaultRecord)
  const records = aggregateFaultRecords(
    filterFaultRecordsBySpecifiedDimension(exactRecords, query),
  )
  const exactGroups = records
  const displayedGroups = exactGroups.length > 0 ? exactGroups : records
  const rawRecordCount = displayedGroups.reduce(
    (sum, group) => sum + group.records.length,
    0,
  )
  const coverageCount = new Set(
    displayedGroups.flatMap(group => renderFaultRecordCoverage(group.records, query)),
  ).size
  const coverageLines = [
    ...new Set(
      displayedGroups.flatMap(group => renderFaultRecordCoverage(group.records, query)),
    ),
  ]
  const codeLabel = displayedGroups[0]?.code || codes[0] || query
  const renderedCodeLabel = formatFaultCodeForAnswer(codeLabel)

  return [
    `## 本地答案：${query}`,
    '',
    displayedGroups.length > 1
      ? `**结论：** 故障码 ${renderedCodeLabel} 在本地知识库中命中 ${rawRecordCount} 条记录，覆盖 ${coverageCount} 组风场/机型，归并为 ${displayedGroups.length} 类不同含义；下面先列全量风场/机型，再按含义分组说明。`
      : displayedGroups[0]?.name
        ? `**结论：** 故障码 ${renderedCodeLabel} 为「${displayedGroups[0].name}」，在本地知识库中命中 ${rawRecordCount} 条记录，覆盖 ${coverageCount} 组风场/机型。`
        : `**结论：** 故障码 ${renderedCodeLabel} 在本地知识库中命中 ${rawRecordCount} 条记录，覆盖 ${coverageCount} 组风场/机型。`,
    '',
    coverageLines.length > 0 ? `### 风场/机型明细（共 ${coverageLines.length} 组）` : '',
    ...coverageLines.map((line, index) => `- ${index + 1}. ${line}`),
    coverageLines.length > 0 ? '' : '',
    displayedGroups.length > 1 ? `### 故障含义分组（共 ${displayedGroups.length} 类）` : '',
    displayedGroups.length > 1 ? '' : '',
    ...displayedGroups.map((group, index) => {
      const object = [
        filteredGroupSites(group, query).join('、'),
        group.brand,
        group.models.join('、'),
        group.standardModels.length > 0
          ? `具体型号：${group.standardModels.join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join(' / ')
      const coverageLines = renderFaultRecordCoverage(group.records, query)
      return [
        `${index + 1}. ${formatFaultCodeForAnswer(group.code)}${group.name ? `：${group.name}` : ''}`,
        object ? `   对象：${object}` : '',
        group.brand ? `   品牌：${group.brand}` : '',
        group.models.length > 0 ? `   机型：${group.models.join('、')}` : '',
        group.standardModels.length > 0
          ? `   具体型号：${group.standardModels.join('、')}`
          : '',
        `   故障代码：${formatFaultCodeForAnswer(group.code)}`,
        group.name ? `   故障名称：${group.name}` : '',
        coverageLines.length > 0 ? '   风场/机型：' : '',
        ...coverageLines.map(line => `   - ${line}`),
        group.descriptions[0]
          ? `   故障描述：${formatFaultTextForAnswer(group.descriptions[0])}`
          : '',
        group.reasons[0] ? `   原因：${formatFaultTextForAnswer(group.reasons[0])}` : '',
        group.programs[0]
          ? `   程序：${formatFaultTextForAnswer(group.programs.join('；'))}`
          : '',
        group.solutions[0]
          ? `   处理：${formatFaultTextForAnswer(group.solutions[0])}`
          : '',
        group.resets[0]
          ? `   ${resetLabelForFaultRecords(group.records)}：${formatFaultTextForAnswer(group.resets.join('；'))}`
          : '',
        `   来源：${group.locations.slice(0, 3).join('；')}`,
      ]
        .filter(Boolean)
        .join('\n')
    }),
  ].join('\n')
}

function filterFaultRecordsBySpecifiedDimension(
  records: FaultRecord[],
  query: string,
): FaultRecord[] {
  const queryLower = query.toLowerCase()
  const filtered = records.filter(record =>
    faultRecordDimensionMatchesQuery(record, queryLower),
  )
  return filtered.length > 0 ? filtered : records
}

function faultRecordDimensionMatchesQuery(
  record: FaultRecord,
  queryLower: string,
): boolean {
  return [record.site, record.brand, record.model, record.standardModel]
    .filter(Boolean)
    .some(value => dimensionValueMatchesQuery(value, queryLower))
}

function dimensionValueMatchesQuery(value: string, queryLower: string): boolean {
  const lower = normalizeDimensionText(value)
  const normalizedQuery = normalizeDimensionText(queryLower)
  if (!lower) return false
  if (normalizedQuery.includes(lower)) return true
  for (const token of lower.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (/^\d+$/.test(token) && token.length < 3) continue
    if (normalizedQuery.includes(token)) return true
  }
  return false
}

function normalizeDimensionText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/仕花道/g, '什花道')
    .replace(/什花到/g, '什花道')
    .trim()
}

function shouldRenderFaultCodeLookupAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  if (!isFaultCodeLookupQuery(query)) return false
  const records = faultCodeLookupRecords(query, matches)
  return records.length > 0
}

function shouldRenderFaultNameLookupAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  if (extractFaultCodes(query).length > 0) return false
  const records = faultCodeLookupRecords(query, matches)
  if (records.length < 1) return false
  const normalizedQuery = normalizeFaultNameForGrouping(
    normalizeFaultCodeLookupQuery(query),
  )
  if (normalizedQuery.length < 4) return false
  return records.some(record =>
    normalizeFaultNameForGrouping(record.name).includes(normalizedQuery),
  )
}

function renderFaultCodeLookupAnswer(
  query: string,
  matches: SearchMatch[],
): string {
  const lookupText = normalizeFaultCodeLookupQuery(query)
  const records = aggregateFaultRecords(faultCodeLookupRecords(query, matches))
  const rawRecordCount = records.reduce((sum, group) => sum + group.records.length, 0)
  const coverageCount = new Set(
    records.flatMap(group => renderFaultRecordCoverage(group.records, query)),
  ).size
  const codeCount = new Set(records.flatMap(group => faultCodeAliases(group.code))).size

  return [
    `## 本地答案：${query}`,
    '',
    `**结论：** 按名称/描述「${lookupText || query}」在本地知识库中命中 ${rawRecordCount} 条记录，覆盖 ${coverageCount} 组风场/机型，涉及 ${codeCount || records.length} 个故障码。`,
    '',
    ...records.map((group, index) => {
      const object = [
        filteredGroupSites(group, query).join('、'),
        group.brand,
        group.models.join('、'),
        group.standardModels.length > 0
          ? `具体型号：${group.standardModels.join('、')}`
          : '',
      ]
        .filter(Boolean)
        .join(' / ')
      const coverageLines = renderFaultRecordCoverage(group.records, query)
      return [
        `${index + 1}. ${formatFaultCodeForAnswer(group.code)}${group.name ? `：${group.name}` : ''}`,
        object ? `   对象：${object}` : '',
        group.brand ? `   品牌：${group.brand}` : '',
        group.models.length > 0 ? `   机型：${group.models.join('、')}` : '',
        group.standardModels.length > 0
          ? `   具体型号：${group.standardModels.join('、')}`
          : '',
        `   故障代码：${formatFaultCodeForAnswer(group.code)}`,
        group.name ? `   故障名称：${group.name}` : '',
        coverageLines.length > 0 ? '   风场/机型：' : '',
        ...coverageLines.map(line => `   - ${line}`),
        group.descriptions[0]
          ? `   故障描述：${formatFaultTextForAnswer(group.descriptions[0])}`
          : '',
        group.reasons[0] ? `   原因：${formatFaultTextForAnswer(group.reasons[0])}` : '',
        group.programs[0]
          ? `   程序：${formatFaultTextForAnswer(group.programs.join('；'))}`
          : '',
        group.solutions[0]
          ? `   处理：${formatFaultTextForAnswer(group.solutions[0])}`
          : '',
        group.resets[0]
          ? `   ${resetLabelForFaultRecords(group.records)}：${formatFaultTextForAnswer(group.resets.join('；'))}`
          : '',
        `   来源：${group.locations.slice(0, 3).join('；')}`,
      ]
        .filter(Boolean)
        .join('\n')
    }),
  ].join('\n')
}

function faultCodeLookupRecords(
  query: string,
  matches: SearchMatch[],
): FaultRecord[] {
  const seen = new Set<string>()
  const records: FaultRecord[] = []
  for (const record of matches.map(match => match.record).filter(isFaultRecord)) {
    if (!faultRecordMatchesLookupQuery(record, query)) continue
    const key = [
      record.code,
      record.name,
      record.site,
      record.brand,
      record.model,
      record.standardModel,
      record.location,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    records.push(record)
  }
  return records
}

function renderFaultRecordCoverage(records: FaultRecord[], query = ''): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  const specifiedSites = specifiedSiteLabels(query, records)
  for (const record of records) {
    const siteLabels = splitSiteLabels(record.site)
    const selectedSites =
      specifiedSites.size > 0
        ? siteLabels.filter(site => specifiedSites.has(normalizeSiteLabel(site)))
        : siteLabels
    if (specifiedSites.size > 0 && selectedSites.length === 0) continue
    for (const site of selectedSites.length > 0 ? selectedSites : ['']) {
      const line = [
        site ? `风场：${site}` : '',
        record.brand ? `品牌：${record.brand}` : '',
        record.model ? `机型：${record.model}` : '',
        record.standardModel ? `具体型号：${record.standardModel}` : '',
      ]
        .filter(Boolean)
        .join(' / ')
      if (!line || seen.has(line)) continue
      seen.add(line)
      lines.push(line)
    }
  }
  return lines
}

function filteredGroupSites(group: FaultRecordGroup, query: string): string[] {
  const specifiedSites = specifiedSiteLabels(query, group.records)
  if (specifiedSites.size === 0) return group.sites
  const selected = group.sites.filter(site => specifiedSites.has(normalizeSiteLabel(site)))
  return selected.length > 0 ? selected : group.sites
}

function specifiedSiteLabels(query: string, records: FaultRecord[]): Set<string> {
  const normalizedQuery = normalizeDimensionText(query)
  const labels = records.flatMap(record => splitSiteLabels(record.site))
  const specified = new Set<string>()
  for (const label of labels) {
    if (dimensionValueStrictlyMatchesQuery(label, normalizedQuery)) {
      specified.add(normalizeSiteLabel(label))
    }
  }
  return specified
}

function normalizeSiteLabel(value: string): string {
  return normalizeDimensionText(value)
}

function splitSiteLabels(value: string): string[] {
  return value
    .split(/[、,，/]/u)
    .map(item => item.trim())
    .filter(Boolean)
}

function relatedSupplementalMatches(
  primary: SearchMatch,
  matches: SearchMatch[],
): SearchMatch[] {
  if (!primary.record) return matches.slice(1)

  return matches.slice(1).filter(match => {
    const record = match.record
    if (!record) return true
    if (record.code !== primary.record!.code) return false
    if (record.brand && primary.record!.brand && record.brand === primary.record!.brand) {
      return true
    }
    if (record.model && primary.record!.model && record.model === primary.record!.model) {
      return true
    }
    return record.name && primary.record!.name && record.name === primary.record!.name
  })
}

function aggregateFaultRecords(records: FaultRecord[]): FaultRecordGroup[] {
  const groups = new Map<string, FaultRecordGroup>()
  for (const record of records) {
    const key = aggregateRecordKey(record)
    const current =
      groups.get(key) ??
      {
        code: record.code,
        name: cleanFaultName(record.name),
        brand: record.brand,
        sites: [],
        models: [],
        standardModels: [],
        systems: [],
        categories: [],
        descriptions: [],
        reasons: [],
        solutions: [],
        resets: [],
        logics: [],
        programs: [],
        locations: [],
        records: [],
      }

    for (const site of splitSiteLabels(record.site)) {
      pushUnique(current.sites, site)
    }
    pushUnique(current.models, normalizeModelName(record.model))
    pushUnique(current.standardModels, record.standardModel)
    pushUnique(current.systems, record.system)
    pushUnique(current.categories, record.category)
    pushUnique(current.descriptions, record.description)
    pushUnique(current.reasons, record.reason)
    pushUnique(current.solutions, record.solution)
    pushUnique(current.resets, record.reset)
    pushUnique(current.logics, record.logic)
    pushUnique(current.programs, record.program)
    pushUnique(current.locations, displayFaultRecordLocation(record))
    current.records.push(record)
    groups.set(key, current)
  }
  return [...groups.values()]
}

function displaySearchMatchLocation(match: SearchMatch): string {
  return match.record ? displayFaultRecordLocation(match.record) : match.location
}

function displayFaultRecordLocation(record: FaultRecord): string {
  if (!record.code) return record.location
  const normalizedCode = record.code.replace(/\//g, '_')
  const mdIndex = record.location.lastIndexOf('.md')
  if (mdIndex < 0) return record.location
  const beforeExtension = record.location.slice(0, mdIndex)
  const afterExtension = record.location.slice(mdIndex)
  const fileNameStart = beforeExtension.lastIndexOf('/') + 1
  const directory = beforeExtension.slice(0, fileNameStart)
  const fileBase = beforeExtension.slice(fileNameStart)
  if (fileBase.endsWith(`_${normalizedCode}`)) return record.location
  const tailCode =
    fileBase.match(/^(.*_)([A-Za-z]+\d[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)$/) ||
    fileBase.match(/^(.*_)(\d{3,}[A-Za-z0-9-]*)$/)
  if (!tailCode) return record.location
  return `${directory}${tailCode[1]}${normalizedCode}${afterExtension}`
}

function aggregateRecordKey(record: FaultRecord): string {
  return [record.code, record.brand, normalizeFaultNameForGrouping(record.name)]
    .filter(Boolean)
    .join('|')
}

function cleanFaultName(value: string): string {
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

function normalizeFaultNameForGrouping(value: string): string {
  return cleanFaultName(value)
    .replace(/([123])#/g, '$1号')
    .replace(/([123])＃/g, '$1号')
    .replace(/\s+/g, '')
}

function normalizeModelName(value: string): string {
  return value
    .replace(/^(.+?)风机 .*程序故障说明$/, '$1风机')
    .replace(/^(.+?)风机 .+$/, '$1风机')
    .trim()
}

function pushUnique(values: string[], value: string): void {
  const normalized = value.trim()
  if (!normalized || values.includes(normalized)) return
  values.push(normalized)
}

function isFaultRecord(record: FaultRecord | undefined): record is FaultRecord {
  return Boolean(record)
}

function parseChineseFields(value: string): Map<string, string> {
  const keys = [
    '变频器故障代码',
    '变频器故障码',
    '集控是否可复位',
    'Unnamed: 1',
    'Unnamed: 2',
    'Unnamed: 3',
    '故障代码',
    '分类',
    '故障描述/现象',
    '故障描述',
    '故障名称(中文)',
    '故障名称',
    '故障名',
    '中文名称',
    '中文描述',
    '故障信息',
    '故障解释',
    '故障现象',
    '故障现象及处理方法',
    '故障原因',
    '触发和复位条件',
    '故障处理方法',
    '故障处理指导',
    '故障处理',
    '排查操作步骤',
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
    '刹车号',
    '编号',
    '英文名称',
    '报警',
    '序号',
    '解释',
  ]
  const positions = keys
    .map(key => ({ key, index: value.indexOf(`${key}：`) }))
    .filter(item => item.index >= 0)
    .sort((a, b) => a.index - b.index)
  const fields = new Map<string, string>()

  positions.forEach((item, index) => {
    const start = item.index + item.key.length + 1
    const end =
      index + 1 < positions.length ? positions[index + 1]!.index : value.length
    const raw = value.slice(start, end)
    fields.set(item.key, raw.replace(/[，,；;。]\s*$/, '').trim())
  })

  return fields
}

function field(fields: Map<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields.get(key)
    if (value) return value
  }
  return ''
}

function programSummary(fields: Map<string, string>): string {
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

function labeledField(fields: Map<string, string>, key: string): string {
  const value = field(fields, key)
  return value ? `${key}：${value}` : ''
}

async function collectStructuredFaultMatches(
  project: LLMWikiProject,
  files: string[],
  query: string,
  terms: SearchTerm[],
  limit: number,
): Promise<SearchMatch[]> {
  let queryCodes = isFaultCodeQuery(query) ? extractFaultCodes(query) : []
  const records = await loadFaultRecords(project, files)
  const queryLower = query.toLowerCase()
  if (
    queryCodes.length > 0 &&
    !/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(query) &&
    !queryCodes.some(code =>
      records.some(record => faultCodesEqual(record.code, code)),
    )
  ) {
    queryCodes = []
  }
  const shouldKeepAllExactCodeMatches =
    queryCodes.length === 1 &&
    !querySpecifiesRecordDimension(queryLower, records)
  const shouldKeepAllFaultCodeLookupMatches = isFaultCodeLookupQuery(query)

  const scoredCandidates = (shouldKeepAllFaultCodeLookupMatches
    ? records
        .filter(record => faultRecordMatchesLookupQuery(record, query))
        .map(record => ({
          record,
          score: Math.max(
            scoreFaultRecord(record, queryLower, queryCodes, terms),
            9000,
          ),
        }))
    : records.map(record => ({
        record,
        score: scoreFaultRecord(record, queryLower, queryCodes, terms),
      })))
    .filter(candidate => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.location.localeCompare(b.record.location),
    )
  const dimensionFilteredCandidates = querySpecifiesRecordDimension(queryLower, records)
    ? filterCandidatesBySpecifiedDimensions(scoredCandidates, queryLower, records)
    : scoredCandidates
  const candidates =
    dimensionFilteredCandidates.length > 0
      ? dimensionFilteredCandidates
      : scoredCandidates

  const selectedCandidates = shouldKeepAllExactCodeMatches
    ? candidates.filter(candidate =>
        faultCodesEqual(candidate.record.code, queryCodes[0] ?? ''),
      )
    : shouldKeepAllFaultCodeLookupMatches
      ? candidates
    : candidates.slice(0, Math.max(limit, 8))

  return selectedCandidates
    .map(candidate => ({
      score: candidate.score,
      location: candidate.record.location,
      snippet: renderFaultRecordSnippet(candidate.record),
      record: candidate.record,
    }))
}

function querySpecifiesRecordDimension(
  queryLower: string,
  records: FaultRecord[],
): boolean {
  return records.some(record =>
    [...splitSiteLabels(record.site), record.brand, record.model, record.standardModel]
      .filter(Boolean)
      .some(value => dimensionValueStrictlyMatchesQuery(value, queryLower)),
    )
}

function filterCandidatesBySpecifiedDimensions<T extends { record: FaultRecord }>(
  candidates: T[],
  queryLower: string,
  records: FaultRecord[],
): T[] {
  const specified = specifiedRecordDimensions(queryLower, records)
  if (
    specified.sites.size === 0 &&
    specified.brands.size === 0 &&
    specified.models.size === 0
  ) {
    return candidates
  }

  return candidates.filter(candidate => {
    const record = candidate.record
    if (
      specified.sites.size > 0 &&
      !splitSiteLabels(record.site).some(site => specified.sites.has(normalizeSiteLabel(site)))
    ) {
      return false
    }
    if (specified.brands.size > 0 && !specified.brands.has(record.brand)) return false
    if (
      specified.models.size > 0 &&
      !specified.models.has(record.model) &&
      !specified.models.has(record.standardModel)
    ) {
      return false
    }
    return true
  })
}

function specifiedRecordDimensions(
  queryLower: string,
  records: FaultRecord[],
): { sites: Set<string>; brands: Set<string>; models: Set<string> } {
  return {
    sites: specifiedDimensionValues(
      queryLower,
      records.flatMap(record => splitSiteLabels(record.site)),
      normalizeSiteLabel,
    ),
    brands: specifiedDimensionValues(queryLower, records.map(record => record.brand)),
    models: specifiedDimensionValues(queryLower, [
      ...records.map(record => record.model),
      ...records.map(record => record.standardModel),
    ]),
  }
}

function specifiedDimensionValues(
  queryLower: string,
  values: string[],
  normalizeValue: (value: string) => string = value => value,
): Set<string> {
  const specified = new Set<string>()
  for (const value of new Set(values.filter(Boolean))) {
    if (dimensionValueStrictlyMatchesQuery(value, queryLower)) {
      specified.add(normalizeValue(value))
    }
  }
  return specified
}

function dimensionValueStrictlyMatchesQuery(value: string, queryLower: string): boolean {
  const lower = normalizeDimensionText(value)
  const normalizedQuery = normalizeDimensionText(queryLower)
  if (!lower) return false
  if (normalizedQuery.includes(lower)) return true
  for (const token of lower.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (isGenericDimensionToken(token)) continue
    if (/^\d+$/.test(token) && token.length < 3) continue
    if (normalizedQuery.includes(token)) return true
  }
  return false
}

function isGenericDimensionToken(token: string): boolean {
  return [
    '系列',
    '风机',
    '机组',
    '主控',
    '双馈',
    '项目',
    '风电场',
  ].includes(token)
}

async function loadFaultRecords(
  project: LLMWikiProject,
  files: string[],
): Promise<FaultRecord[]> {
  const indexedRecords = await loadFaultIndex(project.path)
  if (indexedRecords.length > 0) return indexedRecords

  const records: FaultRecord[] = []

  for (const filePath of files.slice(0, MAX_SEARCH_FILES)) {
    if (!/\.md$/i.test(filePath)) continue

    let content = ''
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    const relPath = relative(project.path, filePath)
    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed) return
      const fields = parseChineseFields(trimmed)
      if (!isFaultRecordFields(fields)) return
      const code = faultCodeFromFields(fields)
      if (!code) return

      records.push({
        code: cleanFaultCode(code),
        name: faultNameFromFields(fields),
        site: field(fields, '风场'),
        brand: field(fields, '品牌'),
        model: field(fields, '机型'),
        standardModel: field(fields, '映射型号', '具体型号'),
        description: field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象'),
        reason: field(fields, '故障原因'),
        solution: field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位'),
        reset: field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
        logic: field(fields, '故障逻辑'),
        signal: field(fields, '信号源', '信号部位'),
        delay: field(fields, '设置延迟'),
        program: programSummary(fields),
        yawProgram: field(fields, '偏航程序'),
        brakeProgram: field(fields, '制动程序'),
        alarmProgram: field(fields, '报警程序'),
        resetDelay: field(fields, '复位延迟'),
        resetProgram: field(fields, '复位程序'),
        system: field(fields, '系统'),
        category: field(fields, '故障分类', '故障类型', '故障属性', 'SYJX（故障属性）', '分类'),
        location: `${relPath}:${index + 1}`,
        text: trimmed,
      })
    })
  }

  return records
}

async function loadFaultIndex(projectPath: string): Promise<FaultRecord[]> {
  let content = ''
  try {
    content = await readFile(join(projectPath, FAULT_INDEX_FILE), 'utf8')
  } catch {
    return []
  }

  const records: FaultRecord[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const record = normalizeIndexedFaultRecord(JSON.parse(trimmed))
      if (record) records.push(record)
    } catch {
      continue
    }
  }
  return records
}

function normalizeIndexedFaultRecord(value: unknown): FaultRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const code = stringField(raw.code)
  const location = stringField(raw.source) || stringField(raw.location)
  if (!code || !location) return null
  const indexedText = stringField(raw.text)
  const fields = parseChineseFields(indexedText)

  return {
    code: cleanFaultCode(code),
    name: cleanFaultName(stringField(raw.name) || faultNameFromFields(fields)),
    site: stringField(raw.site) || field(fields, '风场'),
    brand: stringField(raw.brand) || field(fields, '品牌'),
    model: stringField(raw.model) || field(fields, '机型'),
    standardModel:
      stringField(raw.standardModel) || field(fields, '映射型号', '具体型号'),
    description:
      stringField(raw.description) ||
      field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象'),
    reason: stringField(raw.reason) || field(fields, '故障原因'),
    solution:
      stringField(raw.solution) ||
      field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位'),
    reset:
      stringField(raw.reset) ||
      field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
    logic: stringField(raw.logic) || field(fields, '故障逻辑'),
    signal: stringField(raw.signal) || field(fields, '信号源', '信号部位'),
    delay: stringField(raw.delay) || field(fields, '设置延迟'),
    program: stringField(raw.program) || programSummary(fields),
    yawProgram: stringField(raw.yawProgram) || field(fields, '偏航程序'),
    brakeProgram: stringField(raw.brakeProgram) || field(fields, '制动程序'),
    alarmProgram: stringField(raw.alarmProgram) || field(fields, '报警程序'),
    resetDelay: stringField(raw.resetDelay) || field(fields, '复位延迟'),
    resetProgram: stringField(raw.resetProgram) || field(fields, '复位程序'),
    system: stringField(raw.system) || field(fields, '系统'),
    category:
      stringField(raw.category) ||
      stringField(raw.classification) ||
      field(fields, '故障分类', '故障类型', '故障属性', 'SYJX（故障属性）', '分类'),
    location,
    text: indexedText,
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isFaultRecordFields(fields: Map<string, string>): boolean {
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

function scoreFaultRecord(
  record: FaultRecord,
  queryLower: string,
  queryCodes: string[],
  terms: SearchTerm[],
): number {
  let score = 0

  for (const code of queryCodes) {
    if (faultCodesEqual(record.code, code)) {
      score += 10000
    } else if (code.length < 5 && faultCodeKey(record.code).endsWith(faultCodeKey(code))) {
      score += 350
    }
  }

  if (queryCodes.some(code => code.length >= 5) && score === 0) {
    return 0
  }

  const searchable = [
    record.code,
    record.name,
    record.site,
    record.brand,
    record.model,
    record.standardModel,
    record.reason,
    record.solution,
    record.reset,
    record.logic,
    record.signal,
    record.delay,
    record.program,
    record.yawProgram,
    record.brakeProgram,
    record.alarmProgram,
    record.resetDelay,
    record.resetProgram,
    record.system,
    record.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const corePhrase = normalizeFaultSearchPhrase(queryLower)
  if (corePhrase.length >= 4 && searchable.replace(/\s+/g, '').includes(corePhrase)) {
    score += 6000
  }

  const normalizedQueryName = normalizeFaultNameForGrouping(queryLower).toLowerCase()
  const normalizedRecordName = normalizeFaultNameForGrouping(record.name).toLowerCase()
  if (
    normalizedRecordName.length >= 4 &&
    normalizedQueryName.includes(normalizedRecordName)
  ) {
    score += 12000
  }

  const filterBonus = scoreStructuredFilters(record, queryLower)
  if (filterBonus < 0) return 0
  score += filterBonus
  score += scoreQueryCoverage(searchable, terms)
  score += scoreSearchText(searchable, terms)

  return score
}

function normalizeFaultSearchPhrase(queryLower: string): string {
  return queryLower
    .replace(/(怎么处理|如何处理|怎样处理|咋处理|处理方法|维修方法|排查方法|是什么故障|是什么|是啥|啥意思|含义|原因|为什么|能不能复位|能否复位|是否可复位|可不可以复位|分别是什么|对应哪些故障码|故障码是什么|故障代码是什么)/gi, '')
    .replace(/(请问|帮我|给我|查询|查一下|查下|查|搜索|检索|一下|下)/gi, '')
    .replace(/(故障码|故障代码|报码|告警码|报警码|状态代码)/gi, '')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
}

function scoreStructuredFilters(record: FaultRecord, queryLower: string): number {
  let score = 0
  const dimensions = [
    record.site,
    record.brand,
    record.model,
    record.standardModel,
    record.system,
    record.category,
  ].filter(Boolean)

  for (const dimension of dimensions) {
    const lower = normalizeDimensionText(dimension)
    const normalizedQuery = normalizeDimensionText(queryLower)
    if (normalizedQuery.includes(lower)) {
      score += 600
      continue
    }
    for (const token of lower.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []) {
      if (normalizedQuery.includes(token)) {
        score += 120
      }
    }
  }

  return score
}

function renderFaultRecordSnippet(record: FaultRecord): string {
  return [
    record.site ? `风场：${record.site}` : '',
    record.brand ? `品牌：${record.brand}` : '',
    record.model ? `机型：${record.model}` : '',
    record.standardModel ? `具体型号：${record.standardModel}` : '',
    `故障代码：${formatFaultCodeForAnswer(record.code)}`,
    record.name ? `故障名称：${record.name}` : '',
    record.description ? `故障描述：${formatFaultTextForAnswer(record.description)}` : '',
    record.reason ? `故障原因：${formatFaultTextForAnswer(record.reason)}` : '',
    record.signal ? `信号源：${formatFaultTextForAnswer(record.signal)}` : '',
    record.delay ? `设置延迟：${formatFaultTextForAnswer(record.delay)}` : '',
    record.program ? `程序：${formatFaultTextForAnswer(record.program)}` : '',
    record.solution ? `故障处理：${formatFaultTextForAnswer(record.solution)}` : '',
    record.reset
      ? `${resetLabelForFaultRecord(record)}：${formatFaultTextForAnswer(record.reset)}`
      : '',
    record.logic ? `故障逻辑：${formatFaultTextForAnswer(record.logic)}` : '',
  ]
    .filter(Boolean)
    .join('，')
}

function formatFaultCodeForAnswer(code: string): string {
  const normalized = String(code || '').trim()
  const scMatch = normalized.match(/^(SC\d{2})_(\d{2})_(\d{3})$/i)
  if (scMatch) {
    const tableCode = `${scMatch[1]}${scMatch[2]} ${scMatch[3]}`.toUpperCase()
    return `${tableCode}（标准码：${normalized.toUpperCase()}）`
  }
  return normalized
}

function formatFaultTextForAnswer(value: string): string {
  return String(value || '')
    .replace(/\$?\s*>\s*20\s*\^\{\\circ\}\s*C\s*\$?/g, '>20°C')
    .replace(/\$?\s*>\s*140\s*\^\{\\circ\}\s*C\s*\$?/g, '>140°C')
    .replace(/\$?\s*>\s*(\d+)\s*\^\{\\circ\}\s*\\mathrm\{C\}\s*\$?/g, '>$1°C')
    .replace(/\$?\s*>\s*(\d+)\s*\^\{\\circ\}\s*C\s*\$?/g, '>$1°C')
    .replace(/\$?\s*<\s*(\d+)\s*\^\{\\circ\}\s*\\mathrm\{C\}\s*\$?/g, '<$1°C')
    .replace(/\$?\s*<\s*(\d+)\s*\^\{\\circ\}\s*C\s*\$?/g, '<$1°C')
    .replace(/\$?\s*>\s*(\d+)\s*\\mathrm\{C\}\s*\$?/g, '>$1°C')
    .replace(/\$?\s*<\s*(\d+)\s*\\mathrm\{C\}\s*\$?/g, '<$1°C')
    .replace(/＞/g, '>')
    .replace(/＜/g, '<')
    .replace(/℃/g, '°C')
    .replace(/\s+([,，。；])/g, '$1')
}

function resetLabelForFaultRecords(records: FaultRecord[]): string {
  return records.some(record => resetLabelForFaultRecord(record) === '复位权限')
    ? '复位权限'
    : '复位'
}

function resetLabelForFaultRecord(record: Pick<FaultRecord, 'reset'> | undefined): string {
  const reset = String(record?.reset ?? '').replace(/\s+/g, '')
  if (/^[0-9A-Z]+(?:[、,，/][0-9A-Z]+)*$/i.test(reset)) {
    return '复位权限'
  }
  return '复位'
}

function faultCodeFromFields(fields: Map<string, string>): string {
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

function faultNameFromFields(fields: Map<string, string>): string {
  return field(
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
    '报警',
    '解释',
    '故障',
  )
}

function extractFaultCodes(query: string): string[] {
  const numericRange = String.raw`\d+\s*(?:至|到|[~～])\s*\d+`
  const numericRangeOrList = String.raw`(?:${numericRange}|\d+)(?:\s*[、,，]\s*(?:${numericRange}|\d+))+`
  const faultCodePattern =
    new RegExp(
      `[a-z]+[a-z0-9_/-]*\\d[a-z0-9_/-]*|${numericRangeOrList}|${numericRange}|\\d+(?:[ _/-]+\\d+)+|\\d+(?:[、,，]\\d+)+|\\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\\d[a-z0-9_/-]*|\\d+`,
      'gi',
    )
  const rawCodes =
    query.match(faultCodePattern) ?? []
  const contextualCodes = [
    ...query.matchAll(
      new RegExp(
        `(?:故障码|故障代码|报码|告警码|报警码|状态代码|fault\\s*code|alarm\\s*code)\\s*[:：为是]?\\s*([a-z]+[a-z0-9_/-]*\\d[a-z0-9_/-]*|${numericRangeOrList}|${numericRange}|\\d+(?:[ _/-]+\\d+)+|\\d+(?:[、,，]\\d+)+|\\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\\d[a-z0-9_/-]*|\\d{1,8})`,
        'gi',
      ),
    ),
  ].map(match => match[1] ?? '')

  const codes = contextualCodes.length > 0
    ? [
        ...contextualCodes,
        ...rawCodes.filter(isLongNumericOrAlphanumericFaultCode),
      ]
    : rawCodes.filter(code => shouldKeepRawFaultCode(query, code))

  return [...new Set(codes.map(code => cleanFaultCode(code).toLowerCase()))]
}

function cleanFaultCode(value: string): string {
  let normalized = value.trim()
  const metadataIndex = normalized.search(
    /[，,；;。]\s*(?:对应|故障|分类|unnamed|bachmann|abb|描述|触发|刹车|制动|报警|偏航|复位|设置|信号源|等级)/i,
  )
  if (metadataIndex > 0) normalized = normalized.slice(0, metadataIndex).trim()
  const trailingCode = normalized.match(/\b([a-z]+_?\d+)\b$/i)?.[1]
  if (trailingCode && /\s/.test(normalized)) return trailingCode
  return normalized
}

function faultCodesEqual(left: string, right: string): boolean {
  const leftAliases = faultCodeAliases(left)
  const rightAliases = new Set(faultCodeAliases(right))
  return leftAliases.some(alias => rightAliases.has(alias))
}

function faultCodeKey(value: string): string {
  return cleanFaultCode(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[_.\-\/]+/g, '')
}

function faultCodeAliases(value: string): string[] {
  const code = cleanFaultCode(value)
  if (!isValidFaultCodeValue(code)) return []

  const expanded = expandNumericFaultCodeRanges(code)
  return [
    ...new Set(
      expanded
        .map(item => faultCodeKey(item))
        .filter(Boolean),
    ),
  ]
}

function isValidFaultCodeValue(value: string): boolean {
  return /\d/.test(value) && /^[a-z0-9_./\-\s、,，至到~～]+$/i.test(value)
}

function expandNumericFaultCodeRanges(value: string): string[] {
  const trimmed = value.trim()
  if (!/^[\d\s、,，至到~～]+$/.test(trimmed)) return [trimmed]

  const parts = trimmed
    .split(/[、,，]/)
    .map(part => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return []

  const expanded: string[] = []
  for (const part of parts) {
    const range = part.match(/^(\d+)\s*(?:至|到|[~～])\s*(\d+)$/)
    if (range) {
      const startText = range[1] ?? ''
      const endText = range[2] ?? ''
      const start = Number(startText)
      const end = Number(endText)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 1000) {
        expanded.push(part)
        continue
      }
      const width = Math.max(startText.length, endText.length)
      for (let code = start; code <= end; code += 1) {
        expanded.push(String(code).padStart(width, '0'))
      }
      continue
    }

    if (/^\d+$/.test(part)) {
      expanded.push(part)
      continue
    }

    return [trimmed]
  }

  return expanded
}

function shouldKeepRawFaultCode(query: string, code: string): boolean {
  return (
    isLongNumericOrAlphanumericFaultCode(code) ||
    isBareNumericFaultCodeQuery(query, code)
  )
}

function isLongNumericOrAlphanumericFaultCode(code: string): boolean {
  return !isNumericToken(code) || code.length >= 3
}

function isNumericToken(value: string): boolean {
  return /^\d+$/.test(value)
}

function isBareNumericFaultCodeQuery(query: string, code: string): boolean {
  const rest = query
    .replace(code, '')
    .replace(
      /(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|的|为|是)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

function isFaultCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length === 0) return false
  if (isBareCodeQuery(query)) return true
  if (/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(query)) return true
  return codes.some(code => /^\d{3,}$/.test(code) || /[a-z]/i.test(code))
}

function isBareCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const rest = query
    .replace(new RegExp(escapeRegExp(codes[0]!), 'i'), '')
    .replace(
      /(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|的|为|是)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

function isFaultCodeLookupQuery(query: string): boolean {
  if (extractFaultCodes(query).length > 0) return false
  const normalized = query.trim()
  if (!normalized) return false
  return (
    /(故障码|故障代码|报码|告警码|报警码|状态代码).*(是什么|多少|哪些|有啥|对应|查询|查|找)/i.test(normalized) ||
    /(是什么|多少|哪些|有啥|对应|查询|查|找).*(故障码|故障代码|报码|告警码|报警码|状态代码)/i.test(normalized)
  )
}

function normalizeFaultCodeLookupQuery(query: string): string {
  return query
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/(对应|相关|所有|全部|可能|有哪些|哪些|多少|是什么|是啥|什么|哪个|哪种|哪家|哪款|查询|查找|查|找|列出|给出|告诉我)/gi, '')
    .replace(/(故障码|故障代码|报码|告警码|报警码|状态代码)/gi, '')
    .replace(/的/g, '')
    .replace(/[？?，,。.、:：\s]/g, '')
    .trim()
}

function faultRecordMatchesLookupQuery(record: FaultRecord, query: string): boolean {
  const lookupText = normalizeFaultCodeLookupQuery(query)
  if (lookupText.length < 2) return false
  const normalizedLookupForBrand = lookupText.toLowerCase()
  for (const brand of KNOWN_FAULT_BRANDS) {
    if (
      normalizedLookupForBrand.includes(brand.toLowerCase()) &&
      !record.brand.toLowerCase().includes(brand.toLowerCase())
    ) {
      return false
    }
  }
  const fields = parseChineseFields(record.text)
  const primaryHaystack = [
    record.name,
    record.description,
    field(fields, '描述', '中文描述', '故障描述', '故障描述/现象', '故障名称', '故障名称(中文)', '故障名', '中文名称'),
    record.system,
    record.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const secondaryHaystack = [
    record.reason,
    record.solution,
    record.logic,
    record.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  let normalizedLookup = lookupText.toLowerCase()
  for (const brand of KNOWN_FAULT_BRANDS) {
    normalizedLookup = normalizedLookup.replaceAll(brand.toLowerCase(), '')
  }
  normalizedLookup = normalizedLookup.trim()
  if (normalizedLookup.length < 2) return false
  const coreLookup = normalizedLookup.replace(/(故障|异常|报警|告警|错误|问题)$/u, '')
  const terms = (coreLookup || normalizedLookup)
    .match(/[a-z0-9_.#/-]+|[\u4e00-\u9fff]{2,}/g)
    ?.filter(term => !FAULT_CODE_LOOKUP_STOP_WORDS.has(term)) ?? []
  if (terms.length === 0) return false
  if (primaryHaystack.includes(normalizedLookup)) return true
  if (coreLookup && primaryHaystack.includes(coreLookup)) return true
  if (terms.every(term => primaryHaystack.includes(term))) return true
  if (/(故障|异常|报警|告警|错误|问题)$/u.test(normalizedLookup)) return false
  return terms.every(term => secondaryHaystack.includes(term))
}

const FAULT_CODE_LOOKUP_STOP_WORDS = new Set([
  '故障',
  '异常',
  '报警',
  '告警',
  '问题',
  '代码',
])

const KNOWN_FAULT_BRANDS = [
  '华仪',
  '华锐',
  '三一',
  '上海电气',
  '运达',
  '明阳',
  '新誉',
  '歌美飒',
  '湘电',
  '远景',
  '金风',
]

function bestLineMatch(
  content: string,
  terms: SearchTerm[],
): { lineNumber: number; text: string; score: number } | null {
  let best: { lineNumber: number; text: string; score: number } | null = null
  const lines = content.split(/\r?\n/)

  lines.forEach((line, index) => {
    const lower = line.toLowerCase()
    const score = scoreSearchText(lower, terms)
    if (score === 0) return
    if (!best || score > best.score) {
      best = {
        lineNumber: index + 1,
        text: trimForDisplay(line.trim(), 520),
        score,
      }
    }
  })

  return best
}

function buildSearchTerms(query: string): SearchTerm[] {
  const terms = new Map<string, SearchTerm>()
  const add = (value: string, weight: number, required = false, weak = false) => {
    const normalized = value.toLowerCase().trim()
    if (normalized.length < 2) return
    const current = terms.get(normalized)
    if (!current || weight > current.weight) {
      terms.set(normalized, {
        value: normalized,
        weight,
        required,
        numeric: /^\d+$/.test(normalized),
        weak,
      })
      return
    }
    if (required) current.required = true
  }

  const normalizedQuery = query.toLowerCase().trim()
  add(normalizedQuery, 30)
  const corePhrase = normalizeFaultSearchPhrase(normalizedQuery)
  if (corePhrase && corePhrase !== normalizedQuery) {
    add(corePhrase, 70)
  }

  for (const code of normalizedQuery.match(/[a-z]?\d[\w_.-]{2,}/g) ?? []) {
    const digitCount = (code.match(/\d/g) ?? []).length
    add(code, digitCount >= 3 ? 80 : 18, digitCount >= 3)
  }

  for (const part of normalizedQuery.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []) {
    if (part === normalizedQuery) continue
    add(part, part.match(/\d/) ? 24 : 16)
  }

  const words = normalizedQuery
    .split(/[\s,，;；:：/\\()[\]（）"'<>]+/)
    .filter(Boolean)
  for (const word of words) {
    add(word, word.match(/\d/) ? 24 : 12)
    if (word.length >= 4 && word.length <= 24) {
      for (const gram of ngrams(word, 2)) {
        add(gram, 3, false, true)
      }
    }
  }

  return [...terms.values()].sort((a, b) => b.weight - a.weight)
}

function scoreQueryCoverage(content: string, terms: SearchTerm[]): number {
  const strongTerms = componentSearchTerms(
    terms.filter(term => !term.weak && !term.numeric),
  )
  if (strongTerms.length < 2) return 0

  const normalizedContent = content.toLowerCase()
  const matched = strongTerms.filter(term =>
    normalizedContent.includes(term.value),
  )
  if (matched.length === 0) return 0

  const coverage = matched.length / strongTerms.length
  let score = matched.reduce((sum, term) => sum + term.weight, 0) * 12
  score += coverage === 1 ? 1200 : coverage * 200

  const orderedSpan = orderedTermSpan(normalizedContent, matched)
  if (orderedSpan >= 0) {
    score += Math.max(160, 720 - orderedSpan)
  }

  return score
}

function componentSearchTerms(terms: SearchTerm[]): SearchTerm[] {
  return terms.filter(
    term =>
      !terms.some(
        other =>
          other !== term &&
          other.value.length < term.value.length &&
          term.value.includes(other.value),
      ),
  )
}

function orderedTermSpan(content: string, terms: SearchTerm[]): number {
  let cursor = 0
  let start = -1
  let end = -1

  for (const term of terms) {
    const index = content.indexOf(term.value, cursor)
    if (index < 0) return -1
    if (start < 0) start = index
    end = index + term.value.length
    cursor = end
  }

  return start >= 0 ? end - start : -1
}

function scoreFaultCodeFields(content: string, terms: SearchTerm[]): number {
  const numericTerms = terms.filter(term => term.numeric)
  if (numericTerms.length === 0) return 0

  let score = 0
  const fieldPattern =
    /(变频器故障代码|变频器故障码|故障代码|故障代号|故障码|状态代码)：\s*([a-z]?\d[\w_.-]*)/gi
  for (const match of content.matchAll(fieldPattern)) {
    const fieldName = match[1] ?? ''
    const fieldValue = (match[2] ?? '').toLowerCase()
    for (const term of numericTerms) {
      if (fieldValue === term.value) {
        score += 1000
      } else if (fieldValue.endsWith(term.value)) {
        score += 180
      } else if (fieldValue.includes(term.value)) {
        score += 40
      }
      if (fieldName.includes('故障') && fieldValue === term.value) {
        score += 250
      }
    }
  }
  return score
}

function ngrams(value: string, size: number): string[] {
  const grams: string[] = []
  for (let index = 0; index <= value.length - size; index++) {
    grams.push(value.slice(index, index + size))
  }
  return grams
}

function isSearchHit(
  pathText: string,
  contentText: string,
  pathScore: number,
  contentScore: number,
  terms: SearchTerm[],
): boolean {
  const combined = pathScore + contentScore
  if (combined <= 0) return false

  const requiredTerms = terms.filter(term => term.required)
  if (
    requiredTerms.length > 0 &&
    !requiredTerms.every(
      term =>
        countOccurrences(pathText, term) > 0 ||
        countOccurrences(contentText, term) > 0,
    )
  ) {
    return false
  }

  const strongestWeight = terms[0]?.weight ?? 0
  return combined >= Math.min(12, Math.max(3, strongestWeight / 4))
}

function scoreSearchText(value: string, terms: SearchTerm[]): number {
  return terms.reduce((sum, term) => {
    const occurrences = countOccurrences(value, term)
    const cappedOccurrences =
      term.numeric ? occurrences : Math.min(occurrences, 3)
    return sum + cappedOccurrences * term.weight
  }, 0)
}

function firstTermIndex(value: string, terms: SearchTerm[]): number {
  const indexes = terms
    .map(term => value.indexOf(term.value))
    .filter(index => index >= 0)
  return indexes.length > 0 ? Math.min(...indexes) : -1
}

function countOccurrences(value: string, term: SearchTerm): number {
  if (term.numeric) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.value)}(?=[^a-z0-9]|$)`, 'gi')
    return [...value.matchAll(pattern)].length
  }

  let count = 0
  let index = value.indexOf(term.value)
  while (index >= 0) {
    count++
    index = value.indexOf(term.value, index + term.value.length)
  }
  return count
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readProjectPath(
  project: LLMWikiProject,
  inputPath: string,
): Promise<string> {
  if (!inputPath) return 'Usage: /llmwiki read <path>'

  const absolutePath = await resolveProjectPath(project.path, inputPath)
  const info = await stat(absolutePath)

  if (info.isDirectory()) {
    return [
      `${relative(project.path, absolutePath)}/`,
      ...(await listDirectory(absolutePath, project.path)),
    ].join('\n')
  }

  if (!info.isFile()) {
    return `${relative(project.path, absolutePath)} is not a regular file.`
  }

  const content = await readFile(absolutePath, 'utf8')
  const truncated = trimForDisplay(content, MAX_READ_CHARS)
  return `# ${relative(project.path, absolutePath)}\n\n${truncated}`
}

async function resolveProjectPath(
  projectPath: string,
  inputPath: string,
): Promise<string> {
  const candidates = isAbsolute(inputPath)
    ? [resolve(inputPath)]
    : [
        resolve(projectPath, inputPath),
        resolve(projectPath, WIKI_DIR, inputPath),
        resolve(projectPath, `${inputPath}.md`),
        resolve(projectPath, WIKI_DIR, `${inputPath}.md`),
      ]

  for (const candidate of candidates) {
    if (!isInside(projectPath, candidate)) continue
    if (existsSync(candidate)) return candidate
  }

  const suggestions = await suggestProjectPaths(projectPath, inputPath)
  const suggestionText =
    suggestions.length > 0
      ? `\n\nDid you mean:\n${suggestions.map(path => `- ${path}`).join('\n')}`
      : ''
  throw new Error(
    `Path not found in LLMWiki project: ${inputPath}${suggestionText}`,
  )
}

async function suggestProjectPaths(
  projectPath: string,
  inputPath: string,
): Promise<string[]> {
  const normalizedInput = inputPath.toLowerCase()
  const inputBase = basename(inputPath).toLowerCase()
  const contentRoot = await getContentRoot(projectPath)
  const files = await collectFiles([contentRoot])
  const directories = await collectDirectories(contentRoot)
  const indexedFiles = await loadIndexedFiles(projectPath)
  const candidates = [...directories, ...files].map(path =>
    relative(projectPath, path),
  )
  candidates.push(...indexedFiles.map(path => relative(projectPath, path)))

  return candidates
    .map(path => ({
      path,
      score: scorePath(path.toLowerCase(), normalizedInput, inputBase),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map(candidate => candidate.path)
}

async function getContentRoot(projectPath: string): Promise<string> {
  const wikiRoot = join(projectPath, WIKI_DIR)
  return (await exists(wikiRoot)) ? wikiRoot : projectPath
}

async function collectDirectories(rootPath: string): Promise<string[]> {
  const directories: string[] = []
  if (!(await exists(rootPath))) return directories

  const entries = await readdir(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childPath = join(rootPath, entry.name)
    if (!entry.isDirectory()) continue
    directories.push(childPath)
    directories.push(...(await collectDirectories(childPath)))
  }

  return directories
}

function scorePath(path: string, input: string, inputBase: string): number {
  let score = 0
  if (path.includes(input)) score += 5
  if (inputBase && path.includes(inputBase)) score += 3
  for (const term of input.split(/[\\/._\-\s]+/).filter(Boolean)) {
    if (path.includes(term)) score += 1
  }
  return score
}

async function collectFiles(
  paths: string[],
  seen = new Set<string>(),
): Promise<string[]> {
  const files: string[] = []

  for (const itemPath of paths) {
    if (!(await exists(itemPath))) continue
    const info = await stat(itemPath)
    if (info.isFile()) {
      if (isTextLike(itemPath) && !seen.has(itemPath)) {
        seen.add(itemPath)
        files.push(itemPath)
      }
      continue
    }
    if (!info.isDirectory()) continue

    const entries = await readdir(itemPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const childPath = join(itemPath, entry.name)
      if (entry.isDirectory()) {
        files.push(...(await collectFiles([childPath], seen)))
      } else if (entry.isFile() && isTextLike(childPath)) {
        if (!seen.has(childPath)) {
          seen.add(childPath)
          files.push(childPath)
        }
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b))
}

async function collectLooseSearchMatches(
  project: LLMWikiProject,
  files: string[],
  query: string,
  terms: SearchTerm[],
  limit: number,
): Promise<SearchMatch[]> {
  const queryLower = query.toLowerCase()
  const looseTerms = componentSearchTerms(
    terms.filter(term => !term.weak && !term.numeric),
  ).map(term => term.value)
  const selectedTerms =
    looseTerms.length > 0 ? looseTerms : terms.map(term => term.value)
  const requiredTerms = terms.filter(term => term.required)

  const results: SearchMatch[] = []
  for (const filePath of files.slice(0, MAX_SEARCH_FILES)) {
    let content = ''
    try {
      content = await readFile(filePath, 'utf8')
    } catch {
      continue
    }

    const lower = content.toLowerCase()
    const pathLower = relative(project.path, filePath).toLowerCase()
    if (
      requiredTerms.length > 0 &&
      !requiredTerms.every(
        term =>
          countOccurrences(pathLower, term) > 0 ||
          countOccurrences(lower, term) > 0,
      )
    ) {
      continue
    }
    const matchedTerms = selectedTerms.filter(
      term => pathLower.includes(term) || lower.includes(term),
    )
    if (matchedTerms.length === 0) continue

    const score =
      matchedTerms.reduce((sum, term) => sum + Math.max(1, term.length), 0) +
      (pathLower.includes(queryLower) || lower.includes(queryLower) ? 10 : 0)
    results.push({
      score,
      location: relative(project.path, filePath),
      snippet: makeSnippet(content, firstTermIndex(lower, terms) >= 0 ? firstTermIndex(lower, terms) : 0),
    })
  }

  return results
    .sort((a, b) => b.score - a.score || a.location.localeCompare(b.location))
    .slice(0, limit)
}

async function loadIndexedFiles(projectPath: string): Promise<string[]> {
  let snapshot: FileSnapshot
  try {
    snapshot = JSON.parse(
      await readFile(join(projectPath, SNAPSHOT_PATH), 'utf8'),
    ) as FileSnapshot
  } catch {
    return []
  }

  return Object.keys(snapshot.files ?? {})
    .map(path => resolve(projectPath, path))
    .filter(path => isInside(projectPath, path) && isTextLike(path))
}

function isTextLike(filePath: string): boolean {
  const fileName = basename(filePath)
  if (fileName === FAULT_INDEX_FILE || fileName === FAULT_INDEX_SUMMARY_FILE) {
    return false
  }
  return /\.(md|mdx|txt|csv|json|html?|rtf)$/i.test(filePath)
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function makeSnippet(content: string, index: number): string {
  const start = Math.max(0, index - 140)
  const end = Math.min(content.length, index + 360)
  return trimForDisplay(content.slice(start, end).replace(/\s+/g, ' '), 520)
}

function trimForDisplay(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value.trim()
  return `${value.slice(0, maxChars).trim()}\n\n[truncated]`
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

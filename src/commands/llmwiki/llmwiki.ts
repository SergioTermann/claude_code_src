import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
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
import {
  expandTurbineTokensForExclusion,
  extractTurbineIdsFromText,
  extractSiteFromText,
  hasFaultHandlingIntent,
  lookupTurbineMapping,
  recordMatchesMappedTurbineModel,
  recordMatchesTurbineId,
  renderTurbineMappingAnswer,
  resolveTurbineContextFromQuery,
  shouldAnswerTurbineMappingQuestion,
  splitTurbineIds,
} from '../../utils/turbineMapping.js'

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
  turbineIds: string
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
  boundary?: boolean
  weak?: boolean
}

type FaultFeatureSet = {
  components: Set<string>
  symptoms: Set<string>
}

const WIKI_DIR = 'wiki'
const SNAPSHOT_PATH = join('.llm-wiki', 'file-snapshot.json')
const INDEX_SOURCE_PATH = join('.llm-wiki', 'index-source.json')
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

  const turbineAnswer = renderTurbineLookupIfNeeded(query)
  if (turbineAnswer) return turbineAnswer

  const matches = await collectSearchMatches(project, query, limit)
  if (matches.length === 0) {
    return `No matches for "${query}" in ${project.path}.`
  }

  if (shouldRenderFaultCodeLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderTemperatureFamilyLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderFaultNameLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderMultiFaultCodeAnswer(query, matches)) {
    return renderMultiFaultCodeAnswer(query, matches)
  }
  if (shouldRenderExactFaultCodeAnswer(query, matches)) {
    return renderExactFaultCodeAnswer(query, matches)
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
  if (isNonFaultMeasurementOrRatingQuestion(query)) {
    return []
  }
  const searchableRoots = [
    await getContentRoot(project.path),
    join(project.path, 'purpose.md'),
    join(project.path, 'schema.md'),
    ...(await loadIndexedFiles(project.path)),
  ]
  const files = (await collectFiles(searchableRoots)).filter(
    file => !isIgnoredSearchFile(project.path, file),
  )
  const terms = buildSearchTerms(searchTermSourceForQuery(query))
  const structuredMatches = await collectStructuredFaultMatches(
    project,
    files,
    query,
    terms,
    limit,
  )
  if (isFaultDescriptionLookupQuery(query)) {
    return structuredMatches
  }
  const hasKnownDimensionConstraint = querySpecifiesKnownRecordDimension(query.toLowerCase())
  const emptyStructuredButNameIntent =
    structuredMatches.length === 0 &&
    (hasFaultNameToCodeIntent(query) || isFaultDescriptionLookupQuery(query)) &&
    !isStrictFaultLookupQuery(query)
  if (
    !emptyStructuredButNameIntent &&
    (isFaultCodeQuery(query) ||
      isFaultCodeLookupQuery(query) ||
      isFaultDescriptionLookupQuery(query) ||
      isStrictFaultLookupQuery(query) ||
      (hasKnownDimensionConstraint && isLikelyStructuredFaultQuestion(query)) ||
      (structuredMatches.length > 0 && isLikelyStructuredFaultQuestion(query)) ||
      (structuredMatches.length > 0 && isStrongStructuredSearch(query, terms)))
  ) {
    return structuredMatches
  }

  // Performance optimization: if the query is fault-related and we have structured
  // matches from the index, prefer those over expensive file-based text search.
  // This avoids reading ~100 markdown files on every search.
  if (structuredMatches.length > 0 && isLikelyStructuredFaultQuestion(query)) {
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

function renderTurbineLookupIfNeeded(query: string): string | null {
  if (!shouldAnswerTurbineMappingQuestion(query)) return null
  const turbineId = extractTurbineIdsFromText(query)[0]
  if (!turbineId) return null
  const site = extractSiteFromText(query) ?? undefined
  const entry = lookupTurbineMapping(turbineId, site)
  return entry ? renderTurbineMappingAnswer(entry) : null
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

  const turbineAnswer = renderTurbineLookupIfNeeded(query)
  if (turbineAnswer) return turbineAnswer

  const matches = await collectSearchMatches(project, query, limit)
  if (matches.length === 0) {
    return `No matches for "${query}" in ${project.path}.`
  }

  if (shouldRenderFaultCodeLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderTemperatureFamilyLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderFaultNameLookupAnswer(query, matches)) {
    return renderFaultCodeLookupAnswer(query, matches)
  }
  if (shouldRenderMultiFaultCodeAnswer(query, matches)) {
    return renderMultiFaultCodeAnswer(query, matches)
  }
  if (shouldRenderExactFaultCodeAnswer(query, matches)) {
    return renderExactFaultCodeAnswer(query, matches)
  }

  const primary = matches[0]
  const fields = parseChineseFields(primary.snippet)
  const code = primary.record?.code || faultCodeFromFields(fields)
  const name = cleanFaultName(primary.record?.name || faultNameFromFields(fields))
  const description =
    primary.record?.description ||
    field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象')
  const reason = primary.record?.reason || field(fields, '产生原因', '故障原因', '故障原因分析', '可能原因')
  const solution =
    primary.record?.solution ||
    field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '检修指导', '故障维修策略', '故障排查及处理', '故障现象及处理方法', '解决方案', '检查部位')
  const reset =
    primary.record?.reset ||
    field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3')
  const logic = primary.record?.logic || field(fields, '故障逻辑', '故障触发条件', '触发条件')
  const signal = primary.record?.signal || field(fields, '信号源', '信号部位')
  const delay = primary.record?.delay || field(fields, '设置延迟')
  const program = primary.record?.program || programSummary(fields)
  const site = primary.record?.site || field(fields, '风场')
  const brand = primary.record?.brand || field(fields, '品牌')
  const model = primary.record?.model || field(fields, '机型')
  const standardModel =
    primary.record?.standardModel || field(fields, '映射型号', '具体型号')
  const turbineIds =
    primary.record?.turbineIds ||
    field(fields, '风机编号', '风机号', '机位号', '机组编号', '对应编号', '对应机组', '对应风机')
  const primaryRelatedRecords = primary.record
    ? [primary.record, ...relatedSupplementalMatches(primary, matches).map(match => match.record).filter(isFaultRecord)]
    : []
  const coverageRecords = primaryRelatedRecords.length > 0 ? primaryRelatedRecords : []
  const coverageLines = renderFaultRecordCoverage(coverageRecords, query)

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
    turbineIds ? `风机编号：${formatTurbineIds(turbineIds)}` : '',
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

function shouldRenderMultiFaultCodeAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  if (!isMultiFaultCodeQuestion(query)) return false
  const codes = extractFaultCodes(query)
  return codes.every(code =>
    matches.some(match => match.record && faultCodesEqual(match.record.code, code)),
  )
}

function renderMultiFaultCodeAnswer(
  query: string,
  matches: SearchMatch[],
): string {
  const codes = extractFaultCodes(query)
  const sections: string[] = [
    `## 本地答案：${query}`,
    '',
    `**结论：** 同时查询 ${codes.length} 个故障码：${codes.map(code => formatFaultCodeForAnswer(code)).join('、')}。`,
    '',
  ]
  for (const code of codes) {
    const codeMatches = matches.filter(
      match => match.record && faultCodesEqual(match.record.code, code),
    )
    if (codeMatches.length === 0) {
      sections.push(`### 故障码 ${formatFaultCodeForAnswer(code)}`, '', '未找到匹配记录。', '')
      continue
    }
    const rendered = renderExactFaultCodeAnswer(code, codeMatches)
    const body = rendered
      .replace(/^##[^\n]*\n\n/, '')
      .replace(/^\*\*结论：\*\*[^\n]+\n\n/, '')
    sections.push(`### 故障码 ${formatFaultCodeForAnswer(code)}`, '', body.trim(), '')
  }
  return sections.join('\n')
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
  const aliasMatchedRecords =
    codes.length === 1
      ? matches
          .map(match => match.record)
          .filter(isFaultRecord)
          .filter(record => faultCodesEqual(record.code, codes[0] ?? ''))
      : matches.map(match => match.record).filter(isFaultRecord)
  const literalMatchedRecords = codes.length === 1
    ? aliasMatchedRecords.filter(
        record => faultCodeKey(record.code) === faultCodeKey(codes[0] ?? ''),
      )
    : []
  const exactRecords = literalMatchedRecords.length > 0
    ? literalMatchedRecords
    : aliasMatchedRecords
  const queryLower = query.toLowerCase()
  const filteredExactRecords = filterFaultRecordsBySpecifiedDimension(exactRecords, query)
  const hasDimensionConstraint =
    querySpecifiesKnownRecordDimension(queryLower) ||
    querySpecifiesKnownSiteDimension(queryLower) ||
    querySpecifiesRecordDimension(queryLower, exactRecords)
  const dimensionNoMatch =
    exactRecords.length > 0 &&
    hasDimensionConstraint &&
    filteredExactRecords.length === 0
  if (dimensionNoMatch) {
    return [
      `## 本地答案：${query}`,
      '',
      `**结论：** 故障码 ${formatFaultCodeForAnswer(codes[0] || query)} 未找到与「${describeSpecifiedRecordDimension(query)}」匹配的记录。`,
      '',
      '已按用户指定的风场/品牌/机型/风机编号作为硬约束过滤，未展开其它品牌的同码记录。',
    ].join('\n')
  }
  const records = aggregateFaultRecords(
    hasDimensionConstraint ? filteredExactRecords : exactRecords,
  )
  const scopedGroups = hasDimensionConstraint && shouldLimitWindriseResultsToOne(query)
    ? records.slice(0, 1)
    : records
  const focusedAnswer = renderFocusedExactFaultCodeAnswer(query, scopedGroups)
  if (focusedAnswer) return focusedAnswer
  const exactGroups = scopedGroups
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

function isConvergedWindriseScopeQuery(query: string): boolean {
  const turbineIds = extractTurbineIdsFromText(query)
  const site = extractSiteFromText(query)
  const codes = extractFaultCodes(query)
  if (site && turbineIds.length > 0) return true
  if (codes.length === 1 && (site || turbineIds.length > 0)) return true
  if (site) return true
  if (turbineIds.length > 0) return true
  return false
}

function shouldLimitWindriseResultsToOne(query: string): boolean {
  const turbineIds = extractTurbineIdsFromText(query)
  return turbineIds.length > 0
}

function isFullySpecifiedFaultContextQuery(query: string): boolean {
  const turbineIds = extractTurbineIdsFromText(query)
  const codes = extractFaultCodes(query)
  const site = extractSiteFromText(query)
  return turbineIds.length > 0 && codes.length === 1 && Boolean(site)
}

function renderFocusedExactFaultCodeAnswer(
  query: string,
  groups: FaultRecordGroup[],
): string | null {
  if (!groups.length || !isConvergedWindriseScopeQuery(query)) return null
  const turbineId = extractTurbineIdsFromText(query)[0]
  if (!turbineId && groups.length > 1) return null
  const site = extractSiteFromText(query) ?? undefined
  const entry = turbineId ? lookupTurbineMapping(turbineId, site) : null
  const group = groups[0]
  const code = formatFaultCodeForAnswer(group.code)
  const name = group.name || '未标明'
  const meta = entry
    ? [
        entry.site ? `风场：${entry.site}` : '',
        entry.brand ? `厂家：${entry.brand}` : '',
        entry.model ? `机型：${entry.model}` : '',
        entry.standardModel ? `具体型号：${entry.standardModel}` : '',
        `风机编号：${entry.turbineId}`,
      ]
        .filter(Boolean)
        .join(' / ')
    : [
        site ? `风场：${site}` : '',
        group.brand ? `厂家：${group.brand}` : '',
        group.models[0] ? `机型：${group.models[0]}` : '',
        group.standardModels[0] ? `具体型号：${group.standardModels[0]}` : '',
        turbineId ? `风机编号：${turbineId}` : '',
      ]
        .filter(Boolean)
        .join(' / ')
  const scopeLine = entry
    ? `已按 ${entry.site}风场 ${entry.turbineId} 定位到对应机型记录。`
    : site && turbineId
      ? `已按 ${site}风场 ${turbineId} 收敛到最相关记录。`
      : site
        ? `已按 ${site}风场 过滤，仅展示匹配记录。`
        : turbineId
          ? `已按风机编号 ${turbineId} 过滤，仅展示匹配记录。`
          : `已按故障码 ${code} 过滤，仅展示匹配记录。`
  return [
    `${code} 维修处理建议`,
    scopeLine,
    '',
    `1. **${code}｜${name}**`,
    meta ? `   - ${meta}` : '',
    group.descriptions[0]
      ? `   - 故障描述：${formatFaultTextForAnswer(group.descriptions[0])}`
      : '',
    group.reasons[0] ? `   - 原因：${formatFaultTextForAnswer(group.reasons[0])}` : '',
    group.solutions[0]
      ? `   - 处理：${formatFaultTextForAnswer(group.solutions[0])}`
      : '',
    group.resets[0]
      ? `   - ${resetLabelForFaultRecords(group.records)}：${formatFaultTextForAnswer(group.resets.join('；'))}`
      : '',
    group.locations[0] ? `   - 来源：${group.locations[0]}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function queryHasRecordDimensionHint(query: string): boolean {
  return /(风场|风电场|场站|品牌|厂家|机型|型号|系列|华仪|华锐|金风|歌美飒|运达|明阳|新誉|湘电|远景|三一|中车山东|上海电气|上海电气|团结|洮北|镇赉|镇赍|同发|王玲山|良井子|新华|四平|通榆)/i.test(query)
}

function isFaultCodeCoverageQuestion(query: string): boolean {
  return /(哪些|哪些风场|有哪些|哪些场站|哪些机型|哪些型号|覆盖|分布|也有|都有|所有|全部).*(风场|风电场|场站|机型|型号)|(风场|风电场|场站|机型|型号).*(哪些|有哪些|覆盖|分布|也有|都有|所有|全部)/i.test(query)
}

function describeSpecifiedRecordDimension(query: string): string {
  const turbineIds = extractTurbineIdsFromText(query)
  if (turbineIds.length > 0) {
    return `风机编号 ${turbineIds.join('、')}`
  }
  const codes = extractFaultCodes(query)
  let normalized = query
  for (const code of codes) {
    normalized = normalized.replace(new RegExp(escapeRegExp(code), 'gi'), '')
  }
  normalized = normalized
    .replace(/(故障码|故障代码|报码|告警码|报警码|状态代码|这个代码|这个故障|有哪些|哪些|也有|是什么|查询|查|找|的|为|是)/gi, '')
    .replace(/[？?，,。.、:：\s]+/g, ' ')
    .trim()
  return normalized || '指定风场/机型'
}

function filterFaultRecordsBySpecifiedDimension(
  records: FaultRecord[],
  query: string,
): FaultRecord[] {
  const queryLower = query.toLowerCase()
  const filtered = records.filter(record =>
    faultRecordDimensionMatchesQuery(record, queryLower),
  )
  if (
    querySpecifiesKnownRecordDimension(queryLower) ||
    querySpecifiesKnownSiteDimension(queryLower) ||
    querySpecifiesRecordDimension(queryLower, records)
  ) {
    return filtered
  }
  return filtered.length > 0 ? filtered : records
}

function faultRecordDimensionMatchesQuery(
  record: FaultRecord,
  queryLower: string,
): boolean {
  const site = extractSiteFromText(queryLower) ?? undefined
  const turbineIds = specifiedTurbineIdsFromQuery(queryLower, [record])
  if (turbineIds.size > 0) {
    return [...turbineIds].some(turbineId =>
      recordMatchesMappedTurbineModel(record, turbineId, site),
    )
  }
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
  const queryCodes = extractFaultCodes(query)
  const codesMatchRecords = matches.some(
    match =>
      match.record &&
      queryCodes.some(code => faultCodesEqual(match.record!.code, code)),
  )
  if (
    !isFaultCodeLookupQuery(query) &&
    queryCodes.length > 0 &&
    (codesMatchRecords || !hasFaultNameToCodeIntent(query))
  ) {
    return false
  }
  const candidateRecords = faultNameLookupRecords(query, matches)
  if (candidateRecords.length < 1) return false
  const normalizedQuery = normalizeFaultNameForGrouping(displayFaultLookupText(query))
  if (normalizedQuery.length < faultDescriptionLookupMinLength(query)) return false
  return candidateRecords.some(record =>
    normalizedQuery.includes(normalizeFaultNameForGrouping(record.name)) ||
    normalizeFaultNameForGrouping(record.name).includes(normalizedQuery) ||
    faultRecordLookupNameFields(record).some(value => {
      const normalizedValue = normalizeFaultNameForGrouping(value)
      return (
        normalizedValue.length >= 4 &&
        (normalizedQuery.includes(normalizedValue) ||
          normalizedValue.includes(normalizedQuery))
      )
    }),
  )
}

function shouldRenderTemperatureFamilyLookupAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  const lookup = normalizedLookupWithoutBrand(query)
  if (!/(温度|过热|高温|过温|超温|超限)/.test(lookup)) return false
  const components = temperatureLookupComponents(lookup)
  if (components.length < 2) return false
  const records = faultCodeLookupRecords(query, matches)
  const uniqueCodes = new Set(records.map(record => record.code).filter(Boolean))
  return uniqueCodes.size >= 2
}

function renderFaultCodeLookupAnswer(
  query: string,
  matches: SearchMatch[],
): string {
  const lookupText = displayFaultLookupText(query)
  const lookupRecords = faultCodeLookupRecords(query, matches)
  const records = aggregateFaultRecords(
    lookupRecords.length > 0 ? lookupRecords : faultNameLookupRecords(query, matches),
  )
  const rawRecordCount = records.reduce((sum, group) => sum + group.records.length, 0)
  const coverageCount = new Set(
    records.flatMap(group => renderFaultRecordCoverage(group.records, query)),
  ).size
  const codeCount = new Set(records.flatMap(group => faultCodeAliases(group.code))).size
  const lookupLabel = isFaultDescriptionLookupQuery(query) ? '故障描述' : '名称/描述'

  return [
    `## 本地答案：${query}`,
    '',
    `**结论：** 按${lookupLabel}「${lookupText || query}」在本地知识库中命中 ${rawRecordCount} 条记录，覆盖 ${coverageCount} 组风场/机型，涉及 ${codeCount || records.length} 个故障码。`,
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

function faultNameLookupRecords(
  query: string,
  matches: SearchMatch[],
): FaultRecord[] {
  const records = matches.map(match => match.record).filter(isFaultRecord)
  const normalizedQuery = normalizeFaultNameForGrouping(displayFaultLookupText(query))
  if (normalizedQuery.length < faultDescriptionLookupMinLength(query)) return []
  const seen = new Set<string>()
  const selected: FaultRecord[] = []
  for (const record of records) {
    if (!faultRecordNameMatchesNormalizedLookup(record, normalizedQuery)) continue
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
    selected.push(record)
  }
  return selected
}

function faultRecordNameMatchesNormalizedLookup(
  record: FaultRecord,
  normalizedQuery: string,
): boolean {
  const normalizedName = normalizeFaultNameForGrouping(record.name)
  return (
    normalizedQuery.includes(normalizedName) ||
    normalizedName.includes(normalizedQuery) ||
    faultRecordLookupNameFields(record).some(value => {
      const normalizedValue = normalizeFaultNameForGrouping(value)
      return (
        normalizedValue.length >= 4 &&
        (normalizedQuery.includes(normalizedValue) ||
          normalizedValue.includes(normalizedQuery))
      )
    })
  )
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
        record.turbineIds ? `风机编号：${formatTurbineIds(record.turbineIds)}` : '',
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

function formatTurbineIds(value: string, max = 8): string {
  const raw = String(value ?? '').trim()
  if (!raw) return raw
  const ids = raw
    .split(/[、,，]/u)
    .map(item => item.trim())
    .filter(Boolean)
  if (ids.length <= max) return raw
  return `${ids.slice(0, max).join('、')}…等共 ${ids.length} 台`
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
  return normalizeFaultVariantText(cleanFaultName(value))
    .replace(/([123])#/g, '$1号')
    .replace(/([123])＃/g, '$1号')
    .replace(/\s+/g, '')
}

function normalizeFaultVariantText(value: string): string {
  return String(value || '')
    .replace(/[揽榄]/g, '缆')
    .replace(/纽缆/g, '扭缆')
    .replace(/纽揽/g, '扭缆')
    .replace(/纽榄/g, '扭缆')
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
    '刹车号',
    '编号',
    '英文名称',
    '报警',
    '序号',
    '解释',
  ]
  const positions = keys
    .map(key => ({ key, index: value.indexOf(`${key}：`) }))
    .filter(item => {
      if (item.index < 0) return false
      if (item.index === 0) return true
      return /[\s，,；;。]/u.test(value[item.index - 1] ?? '')
    })
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
  if (isNonFaultMeasurementOrRatingQuestion(query)) {
    return []
  }
  const faultQuery = normalizeFaultCodeQuery(query)
  const coreFaultNameQuery = extractCoreFaultNameQuery(query)
  const structuredQuery = coreFaultNameQuery || query
  const structuredTerms = coreFaultNameQuery ? buildSearchTerms(coreFaultNameQuery) : terms
  let queryCodes = coreFaultNameQuery
    ? []
    : isFaultCodeQuery(faultQuery)
      ? extractFaultCodes(faultQuery)
      : []
  if (isTurbineFaultDescriptionQuery(query)) {
    queryCodes = []
  }
  const records = await loadFaultRecords(project, files)
  const queryLower = structuredQuery.toLowerCase()
  const hasDimensionConstraint =
    querySpecifiesKnownRecordDimension(queryLower) ||
    querySpecifiesKnownSiteDimension(queryLower) ||
    querySpecifiesRecordDimension(queryLower, records)
  const exactQueryCodeKeys = new Set(
    queryCodes
      .filter(code =>
        records.some(record => faultCodeKey(record.code) === faultCodeKey(code)),
      )
      .map(faultCodeKey),
  )
  const directExactCodeCandidates =
    queryCodes.length > 0
      ? records
          .filter(record => queryCodes.some(code => {
            const codeKey = faultCodeKey(code)
            return exactQueryCodeKeys.has(codeKey)
              ? faultCodeKey(record.code) === codeKey
              : faultCodesEqual(record.code, code)
          }))
          .map(record => ({
            record,
            score: 50000 + scoreFaultRecord(record, queryLower, queryCodes, structuredTerms),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.record.location.localeCompare(b.record.location),
          )
      : []
  if (
    directExactCodeCandidates.length > 0 &&
    !hasDimensionConstraint &&
    (isBareCodeQuery(faultQuery) ||
      isExplicitLeadingFaultCodeQuestion(faultQuery) ||
      isEmbeddedFaultCodeQuestion(query) ||
      isMultiFaultCodeQuestion(query) ||
      /(故障码|故障代码|报警码|告警码|报码|状态代码|fault\s*code)/i.test(faultQuery))
  ) {
    return directExactCodeCandidates
      .map(candidate => ({
        score: candidate.score,
        location: candidate.record.location,
        snippet: renderFaultRecordSnippet(candidate.record),
        record: candidate.record,
      }))
  }
  if (
    directExactCodeCandidates.length > 0 &&
    hasDimensionConstraint &&
    (isDimensionQualifiedFaultCodeQuery(faultQuery) ||
      isMultiFaultCodeQuestion(query) ||
      (isTurbineQualifiedFaultCodeQuery(faultQuery) && !isTurbineFaultDescriptionQuery(query)))
  ) {
    const dimensionCandidates = filterCandidatesBySpecifiedDimensions(
      directExactCodeCandidates,
      queryLower,
      records,
    )
    return (dimensionCandidates.length > 0 ? dimensionCandidates : directExactCodeCandidates)
      .map(candidate => ({
        score: candidate.score,
        location: candidate.record.location,
        snippet: renderFaultRecordSnippet(candidate.record),
        record: candidate.record,
      }))
  }
  if (
    queryCodes.length > 0 &&
    !isExplicitLeadingFaultCodeQuestion(faultQuery) &&
    !isDimensionQualifiedFaultCodeQuery(faultQuery) &&
    !(isTurbineQualifiedFaultCodeQuery(faultQuery) && !isTurbineFaultDescriptionQuery(faultQuery)) &&
    !isEmbeddedFaultCodeQuestion(query) &&
    !isMultiFaultCodeQuestion(query)
  ) {
    queryCodes = []
  }
  const compactNameLookup = compactFaultLookupText(
    coreFaultNameQuery ||
      displayFaultLookupText(structuredQuery) ||
      normalizeFaultCodeLookupQuery(structuredQuery),
  )
  const directExactNameCandidates =
    queryCodes.length === 0 &&
    compactNameLookup.length >= 4 &&
    isLikelyStructuredFaultQuestion(query)
      ? records
          .filter(record =>
            faultRecordLookupNameFields(record)
              .map(compactFaultLookupText)
              .some(name => name === compactNameLookup),
          )
          .map(record => ({
            record,
            score: 48000 + scoreFaultRecord(record, queryLower, [], structuredTerms),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.record.location.localeCompare(b.record.location),
          )
      : []
  if (directExactNameCandidates.length > 0) {
    return directExactNameCandidates.map(candidate => ({
      score: candidate.score,
      location: candidate.record.location,
      snippet: renderFaultRecordSnippet(candidate.record),
      record: candidate.record,
    }))
  }
  if (
    compactNameLookup.length >= 4 &&
    !isExplicitLeadingFaultCodeQuestion(structuredQuery) &&
    /(是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|有什么故障码|会报哪些码|会报什么码|会出啥码|会出什么码|报哪些码|报啥码|报什么码|报啥|报什么|(?:^|\s)啥码(?:\s|$))/i.test(query)
  ) {
    const directNameCandidates = records
      .filter(record =>
        faultRecordLookupNameFields(record)
          .map(compactFaultLookupText)
          .some(name => name === compactNameLookup || name.includes(compactNameLookup) || compactNameLookup.includes(name)),
      )
      .map(record => ({
        record,
        score: 45000 + scoreFaultRecord(record, queryLower, [], structuredTerms),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.record.location.localeCompare(b.record.location),
      )
    if (directNameCandidates.length > 0) {
      return directNameCandidates.map(candidate => ({
        score: candidate.score,
        location: candidate.record.location,
        snippet: renderFaultRecordSnippet(candidate.record),
        record: candidate.record,
      }))
    }
  }
  if (
    queryCodes.length > 0 &&
    directExactCodeCandidates.length === 0 &&
    (!isExplicitLeadingFaultCodeQuestion(structuredQuery) ||
      hasFaultNameToCodeIntent(structuredQuery))
  ) {
    queryCodes = []
  }
  if (
    isStrictFaultLookupQuery(structuredQuery) &&
    queryCodes.length === 0 &&
    !records.some(record => faultRecordExactNameMatchesLookupQuery(record, structuredQuery))
  ) {
    return []
  }
  if (
    queryCodes.length > 0 &&
    !isBareCodeQuery(structuredQuery) &&
    !/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(structuredQuery) &&
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
  const faultCodeLookupExactNameMatches = shouldKeepAllFaultCodeLookupMatches
    ? records.filter(record => faultRecordExactNameMatchesLookupQuery(record, query))
    : []
  const faultCodeLookupNameMatches = shouldKeepAllFaultCodeLookupMatches
    ? (
        isFaultDescriptionLookupQuery(query)
          ? records.filter(record => faultRecordNameMatchesLookupQuery(record, query))
          : faultCodeLookupExactNameMatches.length > 0
            ? faultCodeLookupExactNameMatches
            : records.filter(record => faultRecordNameMatchesLookupQuery(record, query))
      )
    : []
  if (
    shouldKeepAllFaultCodeLookupMatches &&
    isStrictFaultLookupQuery(query) &&
    faultCodeLookupExactNameMatches.length === 0 &&
    faultCodeLookupNameMatches.length === 0
  ) {
    return []
  }
  const shouldKeepAllFaultNameLookupMatches =
    queryCodes.length === 0 &&
    !shouldKeepAllFaultCodeLookupMatches &&
    normalizeFaultCodeLookupQuery(structuredQuery).length >= 4 &&
    records.some(record => faultRecordNameMatchesLookupQuery(record, structuredQuery))
  const faultNameLookupNameMatches = shouldKeepAllFaultNameLookupMatches
    ? records.filter(record => faultRecordNameMatchesLookupQuery(record, structuredQuery))
    : []
  const faultNameLookupExactNameMatches = shouldKeepAllFaultNameLookupMatches
    ? records.filter(record => faultRecordExactNameMatchesLookupQuery(record, structuredQuery))
    : []
  if (
    shouldKeepAllFaultNameLookupMatches &&
    isStrictFaultLookupQuery(structuredQuery) &&
    faultNameLookupExactNameMatches.length === 0 &&
    faultNameLookupNameMatches.length === 0
  ) {
    return []
  }
  const lookupSourceRecords = shouldKeepAllFaultCodeLookupMatches
    ? (
        isFaultDescriptionLookupQuery(query)
          ? faultCodeLookupNameMatches.length > 0
            ? faultCodeLookupNameMatches
            : records
          : faultCodeLookupExactNameMatches.length > 0
            ? faultCodeLookupExactNameMatches
            : faultCodeLookupNameMatches.length > 0
              ? faultCodeLookupNameMatches
              : records
      )
    : shouldKeepAllFaultNameLookupMatches && faultNameLookupExactNameMatches.length > 0
      ? faultNameLookupExactNameMatches
      : shouldKeepAllFaultNameLookupMatches && faultNameLookupNameMatches.length > 0
        ? faultNameLookupNameMatches
        : records


  const scoredCandidates = (shouldKeepAllFaultCodeLookupMatches || shouldKeepAllFaultNameLookupMatches
    ? lookupSourceRecords
        .filter(record => faultRecordMatchesLookupQuery(record, query))
        .map(record => ({
          record,
          score: Math.max(
            scoreFaultRecord(record, queryLower, queryCodes, structuredTerms),
            faultRecordExactNameMatchesLookupQuery(record, structuredQuery)
              ? 30000
              : faultRecordNameMatchesLookupQuery(record, structuredQuery)
                ? 22000
                : 9000,
          ),
        }))
    : records.map(record => ({
        record,
        score: scoreFaultRecord(record, queryLower, queryCodes, structuredTerms),
      })))
    .filter(candidate => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.location.localeCompare(b.record.location),
    )
  const dimensionFilteredCandidates = hasDimensionConstraint
    ? filterCandidatesBySpecifiedDimensions(scoredCandidates, queryLower, records)
    : scoredCandidates
  const strictlyMatchedDimensionCandidates =
    hasDimensionConstraint &&
    queryCodes.length === 0 &&
    isLikelyStructuredFaultQuestion(structuredQuery) &&
    !isTurbineFaultDescriptionQuery(query)
      ? filterCandidatesByFaultSubject(dimensionFilteredCandidates, structuredQuery, records)
      : dimensionFilteredCandidates
  const fuzzyCandidates =
    queryCodes.length === 0 && isLikelyStructuredFaultQuestion(structuredQuery)
      ? buildFuzzyFaultCandidates(
          records,
          structuredQuery,
          hasDimensionConstraint,
          scoredCandidates,
        )
      : []
  const exactCodeCandidates =
    queryCodes.length > 0
      ? scoredCandidates.filter(candidate =>
          queryCodes.some(code => faultCodesEqual(candidate.record.code, code)),
        )
      : []
  const dimensionFilteredExactCodeCandidates =
    exactCodeCandidates.length > 0 && hasDimensionConstraint
      ? filterCandidatesBySpecifiedDimensions(exactCodeCandidates, queryLower, records)
      : exactCodeCandidates
  let candidates: Array<{ record: FaultRecord; score: number }>
  if (exactCodeCandidates.length > 0) {
    candidates = hasDimensionConstraint
      ? dimensionFilteredExactCodeCandidates
      : exactCodeCandidates
  } else if (strictlyMatchedDimensionCandidates.length > 0) {
    candidates = mergeFaultCandidates(strictlyMatchedDimensionCandidates, fuzzyCandidates)
  } else if (hasDimensionConstraint) {
    candidates = fuzzyCandidates
  } else {
    candidates = mergeFaultCandidates(scoredCandidates, fuzzyCandidates)
  }

  const selectedCandidates = shouldKeepAllExactCodeMatches
    ? candidates.filter(candidate =>
        faultCodesEqual(candidate.record.code, queryCodes[0] ?? ''),
      )
    : shouldKeepAllFaultCodeLookupMatches || shouldKeepAllFaultNameLookupMatches
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

function isStrongStructuredSearch(query: string, terms: SearchTerm[]): boolean {
  const queryText = normalizeFaultSubjectText(searchTermSourceForQuery(query))
  if (queryText.length < 4) return false
  const strongTerms = componentSearchTerms(
    terms.filter(term => !term.weak && !term.numeric),
  ).filter(term => !GENERIC_FAULT_SEARCH_TERMS.has(term.value))
  if (strongTerms.length >= 2) return true
  const strippedTerms = componentSearchTerms(
    terms
      .filter(term => !term.weak)
      .map(term => ({
        ...term,
        value: stripLookupContextTerms(normalizeFaultSubjectText(term.value)),
      }))
      .filter(term => term.value.length >= 2 && !GENERIC_FAULT_SEARCH_TERMS.has(term.value)),
  )
  return strippedTerms.length >= 2
}

function querySpecifiesRecordDimension(
  queryLower: string,
  records: FaultRecord[],
): boolean {
  const dimensionQuery = dimensionQueryWithoutFaultCodes(queryLower)
  if (extractTurbineIdsFromText(dimensionQuery, collectTurbineIdsFromRecords(records)).length > 0) {
    return true
  }
  return records.some(record =>
    [...splitSiteLabels(record.site), record.brand, record.model, record.standardModel]
      .filter(Boolean)
      .some(value => dimensionValueStrictlyMatchesQuery(value, dimensionQuery)),
  )
}

function filterCandidatesBySpecifiedDimensions<T extends { record: FaultRecord }>(
  candidates: T[],
  queryLower: string,
  records: FaultRecord[],
): T[] {
  const specified = specifiedRecordDimensions(queryLower, records)
  const specifiedBrands = specifiedKnownBrands(queryLower)
  const specifiedTurbineIds = specifiedTurbineIdsFromQuery(queryLower, records)
  if (
    specified.sites.size === 0 &&
    specified.brands.size === 0 &&
    specifiedBrands.size === 0 &&
    specified.models.size === 0 &&
    specifiedTurbineIds.size === 0
  ) {
    return candidates
  }

  return candidates.filter(candidate => {
    const record = candidate.record
    const site = extractSiteFromText(queryLower) ?? undefined
    if (
      specifiedTurbineIds.size > 0 &&
      ![...specifiedTurbineIds].some(turbineId =>
        recordMatchesMappedTurbineModel(record, turbineId, site),
      )
    ) {
      return false
    }
    if (
      specified.sites.size > 0 &&
      !splitSiteLabels(record.site).some(site => specified.sites.has(normalizeSiteLabel(site)))
    ) {
      return false
    }
    if (
      (specified.brands.size > 0 || specifiedBrands.size > 0) &&
      !specified.brands.has(record.brand) &&
      !specifiedBrands.has(record.brand)
    ) {
      return false
    }
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

function filterCandidatesByFaultSubject<T extends { record: FaultRecord }>(
  candidates: T[],
  query: string,
  records: FaultRecord[],
): T[] {
  const specified = specifiedRecordDimensions(query.toLowerCase(), records)
  let subject = normalizeFaultSearchPhrase(query.toLowerCase())
  for (const value of [
    ...specified.sites,
    ...specified.brands,
    ...specified.models,
  ]) {
    subject = subject.replaceAll(normalizeDimensionText(value), '')
  }
  subject = subject
    .replace(/(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因|是否存在|存在|出现|发生)/gi, '')
    .replace(/(风机|机组|品牌|厂家|机型|型号|系列)/gi, '')
    .replace(/[？?，,。.、:：；;/\s]/g, '')
    .trim()
  for (const turbineId of extractTurbineIdsFromText(query)) {
    subject = subject.replaceAll(normalizeDimensionText(turbineId), '')
    subject = subject.replaceAll(
      normalizeDimensionText(turbineId.replace(/#$/, '')),
      '',
    )
  }
  subject = subject.replace(/(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])/gi, '').trim()

  if (subject.length < 2) return candidates
  if (subject.length < 4 && isTurbineFaultDescriptionQuery(query)) return candidates

  return candidates.filter(candidate => {
    const record = candidate.record
    const primaryText = [
      record.name,
      record.description,
      record.reason,
      record.solution,
      record.logic,
      record.signal,
      record.program,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (faultSubjectMatchesText(primaryText, subject)) return true
    if (corePhraseMatches(primaryText, subject)) return true
    const terms = buildSearchTerms(subject).filter(term => !term.weak && !term.numeric)
    const strongTerms = componentSearchTerms(terms)
    return strongTerms.length > 0 && strongTerms.every(term => termMatches(primaryText, term))
  })
}

function buildFuzzyFaultCandidates(
  records: FaultRecord[],
  query: string,
  hasDimensionConstraint: boolean,
  existingCandidates: Array<{ record: FaultRecord; score: number }>,
): Array<{ record: FaultRecord; score: number }> {
  const queryLower = query.toLowerCase()
  const queryFeatures = extractFaultFeatures(queryLower)
  if (queryFeatures.components.size === 0 && queryFeatures.symptoms.size === 0) {
    return []
  }

  const existingRecords = new Set(existingCandidates.map(candidate => candidate.record))
  const candidateRecords = hasDimensionConstraint
    ? filterCandidatesBySpecifiedDimensions(
        records.map(record => ({ record, score: 0 })),
        queryLower,
        records,
      ).map(candidate => candidate.record)
    : records

  return candidateRecords
    .filter(record => !existingRecords.has(record))
    .map(record => {
      const text = faultRecordPrimaryText(record)
      const recordFeatures = extractFaultFeatures(text)
      const componentOverlap = setIntersectionSize(queryFeatures.components, recordFeatures.components)
      const symptomOverlap = setIntersectionSize(queryFeatures.symptoms, recordFeatures.symptoms)

      if (queryFeatures.components.size > 0 && componentOverlap === 0) {
        return { record, score: 0 }
      }
      if (queryFeatures.symptoms.size > 0 && symptomOverlap === 0) {
        return { record, score: 0 }
      }
      if (
        queryFeatures.symptoms.size > 0 &&
        recordFeatures.symptoms.size === 0
      ) {
        return { record, score: 0 }
      }

      let score = 0
      score += componentOverlap * 2600
      score += symptomOverlap * 3600
      if (faultSubjectMatchesText(text, queryLower)) score += 6000
      if (queryFeatures.components.size > 0 && componentOverlap === queryFeatures.components.size) {
        score += 1200
      }
      if (queryFeatures.symptoms.size > 0 && symptomOverlap === queryFeatures.symptoms.size) {
        score += 1800
      }
      return { record, score }
    })
    .filter(candidate => candidate.score >= 3600)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.location.localeCompare(b.record.location),
    )
}

function mergeFaultCandidates<T extends { record: FaultRecord; score: number }>(
  primary: T[],
  fuzzy: T[],
): T[] {
  if (fuzzy.length === 0) return primary
  const byRecordKey = new Map<string, T>()
  for (const candidate of [...primary, ...fuzzy]) {
    const key = faultRecordUniqueKey(candidate.record)
    const current = byRecordKey.get(key)
    if (!current || candidate.score > current.score) {
      byRecordKey.set(key, candidate)
    }
  }
  return [...byRecordKey.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.record.location.localeCompare(b.record.location),
  )
}

function faultRecordUniqueKey(record: FaultRecord): string {
  return [
    record.code,
    record.name,
    record.site,
    record.brand,
    record.model,
    record.standardModel,
    record.location,
  ].join('|')
}

function faultRecordPrimaryText(record: FaultRecord): string {
  return [
    record.name,
    record.description,
    record.reason,
    record.solution,
    record.logic,
    record.signal,
    record.program,
    record.system,
    record.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function extractFaultFeatures(value: string): FaultFeatureSet {
  const text = normalizeFaultSubjectText(value)
  const components = new Set<string>()
  const symptoms = new Set<string>()

  const componentPatterns: Array<[string, RegExp]> = [
    ['发电机', /发电机/],
    ['轴承', /轴承|轴温/],
    ['变流器', /变流器|变频器|converter/],
    ['主断路器', /主断路器|主断|断路器|空开|mcb|qf|q10/],
    ['变桨', /变桨|桨叶|桨柜|pitch/],
    ['偏航', /偏航|yaw/],
    ['齿轮箱', /齿轮箱|增速箱|gearbox/],
    ['液压', /液压|油压|压力/],
    ['制动', /制动|刹车|brake/],
    ['温度传感器', /温度传感器|pt100|测温/],
    ['通信', /通信|通讯|can|profibus|ethercat|modbus/],
    ['电网', /电网|电压|电流|频率|grid/],
  ]
  const symptomPatterns: Array<[string, RegExp]> = [
    ['温度高', /温度高|温升|发热|热|超限|越限|过高|高温|超温|过温/],
    ['温度低', /温度低|过低|低温/],
    ['跳闸', /跳闸|跳开|断开|脱扣|分闸/],
    ['短路', /短路/],
    ['接地', /接地|绝缘/],
    ['过流', /过流|电流高|电流过大|过载/],
    ['过压', /过压|电压高|电压过高/],
    ['欠压', /欠压|低电压|电压低|电压过低/],
    ['通信异常', /通信异常|通讯异常|通信故障|通讯故障|丢失|超时|中断|无响应/],
    ['传感器异常', /传感器.*(?:异常|故障|断线|短路)|(?:异常|故障|断线|短路).*传感器|pt100.*(?:异常|故障|断线|短路)/],
    ['振动', /振动|震动|异响|噪声|磨损/],
    ['压力低', /压力低|低压|油压低/],
    ['压力高', /压力高|高压|油压高/],
    ['复位失败', /复位失败|不能复位|无法复位/],
  ]

  for (const [label, pattern] of componentPatterns) {
    if (pattern.test(text)) components.add(label)
  }
  for (const [label, pattern] of symptomPatterns) {
    if (pattern.test(text)) symptoms.add(label)
  }
  if (components.has('发电机') && symptoms.has('温度高')) {
    components.add('发电机温度')
  }
  if (components.has('轴承') && symptoms.has('温度高')) {
    components.add('轴承温度')
  }
  return { components, symptoms }
}

function setIntersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const value of left) {
    if (right.has(value)) count++
  }
  return count
}

function specifiedRecordDimensions(
  queryLower: string,
  records: FaultRecord[],
): { sites: Set<string>; brands: Set<string>; models: Set<string> } {
  const dimensionQuery = dimensionQueryWithoutFaultCodes(queryLower)
  const specified = {
    sites: specifiedDimensionValues(
      dimensionQuery,
      records.flatMap(record => splitSiteLabels(record.site)),
      normalizeSiteLabel,
    ),
    brands: specifiedDimensionValues(dimensionQuery, records.map(record => record.brand)),
    models: specifiedDimensionValues(dimensionQuery, [
      ...records.map(record => record.model),
      ...records.map(record => record.standardModel),
    ]),
  }
  enrichSpecifiedDimensionsFromTurbineMapping(specified, queryLower)
  return specified
}

function enrichSpecifiedDimensionsFromTurbineMapping(
  specified: { sites: Set<string>; brands: Set<string>; models: Set<string> },
  queryLower: string,
): void {
  const entry = resolveTurbineContextFromQuery(queryLower)
  if (!entry) return
  specified.sites.add(normalizeSiteLabel(entry.site))
  specified.brands.add(entry.brand)
  if (entry.model) specified.models.add(normalizeModelName(entry.model))
  if (entry.standardModel) specified.models.add(normalizeModelName(entry.standardModel))
}

function querySpecifiesKnownRecordDimension(queryLower: string): boolean {
  return (
    specifiedKnownBrands(dimensionQueryWithoutFaultCodes(queryLower)).size > 0 ||
    extractTurbineIdsFromText(dimensionQueryWithoutFaultCodes(queryLower)).length > 0
  )
}

function querySpecifiesKnownSiteDimension(queryLower: string): boolean {
  const normalizedQuery = normalizeDimensionText(dimensionQueryWithoutFaultCodes(queryLower))
  return KNOWN_FAULT_SITES.some(site =>
    normalizedQuery.includes(normalizeDimensionText(site)),
  )
}

function specifiedKnownBrands(queryLower: string): Set<string> {
  const normalizedQuery = normalizeDimensionText(dimensionQueryWithoutFaultCodes(queryLower))
  const specified = new Set<string>()
  for (const brand of KNOWN_FAULT_BRANDS) {
    if (normalizedQuery.includes(normalizeDimensionText(brand))) {
      specified.add(brand)
    }
  }
  return specified
}

function dimensionQueryWithoutFaultCodes(query: string): string {
  let stripped = String(query || '')
  const turbineIds = new Set(
    extractTurbineIdsFromText(stripped).map(id => id.toUpperCase()),
  )
  for (const code of extractFaultCodes(stripped)) {
    if (!code) continue
    const normalizedCode = cleanFaultCode(code).toUpperCase()
    if (
      turbineIds.has(normalizedCode) ||
      [...turbineIds].some(id => id.replace(/#$/, '') === normalizedCode)
    ) {
      continue
    }
    if (new RegExp(`${escapeRegExp(code)}(?=号)`, 'i').test(stripped)) {
      continue
    }
    stripped = stripped.replace(new RegExp(escapeRegExp(code), 'gi'), ' ')
  }
  return stripped
}

function collectTurbineIdsFromRecords(records: FaultRecord[]): string[] {
  const ids = new Set<string>()
  for (const record of records) {
    for (const turbineId of splitTurbineIds(record.turbineIds)) {
      ids.add(turbineId)
    }
  }
  return [...ids]
}

function specifiedTurbineIdsFromQuery(
  queryLower: string,
  records: FaultRecord[],
): Set<string> {
  return new Set(
    extractTurbineIdsFromText(
      dimensionQueryWithoutFaultCodes(queryLower),
      collectTurbineIdsFromRecords(records),
    ),
  )
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
    if (/^[a-z]$/i.test(token)) continue
    if (/^\d+$/.test(token) && token.length < 3) continue
    if (/^[a-z0-9]+$/i.test(token) && token.length < 3) continue
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

// Cache for loadFaultRecords to avoid repeated file existence checks
// and stale file detection on every search. Keyed by project path + index mtime.
type FaultRecordsCacheEntry = {
  projectPath: string
  indexMtimeMs: number
  records: FaultRecord[]
}
let faultRecordsCache: FaultRecordsCacheEntry | null = null

async function loadFaultRecords(
  project: LLMWikiProject,
  files: string[],
): Promise<FaultRecord[]> {
  const indexState = await loadFaultIndexState(project.path)
  if (indexState.records.length === 0) {
    return scanFaultRecordsFromFiles(project, files)
  }

  // Check if cached records are still valid (same project, same index mtime).
  if (
    faultRecordsCache &&
    faultRecordsCache.projectPath === project.path &&
    faultRecordsCache.indexMtimeMs === indexState.indexMtimeMs
  ) {
    return faultRecordsCache.records
  }

  const liveRecords = await dropRecordsFromMissingSources(indexState)
  const staleFiles = await findStaleKnowledgeFiles(
    project.path,
    files,
    indexState.indexMtimeMs,
  )
  if (staleFiles.length === 0) {
    faultRecordsCache = {
      projectPath: project.path,
      indexMtimeMs: indexState.indexMtimeMs,
      records: liveRecords,
    }
    return liveRecords
  }

  const stalePaths = new Set(
    staleFiles.map(filePath => relative(project.path, filePath)),
  )
  const kept = liveRecords.filter(
    record => !stalePaths.has(sourcePathOfLocation(record.location)),
  )
  const rescanned = await scanFaultRecordsFromFiles(project, staleFiles)
  const finalRecords = [...kept, ...rescanned]

  faultRecordsCache = {
    projectPath: project.path,
    indexMtimeMs: indexState.indexMtimeMs,
    records: finalRecords,
  }
  return finalRecords
}

type FaultIndexState = {
  records: FaultRecord[]
  indexRoot: string
  indexMtimeMs: number
}

async function loadFaultIndexState(
  projectPath: string,
): Promise<FaultIndexState> {
  const localIndexPath = join(projectPath, FAULT_INDEX_FILE)
  const sourceIndexPath = await configuredFaultIndexSourcePath(projectPath)
  const localMtimeMs = await fileMtimeMs(localIndexPath)
  const sourceMtimeMs = sourceIndexPath
    ? await fileMtimeMs(sourceIndexPath)
    : 0
  const indexPath =
    sourceIndexPath && sourceMtimeMs > localMtimeMs
      ? sourceIndexPath
      : localIndexPath

  return {
    records: await loadFaultIndex(indexPath),
    indexRoot: sourceIndexPath ? dirname(sourceIndexPath) : projectPath,
    indexMtimeMs: Math.max(localMtimeMs, sourceMtimeMs),
  }
}

async function configuredFaultIndexSourcePath(
  projectPath: string,
): Promise<string | null> {
  let raw = ''
  try {
    raw = await readFile(join(projectPath, INDEX_SOURCE_PATH), 'utf8')
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as { indexPath?: unknown }
    if (typeof parsed.indexPath !== 'string' || !parsed.indexPath) return null
    const indexPath = resolve(projectPath, parsed.indexPath)
    return (await exists(indexPath)) ? indexPath : null
  } catch {
    return null
  }
}

async function fileMtimeMs(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return 0
  }
}

async function dropRecordsFromMissingSources(
  indexState: FaultIndexState,
): Promise<FaultRecord[]> {
  if (!indexState.indexRoot || !(await exists(indexState.indexRoot))) {
    return indexState.records
  }

  const presentByPath = new Map<string, boolean>()
  const output: FaultRecord[] = []
  for (const record of indexState.records) {
    const sourcePath = sourcePathOfLocation(record.location)
    let present = presentByPath.get(sourcePath)
    if (present === undefined) {
      present = await exists(join(indexState.indexRoot, sourcePath))
      presentByPath.set(sourcePath, present)
    }
    if (present) output.push(record)
  }
  return output
}

function sourcePathOfLocation(location: string): string {
  return location.replace(/:\d+$/, '')
}

async function findStaleKnowledgeFiles(
  projectPath: string,
  files: string[],
  indexMtimeMs: number,
): Promise<string[]> {
  if (indexMtimeMs <= 0) return []

  const snapshot = await loadSnapshotFileEntries(projectPath)
  const stale: string[] = []
  for (const filePath of files.slice(0, MAX_SEARCH_FILES)) {
    if (!/\.md$/i.test(filePath)) continue
    let info
    try {
      info = await stat(filePath)
    } catch {
      continue
    }
    if (info.mtimeMs <= indexMtimeMs) continue
    if (snapshot) {
      const entry = snapshot.get(relative(projectPath, filePath))
      if (
        entry &&
        entry.size === info.size &&
        entry.sha1 === (await sha1File(filePath))
      ) {
        continue
      }
    }
    stale.push(filePath)
  }
  return stale
}

async function loadSnapshotFileEntries(
  projectPath: string,
): Promise<Map<string, { size: number; sha1: string }> | null> {
  let snapshot: FileSnapshot
  try {
    snapshot = JSON.parse(
      await readFile(join(projectPath, SNAPSHOT_PATH), 'utf8'),
    ) as FileSnapshot
  } catch {
    return null
  }

  const entries = new Map<string, { size: number; sha1: string }>()
  for (const [path, value] of Object.entries(snapshot.files ?? {})) {
    if (!value || typeof value !== 'object') continue
    const { size, sha1 } = value as { size?: unknown; sha1?: unknown }
    if (typeof size !== 'number' || typeof sha1 !== 'string') continue
    entries.set(path, { size, sha1 })
  }
  return entries.size > 0 ? entries : null
}

async function sha1File(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath)
    return createHash('sha1').update(content).digest('hex')
  } catch {
    return ''
  }
}

async function scanFaultRecordsFromFiles(
  project: LLMWikiProject,
  files: string[],
): Promise<FaultRecord[]> {
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
        turbineIds: field(fields, '风机编号', '风机号', '机位号', '机组编号', '对应编号', '对应机组', '对应风机'),
        description: field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象'),
        reason: field(fields, '产生原因', '故障原因', '故障原因分析', '可能原因'),
        solution: field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '检修指导', '故障维修策略', '故障排查及处理', '故障现象及处理方法', '解决方案', '检查部位'),
        reset: field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
        logic: field(fields, '故障逻辑', '故障触发条件', '触发条件'),
        signal: field(fields, '信号源', '信号部位'),
        delay: field(fields, '设置延迟'),
        program: programSummary(fields),
        yawProgram: field(fields, '偏航程序'),
        brakeProgram: field(fields, '制动程序'),
        alarmProgram: field(fields, '报警程序'),
        resetDelay: field(fields, '复位延迟'),
        resetProgram: field(fields, '复位程序'),
        system: field(fields, '系统', '部件'),
        category: field(fields, '故障分类', '故障类型', '故障类别', '故障属性', 'SYJX（故障属性）', '分类'),
        location: `${relPath}:${index + 1}`,
        text: trimmed,
      })
    })
  }

  return records
}

// In-memory cache for the parsed fault index.
// Keyed by (indexPath, mtime) — the file is only read and parsed once per
// process, and automatically reloaded if the file changes on disk.
type FaultIndexCacheEntry = {
  path: string
  mtimeMs: number
  records: FaultRecord[]
}
let faultIndexCache: FaultIndexCacheEntry | null = null

async function loadFaultIndex(indexPath: string): Promise<FaultRecord[]> {
  // Check if cached entry is still valid.
  const currentMtime = await fileMtimeMs(indexPath)
  if (
    faultIndexCache &&
    faultIndexCache.path === indexPath &&
    faultIndexCache.mtimeMs === currentMtime &&
    currentMtime > 0
  ) {
    return faultIndexCache.records
  }

  let content = ''
  try {
    content = await readFile(indexPath, 'utf8')
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

  faultIndexCache = { path: indexPath, mtimeMs: currentMtime, records }
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
    turbineIds:
      stringField(raw.turbineIds) ||
      field(fields, '风机编号', '风机号', '机位号', '机组编号', '对应编号', '对应机组', '对应风机'),
    description:
      stringField(raw.description) ||
      field(fields, '故障描述', '故障描述/现象', '描述', '中文描述', '故障现象'),
    reason: stringField(raw.reason) || field(fields, '产生原因', '故障原因', '故障原因分析', '可能原因'),
    solution:
      stringField(raw.solution) ||
      field(fields, '排查操作步骤', '故障处理', '故障处理方法', '故障处理指导', '检修指导', '故障维修策略', '故障排查及处理', '故障现象及处理方法', '解决方案', '检查部位'),
    reset:
      stringField(raw.reset) ||
      field(fields, '触发和复位条件', '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
    logic: stringField(raw.logic) || field(fields, '故障逻辑', '故障触发条件', '触发条件'),
    signal: stringField(raw.signal) || field(fields, '信号源', '信号部位'),
    delay: stringField(raw.delay) || field(fields, '设置延迟'),
    program: stringField(raw.program) || programSummary(fields),
    yawProgram: stringField(raw.yawProgram) || field(fields, '偏航程序'),
    brakeProgram: stringField(raw.brakeProgram) || field(fields, '制动程序'),
    alarmProgram: stringField(raw.alarmProgram) || field(fields, '报警程序'),
    resetDelay: stringField(raw.resetDelay) || field(fields, '复位延迟'),
    resetProgram: stringField(raw.resetProgram) || field(fields, '复位程序'),
    system: stringField(raw.system) || field(fields, '系统', '部件'),
    category:
      stringField(raw.category) ||
      stringField(raw.classification) ||
      field(fields, '故障分类', '故障类型', '故障类别', '故障属性', 'SYJX（故障属性）', '分类'),
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
    if (faultCodeKey(record.code) === faultCodeKey(code)) {
      score += 12000
    } else if (faultCodesEqual(record.code, code)) {
      score += 10000
    } else if (
      code.length < 5 &&
      !isBareCodeQuery(queryLower) &&
      !/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(queryLower) &&
      faultCodeKey(record.code).endsWith(faultCodeKey(code))
    ) {
      score += 350
    }
  }

  if (
    queryCodes.length > 0 &&
    (queryCodes.some(code => code.length >= 5) ||
      isBareCodeQuery(queryLower) ||
      isDimensionQualifiedFaultCodeQuery(queryLower) ||
      /(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(queryLower)) &&
    score === 0
  ) {
    return 0
  }

  const searchable = [
    record.code,
    record.name,
    record.site,
    record.brand,
    record.model,
    record.standardModel,
    record.description,
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
  if (corePhraseMatches(searchable, corePhrase)) {
    score += 6000
  }

  const normalizedQueryName = normalizeFaultNameForGrouping(queryLower).toLowerCase()
  const normalizedRecordName = normalizeFaultNameForGrouping(record.name).toLowerCase()
  if (
    normalizedRecordName.length >= 4 &&
    normalizedQueryName === normalizedRecordName
  ) {
    score += 30000
  }
  if (
    normalizedRecordName.length >= 6 &&
    normalizedQueryName.includes(normalizedRecordName)
  ) {
    score += 18000
  }
  if (
    normalizedRecordName.length >= 4 &&
    normalizedRecordName.includes(normalizedQueryName)
  ) {
    score += 12000
  }
  score += scoreFaultNameSimilarity(record, queryLower)
  score += scorePrimaryFaultFields(record, terms, corePhrase)

  const filterBonus = scoreStructuredFilters(record, queryLower)
  if (filterBonus < 0) return 0
  score += filterBonus
  score += scoreQueryCoverage(searchable, terms)
  score += scoreSearchText(searchable, terms)

  return score
}

function isLikelyStructuredFaultQuestion(query: string): boolean {
  return /(故障|报警|告警|停机|复位|不可复位|异常|错误|出错|问题|超出|超限|限制|最大|最小|过高|过低|高于|低于|温度|压力|电流|电压|频率|转速|功率|原因|处理|排查|检查|维修|设置值|逻辑|反馈|断开|跳开|跳闸|空开|短路|断路|丢失|振动|传感器|轴\d|\d轴|桨叶\d|\d号桨|变桨|偏航|刹车|制动|主控|机舱|塔底|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|主断路器|断路器|主断|接触器|扭缆|纽缆|绕缆|润滑|canopen|超级电容|风速仪|轴承|急停|开关|电源|编码器|接近开关|供电|维护|计数|模块|火灾|Safety|按钮)/i.test(query)
}

function scoreFaultNameSimilarity(record: FaultRecord, queryLower: string): number {
  const queryName = normalizeFaultNameForComparison(searchTermSourceForQuery(queryLower))
  const recordName = normalizeFaultNameForComparison(record.name)
  if (queryName.length < 4 || recordName.length < 4) return 0

  let score = 0
  if (queryName === recordName) {
    score += 50000
  } else if (queryName.includes(recordName) || recordName.includes(queryName)) {
    score += 26000
  }

  const queryNumbers = faultNameNumberSignature(queryName)
  const recordNumbers = faultNameNumberSignature(recordName)
  const comparableNumbers = queryNumbers.length > 0 && recordNumbers.length > 0
  if (comparableNumbers && signaturesEqual(queryNumbers, recordNumbers)) {
    score += 12000
  } else if (comparableNumbers) {
    score -= 9000
  }

  const queryLetters = faultNameLetterSignature(queryName)
  const recordLetters = faultNameLetterSignature(recordName)
  const comparableLetters = queryLetters.length > 0 && recordLetters.length > 0
  if (comparableLetters && signaturesEqual(queryLetters, recordLetters)) {
    score += 6000
  } else if (comparableLetters) {
    score -= 5000
  }

  return score
}

function normalizeFaultNameForComparison(value: string): string {
  return normalizeFaultNameForGrouping(value)
    .toLowerCase()
    .replace(/(?:故障码|故障代码|报码|告警码|报警码|状态代码)/gi, '')
    .replace(/(?:怎么处理|如何处理|怎样处理|咋处理|处理方法|维修方法|排查方法|怎么复位|如何复位|为什么会报|为何会报|为啥会报|原因是什么|什么原因)$/gi, '')
    .replace(/[？?，,。.、:：；;\s]/g, '')
}

function faultNameNumberSignature(value: string): string[] {
  return value.match(/\d+/g) ?? []
}

function faultNameLetterSignature(value: string): string[] {
  return value
    .match(/[a-z]+/gi) ?? []
}

function signaturesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function scorePrimaryFaultFields(
  record: FaultRecord,
  terms: SearchTerm[],
  corePhrase: string,
): number {
  const nameText = [record.name, record.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const supportingText = [record.reason, record.solution, record.logic]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const primaryText = [nameText, supportingText].filter(Boolean).join(' ')
  if (!primaryText) return 0

  let score = 0
  const compactNameText = normalizeFaultSubjectText(nameText)
  const compactReasonText = normalizeFaultSubjectText(record.reason)
  const compactSupportingText = normalizeFaultSubjectText(supportingText)
  const compactCorePhrase = normalizeFaultSubjectText(corePhrase)
  if (compactCorePhrase.length >= 4) {
    const coreWithoutContext = stripLookupContextTerms(compactCorePhrase)
    if (
      coreWithoutContext.length >= 4 &&
      (compactNameText.includes(coreWithoutContext) ||
        compactReasonText.includes(coreWithoutContext))
    ) {
      score += 24000
    }
    const contextTerms = LOOKUP_CONTEXT_TERMS.filter(term =>
      compactCorePhrase.includes(normalizeFaultSubjectText(term)),
    )
    if (contextTerms.length > 0) {
      const strippedQueryTerms = componentSearchTerms(
        buildSearchTerms(coreWithoutContext)
          .filter(term => !term.weak && !GENERIC_FAULT_SEARCH_TERMS.has(term.value)),
      )
      if (
        strippedQueryTerms.length >= 2 &&
        contextTerms.some(term => compactReasonText.includes(normalizeFaultSubjectText(term))) &&
        strippedQueryTerms.every(term => termMatches(compactReasonText, term))
      ) {
        score += 60000
        if (/主电源|主回路|主开关/.test(compactReasonText)) {
          score += 90000
        }
      } else if (
        strippedQueryTerms.length >= 2 &&
        contextTerms.some(term => compactSupportingText.includes(normalizeFaultSubjectText(term))) &&
        strippedQueryTerms.every(term => termMatches(compactNameText, term))
      ) {
        score += 12000
      }
    }
  }
  if (corePhraseMatches(nameText, corePhrase)) {
    score += 16000
  } else if (corePhraseMatches(primaryText, corePhrase)) {
    score += 3500
  }

  score += scoreQueryCoverage(nameText, terms) * 5
  score += scoreSearchText(nameText, terms) * 10
  score += scoreQueryCoverage(supportingText, terms)
  score += scoreSearchText(supportingText, terms) * 2

  const strongTerms = componentSearchTerms(
    terms.filter(term => !term.weak && !term.numeric),
  )
  const contextStrippedStrongTerms = componentSearchTerms(
    strongTerms
      .map(term => ({
        ...term,
        value: stripLookupContextTerms(normalizeFaultSubjectText(term.value)),
      }))
      .filter(term => term.value.length >= 2 && !GENERIC_FAULT_SEARCH_TERMS.has(term.value)),
  )
  if (
    contextStrippedStrongTerms.length >= 2 &&
    contextStrippedStrongTerms.every(term => termMatches(compactNameText, term))
  ) {
    score += 18000
  } else if (
    contextStrippedStrongTerms.length >= 2 &&
    contextStrippedStrongTerms.every(term => termMatches(primaryText, term))
  ) {
    score += 5000
  }
  if (
    strongTerms.length >= 2 &&
    strongTerms.every(term => termMatches(nameText, term))
  ) {
    score += 4500
  } else if (
    strongTerms.length >= 2 &&
    strongTerms.every(term => termMatches(primaryText, term))
  ) {
    score += 900
  }

  return score
}

function corePhraseMatches(content: string, corePhrase: string): boolean {
  if (corePhrase.length < 4) return false
  const normalizedContent = content.toLowerCase()
  if (faultSubjectMatchesText(normalizedContent, corePhrase)) return true
  if (!/\d/.test(corePhrase)) {
    return normalizedContent.replace(/\s+/g, '').includes(corePhrase)
  }
  const terms = buildSearchTerms(corePhrase).filter(term => !term.weak)
  const strongTerms = componentSearchTerms(terms)
  return (
    strongTerms.length > 0 &&
    strongTerms.every(term => termMatches(normalizedContent, term))
  )
}

function normalizeFaultSearchPhrase(queryLower: string): string {
  return normalizeFaultVariantText(queryLower)
    .replace(/(是什么故障造成的|什么故障造成的|是什么原因造成的|什么原因造成的|由什么造成|什么造成的|怎么处理|如何处理|怎样处理|咋处理|处理方法|维修方法|排查方法|是什么故障|是什么|是啥|啥意思|含义|原因|为什么|能不能复位|能否复位|是否可复位|可不可以复位|分别是什么|对应哪些故障码|故障码是什么|故障代码是什么)/gi, '')
    .replace(/(请问|帮我|给我|查询|查一下|查下|查|搜索|检索|一下|下)/gi, '')
    .replace(/(故障码|故障代码|报码|告警码|报警码|状态代码)/gi, '')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
}

function faultSubjectMatchesText(content: string, subject: string): boolean {
  const normalizedContent = normalizeFaultSubjectText(content)
  const normalizedSubject = normalizeFaultSubjectText(subject)
  if (normalizedSubject.length < 4) return false
  if (normalizedContent.includes(normalizedSubject)) return true

  const subjectTerms = faultSubjectTerms(normalizedSubject)
  if (subjectTerms.length === 0) return false
  return subjectTerms.every(term => normalizedContent.includes(term))
}

function normalizeFaultSubjectText(value: string): string {
  return normalizeFaultVariantText(value)
    .toLowerCase()
    .replace(/主断(?:路器)?/g, '主断路器')
    .replace(/(?:跳了|跳掉|跳脱|脱扣|分断)/g, '跳闸')
    .replace(/(?:异常跳开|异常断开|断开|跳开)/g, '跳闸')
    .replace(/发电机(?:驱动端|非驱动端|de端|nde端|驱动侧|非驱动侧)?轴承温/g, '发电机轴承温度')
    .replace(/发电机(?:驱动端|非驱动端|de端|nde端|驱动侧|非驱动侧)?轴承温度/g, '发电机轴承温度')
    .replace(/温度(?:异常偏高|偏高|超限|越限|高至极限|过高|较高|高报警|高停机|高)/g, '温度高')
    .replace(/(?:超温|过温|高温|过热|发热)/g, '温度高')
    .replace(/超过(?:设)?\d+(?:\.\d+)?(?:°c|℃|摄氏度|度)?/g, '温度高')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
}

function faultSubjectTerms(value: string): string[] {
  const terms: string[] = []
  if (value.includes('发电机')) terms.push('发电机')
  if (value.includes('轴承')) terms.push('轴承')
  if (value.includes('温度')) terms.push('温度')
  if (value.includes('主断路器')) terms.push('主断路器')
  if (value.includes('断路器')) terms.push('断路器')
  if (/温度高|超限|过高|超温|过温|高温/.test(value)) terms.push('温度高')
  if (/跳闸|跳开|断开|脱扣|分闸/.test(value)) terms.push('跳闸')
  return [...new Set(terms)]
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

type QueryAnalysisMemo = {
  faultCodes: string[]
  turbineFaultDescription: boolean
  faultDescriptionLookup: boolean
}

const queryAnalysisMemoCache = new Map<string, QueryAnalysisMemo>()

function getQueryMemo(query: string): QueryAnalysisMemo {
  const key = String(query || '')
  const cached = queryAnalysisMemoCache.get(key)
  if (cached) return cached

  const memo: QueryAnalysisMemo = {
    faultCodes: [],
    turbineFaultDescription: false,
    faultDescriptionLookup: false,
  }
  queryAnalysisMemoCache.set(key, memo)

  memo.turbineFaultDescription = isTurbineFaultDescriptionQueryImpl(key)
  memo.faultCodes = extractFaultCodesImpl(key)
  memo.faultDescriptionLookup = isFaultDescriptionLookupQueryImpl(key, memo)
  return memo
}

function extractFaultCodes(query: string): string[] {
  return getQueryMemo(query).faultCodes
}

function extractFaultCodesImpl(query: string): string[] {
  const normalizedQuery = normalizeFaultCodeQuery(query)
  const numericRange = String.raw`\d+\s*(?:至|到|[~～])\s*\d+`
  const numericRangeOrList = String.raw`(?:${numericRange}|\d+)(?:\s*[、,，]\s*(?:${numericRange}|\d+))+`
  const faultCodePattern =
    new RegExp(
      `[a-z]+[a-z0-9_/-]*\\d[a-z0-9_/-]*|${numericRangeOrList}|${numericRange}|\\d+(?:[ _/-]+\\d+)+|\\d+(?:[、,，]\\d+)+|\\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\\d[a-z0-9_/-]*|\\d+`,
      'gi',
    )
  const rawCodes = [...normalizedQuery.matchAll(faultCodePattern)]
    .filter(match =>
      faultCodeMatchHasTokenBoundary(
        normalizedQuery,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      ),
    )
    .map(match => match[0])
  const contextualCodes = [
    ...normalizedQuery.matchAll(
      new RegExp(
        `(?:故障码|故障代码|报码|报出|报|告警码|报警码|报警|告警|状态代码|fault\\s*code|alarm\\s*code)\\s*[:：为是]?\\s*([a-z]+[a-z0-9_/-]*\\d[a-z0-9_/-]*|${numericRangeOrList}|${numericRange}|\\d+(?:[ _/-]+\\d+)+|\\d+(?:[、,，]\\d+)+|\\d[a-z0-9_/-]*[a-z_/-][a-z0-9_/-]*\\d[a-z0-9_/-]*|\\d{1,8})`,
        'gi',
      ),
    ),
  ].map(match => match[1] ?? '')

  const scTableCodes = extractScTableFaultCodes(normalizedQuery)
  let codes = contextualCodes.length > 0
    ? [
        ...contextualCodes,
        ...scTableCodes,
        ...rawCodes.filter(code => shouldKeepRawFaultCode(normalizedQuery, code)),
      ]
    : [
        ...scTableCodes,
        ...rawCodes.filter(code => shouldKeepRawFaultCode(normalizedQuery, code)),
      ]

  if (scTableCodes.length > 0) {
    codes = [
      ...scTableCodes,
      ...codes.filter(
        code =>
          scTableCodes.some(scCode => faultCodesEqual(scCode, code)) ||
          !isScTableFaultCodeFragment(code, scTableCodes),
      ),
    ]
  }

  const compositeCodes = codes.filter(code => /[a-z]/i.test(code) && /\d/.test(code))
  if (compositeCodes.length > 0) {
    codes = codes.filter(
      code =>
        compositeCodes.some(compositeCode => faultCodesEqual(compositeCode, code)) ||
        !isCompositeFaultCodeFragment(code, compositeCodes),
    )
  }

  const turbineIds = new Set(
    extractTurbineIdsFromText(normalizedQuery).map(id => id.toUpperCase()),
  )
  const turbineCodeExclusions = buildTurbineCodeExclusionTokens(normalizedQuery)
  if (turbineIds.size > 0 || turbineCodeExclusions.size > 0) {
    codes = codes.filter(
      code => !turbineCodeExclusions.has(cleanFaultCode(code).toUpperCase()),
    )
    let rest = normalizedQuery
    for (const turbineId of turbineIds) {
      rest = rest.replace(new RegExp(escapeRegExp(turbineId), 'gi'), ' ')
    }
    rest = rest.replace(/(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])/giu, ' ')
    for (const match of rest.matchAll(/\b(\d{1,8})\b/g)) {
      const code = match[1] ?? ''
      if (
        code &&
        !turbineCodeExclusions.has(code.toUpperCase()) &&
        shouldKeepRawFaultCode(normalizedQuery, code)
      ) {
        codes.push(code)
      }
    }
  }

  return [...new Set(codes.map(code => cleanFaultCode(code).toLowerCase()))]
}

function isCompositeFaultCodeFragment(code: string, compositeCodes: string[]): boolean {
  const key = faultCodeKey(code)
  if (!key) return false
  return compositeCodes.some(compositeCode => {
    const compositeKey = faultCodeKey(compositeCode)
    if (!compositeKey || compositeKey === key) return false
    return compositeKey.includes(key) && compositeKey.length > key.length
  })
}

function isScTableFaultCodeFragment(code: string, scTableCodes: string[]): boolean {
  const key = faultCodeKey(code)
  if (!key) return false
  return scTableCodes.some(scCode => {
    const scKey = faultCodeKey(scCode)
    return key !== scKey && scKey.includes(key)
  })
}

function extractScTableFaultCodes(query: string): string[] {
  const codes: string[] = []
  for (const match of query.matchAll(/\bSC\s*(\d{2})\s*(\d{2})\s+(\d{3})\b/gi)) {
    codes.push(`SC${match[1]}_${match[2]}_${match[3]}`.toUpperCase())
  }
  for (const match of query.matchAll(/\bSC\s*(\d{2})\s+(\d{2})\s+(\d{3})\b/gi)) {
    codes.push(`SC${match[1]}_${match[2]}_${match[3]}`.toUpperCase())
  }
  for (const match of query.matchAll(/\bSC\s*(\d{4})\s+(\d{3})\b/gi)) {
    const block = match[1] ?? ''
    if (block.length === 4) {
      codes.push(`SC${block.slice(0, 2)}_${block.slice(2, 4)}_${match[2]}`.toUpperCase())
    }
  }
  for (const match of query.matchAll(/(?:^|[^A-Za-z0-9])SC\s*(\d{4})\s+(\d{3})(?=[^A-Za-z0-9]|$)/gi)) {
    const block = match[1] ?? ''
    if (block.length === 4) {
      codes.push(`SC${block.slice(0, 2)}_${block.slice(2, 4)}_${match[2]}`.toUpperCase())
    }
  }
  return [...new Set(codes)]
}

function faultCodeMatchHasTokenBoundary(
  query: string,
  start: number,
  end: number,
): boolean {
  const before = query[start - 1] ?? ''
  const beforePrev = query[start - 2] ?? ''
  if (/[a-z0-9_]/i.test(before)) return false
  if (before === '.' && /[a-z0-9]/i.test(beforePrev)) return false
  const after = query[end] ?? ''
  const afterNext = query[end + 1] ?? ''
  if (/[a-z0-9_]/i.test(after)) return false
  if (after === '.' && /[a-z0-9]/i.test(afterNext)) return false
  return true
}

function cleanFaultCode(value: string): string {
  let normalized = value.trim()
  const metadataIndex = normalized.search(
    /[，,；;。]\s*(?:对应|故障|分类|unnamed|bachmann|abb|描述|触发|刹车|制动|报警|偏航|复位|设置|信号源|等级)/i,
  )
  if (metadataIndex > 0) normalized = normalized.slice(0, metadataIndex).trim()
  if (/^[a-z0-9_.\/-]+\d[a-z0-9_.\/-]*$/i.test(normalized)) return normalized
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
  const aliases = expanded
    .map(item => faultCodeKey(item))
    .filter(Boolean)
  for (const item of expanded) {
    const trimmed = item.trim()
    if (/^0+\d+$/.test(trimmed)) {
      const stripped = trimmed.replace(/^0+/, '')
      if (stripped) aliases.push(stripped)
    }
  }
  return [...new Set(aliases)]
}

function faultCodeSurfaceForms(code: string): string[] {
  const forms = new Set<string>()
  const cleaned = cleanFaultCode(code)
  if (!cleaned) return []
  forms.add(cleaned)
  forms.add(cleaned.toLowerCase())
  forms.add(cleaned.toUpperCase())
  for (const alias of faultCodeAliases(code)) {
    forms.add(alias)
  }
  const scMatch = cleaned.match(/^SC(\d{2})_(\d{2})_(\d{3})$/i)
  if (scMatch) {
    forms.add(`SC${scMatch[1]}${scMatch[2]} ${scMatch[3]}`)
    forms.add(`SC ${scMatch[1]}${scMatch[2]} ${scMatch[3]}`)
    forms.add(`SC${scMatch[1]}_${scMatch[2]}_${scMatch[3]}`)
    forms.add(`SC${scMatch[1]}${scMatch[2]}${scMatch[3]}`)
    forms.add(`SC${scMatch[1]} ${scMatch[2]} ${scMatch[3]}`)
    forms.add(`SC ${scMatch[1]} ${scMatch[2]} ${scMatch[3]}`)
  }
  return [...forms].sort((left, right) => right.length - left.length)
}

function faultCodePatternAlternation(code: string): string {
  const forms = faultCodeSurfaceForms(code)
  if (forms.length === 0) return escapeRegExp(code)
  return forms.map(form => escapeRegExp(form)).join('|')
}

function queryContainsFaultCodeReference(query: string, code: string): boolean {
  const normalized = normalizeFaultCodeQuery(query)
  if (!normalized || !code) return false
  if (
    new RegExp(
      `(^|[^\\dA-Za-z])(${faultCodePatternAlternation(code)})(?=\\s|[^\\dA-Za-z]|$)`,
      'i',
    ).test(normalized)
  ) {
    return true
  }
  return extractScTableFaultCodes(normalized).some(scCode => faultCodesEqual(scCode, code))
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

function isCountNumberInQuery(query: string, code: string): boolean {
  if (!/^\d+$/.test(code)) return false
  return new RegExp(`${escapeRegExp(code)}\\s*(?:个|条|种|类|台|套|次|家|处|项|组|页|行|列|句|字|人|号机组)`, 'i').test(
    query,
  )
}

function buildTurbineCodeExclusionTokens(query: string): Set<string> {
  const tokens = new Set<string>()
  const site = extractSiteFromText(query) ?? undefined
  for (const turbineId of extractTurbineIdsFromText(query)) {
    for (const token of expandTurbineTokensForExclusion(turbineId, site)) {
      tokens.add(token.toUpperCase())
    }
  }
  return tokens
}

function isTurbineNumericFaultCodeToken(query: string, code: string): boolean {
  if (!/^\d{1,8}$/.test(code)) return false
  return buildTurbineCodeExclusionTokens(query).has(code.toUpperCase())
}

function isTurbineFaultDescriptionQuery(query: string): boolean {
  return getQueryMemo(query).turbineFaultDescription
}

function isTurbineFaultDescriptionQueryImpl(query: string): boolean {
  if (extractTurbineIdsFromText(query).length === 0) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(query)) return false
  if (
    hasFaultHandlingIntent(query) ||
    isFaultDescriptionSubject(query) ||
    /(存在|出现|发生).{0,12}(故障|异常|报警|告警)/i.test(query)
  ) {
    return true
  }
  if (/(怎么处理|如何处理|怎么办|如何排查|处理步骤)/i.test(query)) {
    const subject = stripTurbineLocationContextFromQuery(
      query.replace(
        /(怎么处理|如何处理|怎么办|如何排查|处理步骤|存在故障|如何处理\?|如何处理？)/gi,
        ' ',
      ),
    )
      .replace(/[？?，,。.、:：；;/\s]/g, '')
      .trim()
    return subject.length >= 2
  }
  return false
}

function isTurbineNumberMarkerInQuery(query: string, code: string): boolean {
  if (!/^\d{1,3}$/.test(code)) return false
  return new RegExp(
    `(?<![A-Za-z0-9])${escapeRegExp(code)}号(?![A-Za-z0-9])`,
    'iu',
  ).test(query)
}

function shouldKeepRawFaultCode(query: string, code: string): boolean {
  if (isTurbineNumberMarkerInQuery(query, code)) return false
  if (buildTurbineCodeExclusionTokens(query).has(cleanFaultCode(code).toUpperCase())) {
    return false
  }
  if (isTurbineNumericFaultCodeToken(query, code)) return false
  if (isNumericInFaultNameLookup(query, code)) return false
  if (isNumericPrefixFaultNameLookup(query, code)) return false
  if (isAlphaCodeTokenInFaultNameLookup(query, code)) return false
  if (isMeasurementNumberInQuery(query, code)) return false
  if (isRatingOrVersionNumberInQuery(query, code)) return false
  if (isCountNumberInQuery(query, code)) return false
  return (
    isLongNumericOrAlphanumericFaultCode(code) ||
    isBareNumericFaultCodeQuery(query, code) ||
    isLeadingFaultIntentQualifiedCode(query, code) ||
    isLeadingDimensionQualifiedFaultCode(query, code) ||
    isDimensionFaultIntentQualifiedCode(query, code) ||
    isDimensionBareCodeQuery(query, code) ||
    isTurbineQualifiedBareCodeQuery(query, code)
  )
}

function isTurbineQualifiedBareCodeQuery(query: string, code: string): boolean {
  if (isTurbineFaultDescriptionQueryImpl(query)) return false
  const turbineIds = extractTurbineIdsFromText(query)
  if (turbineIds.length === 0) return false
  if (!new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(code)}(?![A-Za-z0-9])`, 'i').test(query)) {
    return false
  }
  let rest = query
  for (const turbineId of turbineIds) {
    rest = rest.replace(new RegExp(escapeRegExp(turbineId), 'gi'), ' ')
  }
  rest = rest
    .replace(new RegExp(escapeRegExp(code), 'i'), ' ')
    .replace(/(?:风机编号|风机号|机位号|机组编号)[:：]?/gi, ' ')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
  return rest.length <= 2
}

function isAlphaCodeTokenInFaultNameLookup(query: string, code: string): boolean {
  if (!/[a-z]/i.test(code) || !/\d/.test(code)) return false
  const normalized = String(query || '').trim()
  if (!hasFaultNameToCodeIntent(normalized)) return false
  if (isContextuallyIntroducedFaultCode(normalized, code)) return false
  if (isLeadingExplicitCodeLikeToken(normalized, code) && !isCamelCaseFaultNameToken(code)) {
    return false
  }
  return true
}

function hasFaultNameToCodeIntent(query: string): boolean {
  return /(是什么故障码|是什么码|故障码是什么|故障代码是什么|什么码|对应.*码|哪些故障码|有什么故障码|报啥码|报什么码|会报哪些码|会报什么码|会出啥码|会出什么码|报哪些码|报码|告警码|报警码|(?:^|\s)啥码(?:\s|$)|(?:^|\s)什么码(?:\s|$)|报啥(?!情况)|报什么(?!情况|故障|原因))/i.test(
    query,
  )
}

function isContextuallyIntroducedFaultCode(query: string, code: string): boolean {
  return new RegExp(
    `(?:故障码|故障代码|报码|报出|告警码|报警码|状态代码|fault\\s*code|alarm\\s*code)\\s*[:：为是]?\\s*${escapeRegExp(code)}(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(query)
}

function isLeadingExplicitCodeLikeToken(query: string, code: string): boolean {
  return new RegExp(
    `^\\s*${escapeRegExp(code)}(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(query)
}

function isCamelCaseFaultNameToken(value: string): boolean {
  return /[a-z][A-Z]/.test(value)
}

function isNumericInFaultNameLookup(query: string, code: string): boolean {
  if (!/^\d{1,2}$/.test(code)) return false
  const normalized = String(query || '').replace(/\s+/g, '')
  if (
    !/(是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|有什么故障码|报码|告警码|报警码)/i.test(normalized)
  ) {
    return false
  }
  return new RegExp(`[\\u4e00-\\u9fffA-Za-z]${escapeRegExp(code)}(?=[\\u4e00-\\u9fffA-Za-z]|$)`).test(normalized)
}

function isNumericPrefixFaultNameLookup(query: string, code: string): boolean {
  if (!/^\d{1,8}$/.test(code)) return false
  const normalized = String(query || '').trim()
  return Boolean(
    new RegExp(`^${escapeRegExp(code)}[\\u4e00-\\u9fffA-Za-z]`).test(normalized) &&
      /(是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|有什么故障码|报码|告警码|报警码)/i.test(normalized),
  )
}

function isLeadingFaultIntentQualifiedCode(query: string, code: string): boolean {
  if (!/^\d{1,8}$/.test(code)) return false
  const normalized = String(query || '').trim()
  return Boolean(
    new RegExp(`^(?:故障码|故障代码|报码|告警码|报警码|状态代码)?\\s*${escapeRegExp(code)}(?=\\s|[^\\dA-Za-z]|$)`, 'i').test(normalized) &&
      /(是什么故障|什么故障|故障|报警|告警|停机|处理|复位|原因|为什么|为何|为啥|怎么|如何|会报|报出|报码|含义)/i.test(normalized),
  )
}

function isLeadingDimensionQualifiedFaultCode(query: string, code: string): boolean {
  const normalized = String(query || '').trim()
  return Boolean(
    new RegExp(`^(?:故障码|故障代码|报码|告警码|报警码|状态代码)?\\s*${escapeRegExp(code)}(?=\\s|[^\\dA-Za-z]|$)`, 'i').test(normalized) &&
      /(风场|风电场|场站|华仪|华锐|金风|歌美飒|运达|明阳|新誉|湘电|远景|三一|中车山东|上海电气|团结|洮北|镇赉|镇赍|同发|王玲山|良井子|新华|四平|通榆)/i.test(normalized),
  )
}

function isDimensionFaultIntentQualifiedCode(query: string, code: string): boolean {
  if (!isValidFaultCodeValue(code)) return false
  const normalized = String(query || '').trim()
  if (!new RegExp(`(^|[^\\dA-Za-z])${escapeRegExp(code)}(?=\\s|[^\\dA-Za-z]|$)`, 'i').test(normalized)) {
    return false
  }
  const hasDimension = /(风场|风电场|场站|机型|型号|品牌|厂家|系列|华仪|华锐|金风|歌美飒|运达|明阳|新誉|湘电|远景|三一|中车山东|上海电气|团结|洮北|镇赉|镇赍|同发|王玲山|良井子|新华|四平|通榆)/i.test(normalized)
  const hasFaultIntent = /(是什么故障|什么故障|故障|报警|告警|停机|处理|复位|原因|报码|故障码|代码|怎么|如何)/i.test(normalized)
  return hasDimension && hasFaultIntent
}

function isMeasurementNumberInQuery(query: string, code: string): boolean {
  if (!/^\d+$/.test(code)) return false
  const pattern = new RegExp(`${escapeRegExp(code)}(?:\\.\\d+)?\\s*(?:°|℃|%|度|rpm|bar|v|a|hz|kw|mw)`, 'i')
  return pattern.test(query)
}

function isRatingOrVersionNumberInQuery(query: string, code: string): boolean {
  if (!/^\d+$/.test(code)) return false
  const pattern = new RegExp(
    `${escapeRegExp(code)}(?:\\.\\d+)?\\s*(?:mw|kw|mw级|兆瓦|千瓦|版本|ver|v\\d)`,
    'i',
  )
  return pattern.test(query)
}

function isNonFaultMeasurementOrRatingQuestion(query: string): boolean {
  const normalized = query.trim()
  if (!normalized) return false
  if (/(?:今天|现在|当前|现场)?\s*风速\s*(?:多大|多少|几|怎么样)/i.test(normalized)) {
    return true
  }
  if (/(?:\d+(?:\.\d+)?\s*)?兆瓦/i.test(normalized) && /(?:几个|多少|有几|几台)/i.test(normalized)) {
    return true
  }
  if (/(?:程序|软件|系统)\s*版本/i.test(normalized)) {
    return true
  }
  if (/(?:股票|股价|值班|几号|小伙子|人来了)/i.test(normalized)) {
    return true
  }
  if (/(?:电压|电流|功率|转速|频率|温度|压力|版本|兆瓦|千瓦|mw|kw)\s*(?:正常|偏高|偏低|多少|是多少|对不对|对吗|ok|OK)/i.test(normalized)) {
    return true
  }
  if (/(?:正常吗|对不对|是多少|多少伏|多少v|几伏)/i.test(normalized) && /\d+(?:\.\d+)?\s*(?:v|a|mw|kw|°|℃|%|rpm|bar|hz)/i.test(normalized)) {
    return true
  }
  if (/(?:主控|软件|程序|系统|plc|hmi)\s*(?:版本|ver)/i.test(normalized)) {
    return true
  }
  return false
}

function normalizeColloquialQuery(query: string): string {
  return String(query || '')
    .replace(/[…⋯]/g, ' ')
    .replace(/报马/g, '报了')
    .replace(/报嘛/g, '报了')
    .replace(/报吗/g, '报了')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeFaultCodeQuery(query: string): string {
  return normalizeChineseNumericFaultCodes(
    normalizeChineseFaultDigits(normalizeColloquialQuery(query)),
  )
}

function normalizeChineseFaultDigits(query: string): string {
  const digitMap = chineseDigitMap()
  return String(query || '').replace(/SC\s*([零〇一二两三四五六七八九\d\s]{4,24})/gi, (match, block: string) => {
    if (!/[零〇一二两三四五六七八九]/.test(block)) {
      return match
    }
    const digits = convertChineseDigits(block).replace(/\s+/g, '')
    if (digits.length >= 7) {
      return `SC${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 7)}`
    }
    if (digits.length === 7) {
      return `SC${digits.slice(0, 4)} ${digits.slice(4)}`
    }
    return `SC${digits}`
  })
}

function chineseDigitMap(): Record<string, string> {
  return {
    零: '0',
    〇: '0',
    一: '1',
    二: '2',
    两: '2',
    三: '3',
    四: '4',
    五: '5',
    六: '6',
    七: '7',
    八: '8',
    九: '9',
  }
}

function convertChineseDigits(value: string): string {
  const digitMap = chineseDigitMap()
  return String(value || '').replace(/[零〇一二两三四五六七八九]/g, char => digitMap[char] ?? char)
}

function normalizeChineseNumericFaultCodes(query: string): string {
  let normalized = String(query || '').replace(/SM([零〇一二两三四五六七八九]{4,12})/gi, (_match, block: string) => {
    return `SM${convertChineseDigits(block)}`
  })
  normalized = normalized.replace(/[零〇一二两三四五六七八九]{3,8}/g, match => {
    const digits = convertChineseDigits(match)
    return /^\d{3,8}$/.test(digits) ? digits : match
  })
  return normalized
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
      /(故障码|故障代码|报码|报出|报警码|告警码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|告警|故障|逻辑|怎么|如何|的|为|是|报)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

function isTurbineQualifiedFaultCodeQuery(query: string): boolean {
  const turbineIds = extractTurbineIdsFromText(query)
  if (turbineIds.length === 0) return false
  if (isTurbineFaultDescriptionQuery(query)) return false
  return extractFaultCodes(query).length > 0
}

function isFaultCodeQuery(query: string): boolean {
  if (isNonFaultMeasurementOrRatingQuestion(query)) return false
  if (isFaultNameToCodeQuestion(query)) return false
  if (isTurbineFaultDescriptionQuery(query)) return false
  const codes = extractFaultCodes(query)
  if (codes.length === 0) return false
  if (isBareCodeQuery(query)) return true
  if (isDimensionQualifiedFaultCodeQuery(query)) return true
  if (isTurbineQualifiedFaultCodeQuery(query)) return true
  if (/(故障码|故障代码|报码|报出|报警码|告警码|fault\s*code)/i.test(query)) return true
  if (/(?:^|[^\u4e00-\u9fffA-Za-z0-9])(报|报警|告警)\s*[:：为是]?\s*[A-Za-z]{0,4}\d{1,8}/i.test(query)) return true
  return codes.some(code => /^\d{3,}$/.test(code) || /[a-z]/i.test(code))
}

function isFaultNameToCodeQuestion(query: string): boolean {
  const normalized = String(query || '').trim()
  if (!normalized) return false
  if (isExplicitLeadingFaultCodeQuestion(normalized)) {
    return false
  }
  return (
    hasFaultNameToCodeIntent(normalized) &&
    /(故障|报警|告警|停机|异常|错误|问题|超限|过高|过低|高于|低于|温度|压力|电流|电压|频率|转速|功率|断开|短路|断路|丢失|通信|通讯|传感器|接近开关|超级电容|桨叶|轴\d|\d轴|变桨|偏航|刹车|制动|主控|机舱|塔基|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|坏了|损坏|失效|扭缆|纽缆|绕缆|反馈)/i.test(
      normalized,
    )
  )
}

function isExplicitLeadingFaultCodeQuestion(query: string): boolean {
  if (isBareCodeQuery(query)) return true
  const codes = extractFaultCodes(query)
  return codes.some(code => {
    const codePattern = faultCodePatternAlternation(code)
    const hasFaultCodeLabel = new RegExp(
      `^\\s*(?:故障码|故障代码|报码|报出|告警码|报警码|状态代码)\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
      'i',
    ).test(query)
    if (hasFaultCodeLabel) return true
    if (
      new RegExp(
        `^\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)\\s*(?:这个|该|此)?\\s*(?:故障码|故障代码)`,
        'i',
      ).test(query)
    ) {
      return true
    }
    if (/^\d+$/.test(code)) return false
    return new RegExp(
      `^\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$).*(?:是什么故障|什么故障|故障|报警|告警|停机|处理|复位|原因|为什么|为何|为啥|怎么|如何|会报|报出|含义|意思)`,
      'i',
    ).test(query)
  })
}

function isDimensionQualifiedFaultCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const code = codes[0] ?? ''
  return (
    isLeadingFaultIntentQualifiedCode(query, code) ||
    isLeadingDimensionQualifiedFaultCode(query, code) ||
    isDimensionFaultIntentQualifiedCode(query, code) ||
    isDimensionBareCodeQuery(query, code)
  )
}

function isDimensionBareCodeQuery(query: string, code: string): boolean {
  if (!isValidFaultCodeValue(code)) return false
  const dimensionPattern = new RegExp(
    [
      ...KNOWN_FAULT_BRANDS,
      ...KNOWN_FAULT_SITES,
      '风场',
      '风电场',
      '场站',
      '机型',
      '型号',
      '品牌',
      '厂家',
      '系列',
    ]
      .map(escapeRegExp)
      .join('|'),
    'gi',
  )
  const withoutDimensions = query.replace(dimensionPattern, ' ')
  if (withoutDimensions === query) return false
  const rest = withoutDimensions
    .replace(new RegExp(escapeRegExp(code), 'i'), '')
    .replace(
      /(故障码|故障代码|报码|报出|报警码|告警码|状态代码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|告警|故障|逻辑|怎么|如何|的|为|是|报|在|有)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

function isBareCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const code = codes[0]!
  const trimmed = query.trim()
  if (!queryLeadingFaultCodeMatches(trimmed, code)) {
    return false
  }
  const rest = query
    .replace(new RegExp(escapeRegExp(code), 'i'), '')
    .replace(/\bSC\s*\d{4}\s+\d{3}\b/gi, '')
    .replace(
      /(故障码|故障代码|报码|报出|报警码|告警码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|告警|故障|逻辑|怎么|如何|的|为|是|报)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

function queryLeadingFaultCodeMatches(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  if (
    new RegExp(
      `^(?:故障码|故障代码|报码|报出|告警码|报警码|状态代码)?\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
      'i',
    ).test(query)
  ) {
    return true
  }
  return extractScTableFaultCodes(query).some(scCode => faultCodesEqual(scCode, code))
}

function isColloquialFaultCodeConfusionQuery(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:整不会了|整不明白|搞不懂|弄不明白).{0,8}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$).{0,10}(?:整不会了|整不明白|搞不懂|弄不明白)`,
    'i',
  ).test(query)
}

function isColloquialFaultCodeReappearQuery(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$).{0,12}(?:又出来了|又报了|又来了|再次出现)|(?:又出来了|又报了|又来了).{0,12}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(query)
}

function isMultiFaultCodeQuestion(query: string): boolean {
  const normalized = normalizeFaultCodeQuery(query)
  const codes = extractFaultCodes(normalized)
  if (codes.length < 2 || codes.length > 5) return false
  if (!/(和|跟|还有|以及|、|,|，|都|同时|一起|一块儿|一块|俩|两个|两个码|仨|三个)/i.test(normalized)) {
    return false
  }
  if (
    !/(是什么|啥|啥意思|什么意思|意思|含义|怎么|如何|处理|复位|原因|报了|报出|报警|告警|故障|怎么办|咋弄|咋整|咋回事|都报了|都弹|看一下|查下|查)/i.test(
      normalized,
    )
  ) {
    return false
  }
  return codes.every(code => queryContainsFaultCodeReference(normalized, code))
}

function isEmbeddedFaultCodeQuestion(query: string): boolean {
  const normalized = normalizeFaultCodeQuery(query)
  const codes = extractFaultCodes(normalized)
  if (codes.length !== 1) return false
  const code = codes[0] ?? ''
  if (!code) return false
  if (
    isExplicitLeadingFaultCodeQuestion(normalized) ||
    isDimensionQualifiedFaultCodeQuery(normalized) ||
    isBareCodeQuery(normalized)
  ) {
    return false
  }
  if (!queryContainsFaultCodeReference(normalized, code)) {
    return false
  }
  return (
    isContextuallyReportedFaultCode(normalized, code) ||
    isSearchPrefixedFaultCodeQuestion(normalized, code) ||
    isThisCodeReferenceQuestion(normalized, code) ||
    isColloquialFaultCodePopup(normalized, code) ||
    isColloquialFaultCodeSituationQuestion(normalized, code) ||
    isScTableCodePresentationQuery(normalized, code) ||
    isColloquialFaultCodeDiscoveryQuery(normalized, code) ||
    isColloquialFaultCodeConfusionQuery(normalized, code) ||
    isColloquialFaultCodeReappearQuery(normalized, code) ||
    ((isLongNumericOrAlphanumericFaultCode(code) || /^SC/i.test(code)) &&
      /(是什么|啥|啥意思|什么意思|意思|含义|怎么|如何|处理|复位|原因|为什么|为何|为啥|帮我|查|看看|报了|报警|告警|故障|怎么办)/i.test(
        normalized,
      ))
  )
}

function isScTableCodePresentationQuery(query: string, code: string): boolean {
  if (!extractScTableFaultCodes(query).some(scCode => faultCodesEqual(scCode, code))) {
    return false
  }
  const remainder = query
    .replace(/\bSC\s*\d{2}\s*\d{2}\s+\d{3}\b/gi, '')
    .replace(/\bSC\s*\d{2}\s+\d{2}\s+\d{3}\b/gi, '')
    .replace(/\bSC\s*\d{4}\s+\d{3}\b/gi, '')
    .replace(
      /(?:主控|hmi|scada|集控|屏幕|界面|系统|风机|机组|变流器|变桨|偏航|里|上|的|看|显示|报|出|现|了|[，,。.、:：\s])+/gi,
      '',
    )
    .trim()
  return remainder.length === 0
}

function isColloquialFaultCodeDiscoveryQuery(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:停(?:机|了)?|跳闸|告警|报警).{0,12}?(?:一看|看到|看见|瞅见|发现).{0,8}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:一看|看到|看见|瞅见|发现).{0,6}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:${codePattern})(?:[…⋯]|\\.{2,3})?(?:又)?(?:弹了|弹出|跳出来|出现|出了|亮了|有了)`,
    'i',
  ).test(query)
}

function isColloquialFaultCodePopup(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:主控|hmi|scada|集控|屏幕|界面|系统|风机|机组|变流器|变桨|偏航).{0,12}?(?:弹了|弹出|跳出来|出现|出了|显示|看到|报了|报出|报警|告警|跳闸|跳了|亮了).{0,12}?(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:一块儿|一块|一起).{0,8}(?:弹了|弹出|跳出来|出现|出了|报了|报出|报警|告警).{0,8}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:弹了|弹出|跳出来|出现|出了|显示|看到|报了|报出|报警|告警|跳闸|跳了|亮了|又弹了|又报了).{0,12}?(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:${codePattern})(?:[…⋯]|\\.{2,3}|\\s+)(?:又)?(?:弹了|弹出|跳出来|出现|出了|亮了)`,
    'i',
  ).test(query)
}

function isColloquialFaultCodeSituationQuestion(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$).{0,10}(?:咋|啥|什么|怎么|如何|情况|意思|含义|咋整|咋弄|咋回事|整不明白|整不会了|整啥呢|是什么|怎么办|怎么处理|远程复位|复位|接下来)|(?:刚才|刚刚|现在|刚才刚|刚).{0,8}(?:报|弹|出|出现).{0,8}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(query)
}

function isContextuallyReportedFaultCode(query: string, code: string): boolean {
  const normalized = normalizeFaultCodeQuery(query)
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:报了|报出|报警了|告警了|报了?)\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:报了|报出|报警了|告警了|报了?)(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:风机|机组|主控|hmi|scada|集控).{0,8}(?:报了|报出|报警|告警)(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(normalized)
}

function isSearchPrefixedFaultCodeQuestion(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:帮我|给我|请|麻烦)?\\s*(?:查一下|查下|查|查询|检索|搜索|搜一下|搜下|搜|看看|帮看下|帮查下|帮忙查下|帮忙看看|帮忙查|帮忙看)\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:帮我|给我|请|麻烦).{0,8}(?:查|看).{0,8}(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)`,
    'i',
  ).test(query)
}

function isThisCodeReferenceQuestion(query: string, code: string): boolean {
  const codePattern = faultCodePatternAlternation(code)
  return new RegExp(
    `(?:${codePattern})\\s*(?:这个|该|此)?\\s*码|(?:这个|该|此)\\s*(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:这个|该|此)(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$)|(?:${codePattern})(?=\\s|[^\\dA-Za-z]|$).{0,8}(?:这个|该|此)?\\s*码`,
    'i',
  ).test(query)
}

function isFaultDescriptionLookupQuery(query: string): boolean {
  return getQueryMemo(query).faultDescriptionLookup
}

function isFaultDescriptionLookupQueryImpl(
  query: string,
  memo?: Pick<QueryAnalysisMemo, 'faultCodes' | 'turbineFaultDescription'>,
): boolean {
  const normalized = String(query || '').trim()
  if (!normalized) return false
  if (isNonFaultMeasurementOrRatingQuestion(normalized)) return false
  if (isStrictFaultLookupQuery(normalized)) return false
  if (memo?.turbineFaultDescription ?? isTurbineFaultDescriptionQueryImpl(normalized)) {
    return true
  }
  const faultCodes = memo?.faultCodes ?? extractFaultCodesImpl(normalized)
  if (faultCodes.length > 0) return false
  if (isBareCodeQuery(normalized)) return false
  if (isMultiFaultCodeQuestion(normalized)) return false
  if (isEmbeddedFaultCodeQuestion(normalized)) return false
  if (hasFaultNameToCodeIntent(normalized)) return false
  if (/^(怎么处理|如何处理|怎么复位|如何复位|排查方法|维修方法|处理步骤)/i.test(normalized)) {
    return false
  }
  const lookup = normalizeFaultCodeLookupQuery(normalized)
  if (lookup.length < 2) return false
  return isLikelyStructuredFaultQuestion(normalized) || isFaultDescriptionSubject(normalized)
}

function isFaultDescriptionSubject(query: string): boolean {
  return /(故障|异常|错误|出错|问题|报警|告警|失效|损坏|丢失|断开|超限|过高|过低|不足|不够|缺少|通讯|通信|反馈|扭缆|纽缆|绕缆|润滑|温度|压力|振动|超速|跳闸|超级电容|风速仪|齿轮箱|偏航|变桨|发电机|轴承|主控|变流器|canopen|电源|开关|急停|刹车|制动|超速|欠压|过压|电流|电压|叶片|轮毂|机舱|塔底|塔基|冷却|加热|滤芯|编码器|传感器|接近开关|断路器|接触器|熔断|保险|供电|维护|计数|模块|火灾|手动停机|Safety|按钮|停机)/i.test(
    query,
  )
}

function faultDescriptionLookupMinLength(query: string): number {
  return isFaultDescriptionLookupQuery(query) ? 2 : 4
}

function isFaultCodeLookupQuery(query: string): boolean {
  const normalized = query.trim()
  if (!normalized) return false
  if (extractFaultCodes(query).some(code => !isNumericInFaultNameLookup(query, code))) return false
  if (isFaultDescriptionLookupQuery(query)) return true
  const coreFaultNameQuery = extractCoreFaultNameQuery(query)
  if (hasFaultNameToCodeIntent(normalized) && coreFaultNameQuery.length >= 2) {
    return true
  }
  return (
    /(故障码|故障代码|报码|告警码|报警码|状态代码).*(是什么|多少|哪些|有啥|对应|查询|查|找)/i.test(normalized) ||
    /(是什么|多少|哪些|有啥|对应|查询|查|找).*(故障码|故障代码|报码|告警码|报警码|状态代码)/i.test(normalized)
  )
}

function stripTurbineLocationContextFromQuery(query: string): string {
  let stripped = String(query || '')
  const site = extractSiteFromText(stripped)
  if (site) {
    stripped = stripped.replace(new RegExp(escapeRegExp(site), 'giu'), ' ')
    stripped = stripped.replace(/风场|风电场|场站/giu, ' ')
  }
  for (const turbineId of extractTurbineIdsFromText(stripped)) {
    stripped = stripped.replace(new RegExp(escapeRegExp(turbineId), 'giu'), ' ')
  }
  stripped = stripped
    .replace(/(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])/giu, ' ')
    .replace(/(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|风机|机组)[:：]?/giu, ' ')
    .replace(/[？?，,。.、:：；;\s]+/g, ' ')
    .trim()
  return stripped
}

function normalizeFaultCodeLookupQuery(query: string): string {
  let source = extractCoreFaultNameQuery(query) || query
  if (
    isTurbineFaultDescriptionQuery(query) ||
    extractTurbineIdsFromText(query).length > 0 ||
    Boolean(extractSiteFromText(query))
  ) {
    source = stripTurbineLocationContextFromQuery(source)
  }
  return normalizeFaultVariantText(
    source
    .replace(/^(帮我|给我|请|麻烦)?\s*/i, '')
    .replace(/(是什么故障造成的|什么故障造成的|是什么原因造成的|什么原因造成的|由什么造成|什么造成的|什么造成|导致的|引起的)/gi, '')
    .replace(/(对应|相关|所有|全部|可能|有没有|有无|有哪些|哪些|有啥|多少|是什么|是啥|什么|哪个|哪种|哪家|哪款|查询|查找|查|找|列出|给出|告诉我)/gi, '')
    .replace(/(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因|是否存在|存在|出现|发生)/gi, '')
    .replace(/(风场|风电场|场站|机型|型号|品牌|厂家|系列|地方|哪里)/gi, '')
    .replace(/(故障码|故障代码|报码|告警码|报警码|状态代码)/gi, '')
    // Only strip trailing generic suffixes — mid-name「故障」(e.g. 处于故障状态) must stay.
    .replace(/(?:故障|代码)$/gi, '')
    .replace(/(?<![编解译密数条])码$/gi, '')
    .replace(/有(?![功效])/gi, '')
    .replace(/不存在的|不存在|随便|乱写|假的|虚构/gi, '')
    .replace(/坏了/g, '故障')
    .replace(/([缆仪器])了$/g, '$1')
    .replace(/的/g, '')
    .replace(/[？?，,。.、:：\s]/g, ''),
  )
    .trim()
}

function displayFaultLookupText(query: string): string {
  const core = extractCoreFaultNameQuery(query)
  if (core) return cleanDisplayFaultLookupText(core)
  if (isFaultDescriptionLookupQuery(query)) {
    const lookup = normalizeFaultCodeLookupQuery(query)
    return cleanDisplayFaultLookupText(lookup || query)
  }
  if (isFaultCodeLookupQuery(query)) {
    return normalizeFaultCodeLookupQuery(query)
  }
  if (
    !isFaultCodeLookupQuery(query) &&
    extractFaultCodes(query).length === 0 &&
    isLikelyStructuredFaultQuestion(query)
  ) {
    return cleanDisplayFaultLookupText(query)
  }
  return normalizeFaultCodeLookupQuery(query)
}

function cleanDisplayFaultLookupText(value: string): string {
  return normalizeFaultVariantText(value)
    .replace(/\s+/g, '')
    .replace(/[的之]+$/g, '')
    .trim()
}

function isStrictFaultLookupQuery(query: string): boolean {
  return /(不存在的|不存在|随便|乱写|假的|虚构)/i.test(query)
}

function extractCoreFaultNameQuery(query: string): string {
  const normalized = query.trim()
  if (!normalized) return ''
  if (isBareCodeQuery(normalized)) return ''
  if (isExplicitLeadingFaultCodeQuestion(normalized)) return ''
  const leadingCodes = extractFaultCodes(normalized)
  if (
    leadingCodes.length === 1 &&
    queryContainsFaultCodeReference(normalized, leadingCodes[0] ?? '')
  ) {
    return ''
  }
  if (
    leadingCodes.length === 1 &&
    (isThisCodeReferenceQuestion(normalized, leadingCodes[0] ?? '') ||
      isDimensionQualifiedFaultCodeQuery(normalized) ||
      /(?:这个|该|此)\s*故障码|故障码\s*(?:在|对应|属于)/i.test(normalized))
  ) {
    return ''
  }

  let cleaned = normalized
    .replace(/^\s*(?:啥码|什么码)\s*/i, '')
    .replace(/^\s*(故障名称|故障名|名称|输入|搜索|查询|查一下|查下|查|检索|搜一下|搜下|搜)[:：]?\s*/i, '')
    .replace(/^\s*(故障名称|故障名|名称)[:：]?\s*/i, '')
    .replace(/\s*(?:查不到|搜不到|搜索不到|检索不到|查不出来|搜不出来|没有结果|没结果|找不到|未找到|匹配不到|无法匹配)\s*$/i, '')
    .replace(/\s*(?:有哪些故障码|有什么故障码|是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|会报哪些码|会报什么码|会出啥码|会出什么码|报哪些码|报啥码|报什么码|报啥|报什么|报码|告警码|报警码)(?:，?(?:哪些|有哪些)(?:风场|风电场|场站|机型|型号)(?:有)?)?\s*$/i, '')
    .replace(/\s*(?:(?:哪些|有哪些)(?:风场|风电场|场站|机型|型号)(?:有)?|哪些地方有|哪里有)\s*$/i, '')
    .replace(/\s*(?:是什么故障造成的|什么故障造成的|是什么原因造成的|什么原因造成的|由什么造成|什么造成的|怎么处理|如何处理|怎样处理|咋处理|咋整|处理方法|维修方法|排查方法|怎么复位|如何复位|为什么会报|为何会报|为啥会报|原因是什么|什么原因|啥意思|什么意思|是什么鬼)\s*$/i, '')
    .replace(/^[“"'「『【\[\(（]+|[”"'」』】\]\)）。.，,；;：:\s]+$/g, '')
    .trim()

  if (
    cleaned &&
    cleaned !== normalized &&
    (
      /(是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|有什么故障码|会报哪些码|会报什么码|会出啥码|会出什么码|报哪些码|报啥码|报什么码|报啥|报什么|报码|告警码|报警码|(?:^|\s)啥码(?:\s|$))/i.test(normalized) ||
      /(故障|报警|告警|停机|异常|错误|出错|问题|超限|过高|过低|异常|短路|断路|丢失|失败|错误|问题|通讯|通信|振动|传感器|设定值|温度|压力|电流|电压|频率|转速|功率|电池|桨叶|变桨|偏航|刹车|制动|主控|变流器|变频器|齿轮箱|轴\d|\d轴|扭缆|纽缆|风速仪|风速|反馈|供电|维护|计数|模块|火灾|Safety|按钮|状态)/.test(cleaned)
    )
  ) {
    return cleaned
  }

  const match = normalized.match(
    /(?:输入|搜索|查询|查一下|查下|查|检索|搜一下|搜下|搜)\s*([^\n，,。；;：:]{3,100}?(?:故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败|通讯|通信)[^\n，,。；;：:]{0,60})/i,
  )
  if (match?.[1]) {
    cleaned = match[1].trim().replace(/^[“"'「『【\[\(（]+|[”"'」』】\]\)）。.，,；;：:\s]+$/g, '')
    return cleaned
  }
  return ''
}

function searchTermSourceForQuery(query: string): string {
  const lookup = normalizeFaultCodeLookupQuery(query)
  if (lookup.length >= 3) return lookup
  const core = extractCoreFaultNameQuery(query)
  if (core.length >= 3) return core
  return query
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
  const primaryHaystack = lookupPrimaryHaystack(record)
  const compactPrimaryHaystack = compactFaultLookupText(primaryHaystack)
  const exactTextHaystacks = faultRecordLookupNameFields(record).map(compactFaultLookupText)
  const secondaryHaystack = normalizeFaultVariantText([
    record.reason,
    record.solution,
    record.logic,
    record.text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase())

  let normalizedLookup = lookupText.toLowerCase()
  for (const brand of KNOWN_FAULT_BRANDS) {
    normalizedLookup = normalizedLookup.replaceAll(brand.toLowerCase(), '')
  }
  normalizedLookup = normalizedLookup.trim()
  if (normalizedLookup.length < 2) return false
  if (isTemperatureFamilyLookup(normalizedLookup)) {
    return faultRecordMatchesTemperatureFamilyLookup(record, normalizedLookup)
  }
  if (faultRecordMatchesTemperatureFamilyLookup(record, normalizedLookup)) return true
  const lookupVariants = faultLookupVariants(normalizedLookup, query)
  const variantTerms = lookupVariantTerms(lookupVariants)
  const terms = variantTerms.flat()
  const uniqueTerms = [...new Set(terms)]
  if (uniqueTerms.length === 0) return false
  if (lookupVariants.some(variant => exactTextHaystacks.includes(compactFaultLookupText(variant)))) return true
  if (lookupVariants.some(variant => primaryHaystack.includes(variant))) return true
  if (lookupVariants.some(variant => compactPrimaryHaystack.includes(compactFaultLookupText(variant)))) return true
  if (lookupVariants.some(variant => primaryHaystack.includes(stripFaultSuffix(variant)))) return true
  if (lookupVariants.some(variant => compactPrimaryHaystack.includes(compactFaultLookupText(stripFaultSuffix(variant))))) return true
  if (lookupVariantTermsMatch(variantTerms, compactPrimaryHaystack)) return true
  const matchTerms = lookupMatchTerms(query, uniqueTerms)
  if (matchTerms.every(term => primaryHaystack.includes(term))) return true
  if (matchTerms.every(term => compactPrimaryHaystack.includes(compactFaultLookupText(term)))) return true
  if (
    lookupVariants.some(
      variant =>
        variant !== normalizedLookup &&
        variant.length >= 4 &&
        primaryHaystack.includes(variant),
    )
  ) {
    return true
  }
  if (/(故障|异常|报警|告警|错误|问题)$/u.test(normalizedLookup)) return false
  return matchTerms.every(term => secondaryHaystack.includes(term))
}

function faultRecordNameMatchesLookupQuery(record: FaultRecord, query: string): boolean {
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

  let normalizedLookup = normalizedLookupForBrand
  for (const brand of KNOWN_FAULT_BRANDS) {
    normalizedLookup = normalizedLookup.replaceAll(brand.toLowerCase(), '')
  }
  normalizedLookup = normalizedLookup.trim()
  if (normalizedLookup.length < 2) return false

  const primaryHaystack = lookupPrimaryHaystack(record)
  const compactPrimaryHaystack = compactFaultLookupText(primaryHaystack)
  const exactTextHaystacks = faultRecordLookupNameFields(record).map(compactFaultLookupText)
  if (isTemperatureFamilyLookup(normalizedLookup)) {
    return faultRecordMatchesTemperatureFamilyLookup(record, normalizedLookup)
  }
  const lookupVariants = faultLookupVariants(normalizedLookup, query)
  const variantTerms = lookupVariantTerms(lookupVariants)
  const terms = variantTerms.flat()
  const uniqueTerms = [...new Set(terms)]
  if (uniqueTerms.length === 0) return false
  if (lookupVariants.some(variant => exactTextHaystacks.includes(compactFaultLookupText(variant)))) return true
  if (lookupVariants.some(variant => primaryHaystack.includes(variant))) return true
  if (lookupVariants.some(variant => compactPrimaryHaystack.includes(compactFaultLookupText(variant)))) return true
  if (lookupVariants.some(variant => primaryHaystack.includes(stripFaultSuffix(variant)))) return true
  if (lookupVariants.some(variant => compactPrimaryHaystack.includes(compactFaultLookupText(stripFaultSuffix(variant))))) return true
  if (lookupVariantTermsMatch(variantTerms, compactPrimaryHaystack)) return true
  const matchTerms = lookupMatchTerms(query, uniqueTerms)
  return matchTerms.every(term => primaryHaystack.includes(term))
    || matchTerms.every(term => compactPrimaryHaystack.includes(compactFaultLookupText(term)))
}

function lookupVariantTerms(lookupVariants: string[], query = ''): string[][] {
  const variantTermSets = lookupVariants
    .map(variant =>
      (variant.match(/[a-z0-9_.#/-]+|[\u4e00-\u9fff]{2,}/g) ?? [])
        .filter(
          term =>
            !FAULT_CODE_LOOKUP_STOP_WORDS.has(term) &&
            !FAULT_DESCRIPTION_WEAK_TERMS.has(term),
        )
        .map(compactFaultLookupText),
    )
    .filter(terms => terms.length > 0)

  if (isFaultDescriptionLookupQuery(query)) {
    for (const variant of lookupVariants) {
      const componentTerms = descriptionLookupComponentTerms(variant)
      if (componentTerms.length > 0) variantTermSets.push(componentTerms)
    }
  }

  return variantTermSets
}

function lookupVariantTermsMatch(variantTerms: string[][], haystack: string): boolean {
  return variantTerms.some(terms =>
    terms.length > 0 && terms.every(term => haystack.includes(term)),
  )
}

function faultRecordMatchesTemperatureFamilyLookup(record: FaultRecord, normalizedLookup: string): boolean {
  if (!isTemperatureFamilyLookup(normalizedLookup)) return false
  const requiredComponents = temperatureLookupComponents(normalizedLookup)
  if (requiredComponents.length === 0) return false
  const nameHaystack = compactFaultLookupText(record.name || '')
  if (!/(温度|过热|高温|过温|超温|超限)/.test(nameHaystack)) return false
  return requiredComponents.every(component => nameHaystack.includes(component))
}

function isTemperatureFamilyLookup(normalizedLookup: string): boolean {
  return /(温度|过热|高温|过温|超温|超限)/.test(normalizedLookup)
}

function temperatureLookupComponents(normalizedLookup: string): string[] {
  const components: string[] = []
  for (const component of ['发电机', '轴承', '齿轮箱', '变流器', '变频器', '主轴', '液压', '机舱']) {
    if (normalizedLookup.includes(component)) components.push(component)
  }
  return components
}

function faultRecordExactNameMatchesLookupQuery(record: FaultRecord, query: string): boolean {
  const lookup = normalizedLookupWithoutBrand(query)
  if (!lookup) return false
  const normalizedLookupForBrand = normalizeFaultCodeLookupQuery(query).toLowerCase()
  for (const brand of KNOWN_FAULT_BRANDS) {
    if (
      normalizedLookupForBrand.includes(brand.toLowerCase()) &&
      !record.brand.toLowerCase().includes(brand.toLowerCase())
    ) {
      return false
    }
  }

  const names = faultRecordLookupNameFields(record)
    .map(value => normalizeFaultVariantText(String(value || '').toLowerCase()))
    .map(value => value.replace(/[？?，,。.、:：；;\s]/g, ''))
    .filter(Boolean)
  const lookupVariants = faultLookupVariants(lookup, query)
    .map(value => value.replace(/[？?，,。.、:：；;\s]/g, ''))
    .filter(Boolean)
  return names.some(name =>
    lookupVariants.some(variant => {
      if (name === variant || name === stripFaultSuffix(variant)) return true
      const canonicalName = name.replace(/故障/g, '')
      const canonicalVariant = variant.replace(/故障/g, '')
      return canonicalName.length >= 4 && canonicalName === canonicalVariant
    }),
  )
}

function normalizedLookupWithoutBrand(query: string): string {
  let normalizedLookup = normalizeFaultCodeLookupQuery(query).toLowerCase()
  for (const brand of KNOWN_FAULT_BRANDS) {
    normalizedLookup = normalizedLookup.replaceAll(brand.toLowerCase(), '')
  }
  return normalizedLookup.trim()
}

function lookupPrimaryHaystack(record: FaultRecord): string {
  const fields = parseChineseFields(record.text)
  return normalizeFaultVariantText([
    record.name,
    record.description,
    field(fields, '描述', '中文描述', '故障描述', '故障描述/现象', '故障名称', '故障名称(中文)', '故障名', '中文名称'),
    record.system,
    record.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase())
}

function faultRecordLookupNameFields(record: FaultRecord): string[] {
  const fields = parseChineseFields(record.text)
  return [
    record.name,
    record.description,
    field(fields, '描述', '中文描述', '故障描述', '故障描述/现象', '故障名称', '故障名称(中文)', '故障名', '中文名称', '故障解释', '解释', '故障信息'),
  ].filter(Boolean)
}

function compactFaultLookupText(value: string): string {
  return normalizeFaultVariantText(value)
    .toLowerCase()
    .replace(/[？?，,。.、:：；;\s]/g, '')
}

function faultLookupVariants(normalizedLookup: string, query = ''): string[] {
  const variants = [normalizedLookup, stripFaultSuffix(normalizedLookup)]
  const removablePrefixes = ['风机', '机组', '变桨', '偏航', '机舱', '塔基', '塔底']
  const removableContext = ['电池', '蓄电池', '后备电源']
  const preserveComponentPrefixes = isFaultDescriptionLookupQuery(query)

  if (!preserveComponentPrefixes) {
    for (const prefix of removablePrefixes) {
      for (const variant of [...variants]) {
        if (variant.startsWith(prefix)) variants.push(variant.slice(prefix.length))
      }
    }
  }

  for (const context of removableContext) {
    for (const variant of [...variants]) {
      variants.push(variant.replaceAll(context, ''))
    }
  }

  for (const variant of [...variants]) {
    if (variant.endsWith('异常')) {
      variants.push(`${variant.slice(0, -2)}故障`)
    }
    if (variant.endsWith('故障')) {
      variants.push(`${variant.slice(0, -2)}异常`)
    }
  }

  for (const variant of [...variants]) {
    if (!variant.includes('不足')) continue
    variants.push(variant.replaceAll('不足', '液位低'))
    variants.push(variant.replaceAll('不足', '缺脂'))
    variants.push(variant.replaceAll('不足', '低油位'))
    variants.push(variant.replaceAll('不足', '缺油'))
    variants.push(variant.replaceAll('不足', '加脂'))
  }

  return [...new Set(variants.map(stripFaultSuffix).concat(variants))]
    .map(variant => variant.trim())
    .filter(variant => variant.length >= 2)
}

function stripFaultSuffix(value: string): string {
  return value.replace(/(故障|异常|报警|告警|错误|问题)$/u, '')
}

function stripLookupContextTerms(value: string): string {
  let stripped = value
  for (const term of LOOKUP_CONTEXT_TERMS) {
    stripped = stripped.replaceAll(term, '')
  }
  return stripped
}

const FAULT_CODE_LOOKUP_STOP_WORDS = new Set([
  '故障',
  '异常',
  '报警',
  '告警',
  '问题',
  '代码',
])

const FAULT_DESCRIPTION_WEAK_TERMS = new Set([
  '不足',
  '不够',
  '缺少',
  '缺',
  '偏低',
  '过高',
  '过低',
  '偏高',
  '异常',
  '故障',
  '报警',
  '告警',
  '问题',
  '错误',
])

const FAULT_DESCRIPTION_COMPONENT_TERMS = [
  'canopen',
  '变桨',
  '偏航',
  '齿轮箱',
  '发电机',
  '轴承',
  '润滑',
  '扭缆',
  '纽缆',
  '绕缆',
  '通讯',
  '通信',
  '温度',
  '压力',
  '风速仪',
  '超级电容',
  '变流器',
  '变频器',
  '主轴',
  '液压',
  '机舱',
  '塔基',
  '叶片',
  '轮毂',
  '急停',
  '刹车',
  '制动',
  '主控',
  '电源',
  '开关',
  '编码器',
  '传感器',
  '接近开关',
  '断路器',
  '接触器',
  '滤芯',
  '冷却',
  '加热',
  '振动',
  '超速',
  '跳闸',
  '反馈',
  '液位',
  '缺脂',
  '低油位',
  '阻塞',
  '堵塞',
]

function descriptionLookupComponentTerms(normalizedLookup: string): string[] {
  const lookup = compactFaultLookupText(normalizedLookup)
  const terms: string[] = []
  let rest = lookup
  for (const component of FAULT_DESCRIPTION_COMPONENT_TERMS) {
    const compactComponent = compactFaultLookupText(component)
    if (!compactComponent || !rest.includes(compactComponent)) continue
    terms.push(compactComponent)
    rest = rest.replaceAll(compactComponent, '')
  }
  const leftover = rest
    .replace(/不足|不够|缺少|异常|故障|报警|告警|问题|错误/g, '')
    .trim()
  if (leftover.length >= 2 && !FAULT_DESCRIPTION_WEAK_TERMS.has(leftover)) {
    terms.push(leftover)
  }
  return [...new Set(terms.filter(term => term.length >= 2))]
}

function lookupMatchTerms(query: string, uniqueTerms: string[]): string[] {
  if (!isFaultDescriptionLookupQuery(query)) return uniqueTerms
  const normalizedLookup = normalizeFaultCodeLookupQuery(query).toLowerCase()
  const componentTerms = descriptionLookupComponentTerms(normalizedLookup)
  if (componentTerms.length > 0) return componentTerms
  const primaryTerms = lookupVariantTerms([
    normalizedLookup,
  ], query).flat()
  const filtered = primaryTerms.filter(
    term => term.length >= 2 && !FAULT_DESCRIPTION_WEAK_TERMS.has(term),
  )
  if (filtered.length > 0) return filtered
  return primaryTerms.filter(term => term.length >= 2)
}

const GENERIC_FAULT_SEARCH_TERMS = new Set([
  '故障',
  '异常',
  '报警',
  '告警',
  '问题',
  '风机',
  '机组',
])

const LOOKUP_CONTEXT_TERMS = [
  '变桨',
  '偏航',
  '机舱',
  '塔基',
  '塔底',
  '风机',
  '机组',
]

const KNOWN_FAULT_BRANDS = [
  '华仪',
  '华锐',
  '三一',
  '上海电气',
  '中车山东',
  '运达',
  '明阳',
  '新誉',
  '歌美飒',
  '湘电',
  '远景',
  '金风',
]

const KNOWN_FAULT_SITES = [
  '团结',
  '洮北',
  '镇赉',
  '镇赍',
  '同发',
  '王玲山',
  '良井子',
  '新华',
  '四平',
  '通榆',
  '富荣',
  '福林',
  '裕民',
  '什花道',
  '向荣',
  '八面',
  '前进',
  '如意',
  '中溢',
  '长龙山',
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
        boundary: /\d/.test(normalized),
        weak,
      })
      return
    }
    if (required) current.required = true
  }

  const normalizedQuery = query.toLowerCase().trim()
  add(normalizedQuery, 30)
  const spacedCamelQuery = splitCamelCaseFaultText(query).toLowerCase().trim()
  if (spacedCamelQuery && spacedCamelQuery !== normalizedQuery) {
    add(spacedCamelQuery, 36)
  }
  const corePhrase = normalizeFaultSearchPhrase(normalizedQuery)
  if (corePhrase && corePhrase !== normalizedQuery) {
    add(corePhrase, 70)
  }

  for (const match of normalizedQuery.matchAll(/[a-z]?\d[\w_.-]{2,}/g)) {
    const start = match.index ?? 0
    if (
      !faultCodeMatchHasTokenBoundary(
        normalizedQuery,
        start,
        start + match[0].length,
      )
    ) {
      continue
    }
    const code = match[0]
    const digitCount = (code.match(/\d/g) ?? []).length
    add(code, digitCount >= 3 ? 80 : 18, digitCount >= 3)
  }

  for (const part of [
    ...(normalizedQuery.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []),
    ...(spacedCamelQuery.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? []),
  ]) {
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

function splitCamelCaseFaultText(value: string): string {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
}

function scoreQueryCoverage(content: string, terms: SearchTerm[]): number {
  const strongTerms = componentSearchTerms(
    terms.filter(term => !term.weak && !term.numeric),
  )
  if (strongTerms.length < 2) return 0

  const normalizedContent = content.toLowerCase()
  const matched = strongTerms.filter(term => termMatches(normalizedContent, term))
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
    const index = termIndexOf(content, term, cursor)
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
    .map(term => termIndexOf(value, term))
    .filter(index => index >= 0)
  return indexes.length > 0 ? Math.min(...indexes) : -1
}

function countOccurrences(value: string, term: SearchTerm): number {
  if (term.boundary) {
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

function termMatches(value: string, term: SearchTerm): boolean {
  return countOccurrences(value, term) > 0
}

function termIndexOf(value: string, term: SearchTerm, fromIndex = 0): number {
  if (!term.boundary) return value.indexOf(term.value, fromIndex)
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(term.value)}(?=[^a-z0-9]|$)`, 'gi')
  pattern.lastIndex = fromIndex
  const match = pattern.exec(value)
  if (!match) return -1
  return match.index + (match[1] ? match[1].length : 0)
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

// Cache for collectFiles to avoid repeated directory traversal.
// Keyed by stringified paths array. TTL = 5 seconds.
const collectFilesCache = new Map<string, { files: string[], timestamp: number }>()
const COLLECT_FILES_CACHE_TTL = 5000

async function collectFiles(
  paths: string[],
  seen = new Set<string>(),
): Promise<string[]> {
  const cacheKey = JSON.stringify(paths)
  const now = Date.now()
  const cached = collectFilesCache.get(cacheKey)
  if (cached && now - cached.timestamp < COLLECT_FILES_CACHE_TTL) {
    return cached.files
  }

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

  const sortedFiles = files.sort((a, b) => a.localeCompare(b))
  collectFilesCache.set(cacheKey, { files: sortedFiles, timestamp: now })
  return sortedFiles
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
  )
  const selectedTerms =
    looseTerms.length > 0 ? looseTerms : terms
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
      term => termMatches(pathLower, term) || termMatches(lower, term),
    )
    if (matchedTerms.length === 0) continue

    const score =
      matchedTerms.reduce((sum, term) => sum + Math.max(1, term.value.length), 0) +
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

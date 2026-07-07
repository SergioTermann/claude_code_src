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
  reason: string
  solution: string
  reset: string
  logic: string
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
  systems: string[]
  categories: string[]
  reasons: string[]
  solutions: string[]
  resets: string[]
  logics: string[]
  locations: string[]
  records: FaultRecord[]
}

type WindOpsCase = {
  turbineId: string
  system: string
  component: string
  faultCode: string
  timeWindow: string
  missing: string[]
}

type MechanismGraph = {
  nodes?: MechanismNode[]
  edges?: MechanismEdge[]
}

type MechanismNode = {
  id: string
  type: string
  label: string
  aliases?: string[]
  count?: number
  properties?: Record<string, unknown>
}

type MechanismEdge = {
  id?: string
  source: string
  target: string
  type: string
  weight?: number
  evidence?: string[]
}

type MechanismCandidate = {
  node: MechanismNode
  score: number
  evidence: string[]
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
const FAULT_MECHANISM_GRAPH_FILE = join(
  'graph',
  'fault-mechanism',
  'knowledge-graph.json',
)
const MAX_SEARCH_FILES = 10000
const MAX_SEARCH_RESULTS = 12
const MAX_READ_CHARS = 30000
const MAX_LIST_ITEMS = 80
const DEFAULT_TREE_DEPTH = 2

function buildWindOpsCase(query: string, record?: FaultRecord): WindOpsCase {
  const text = String(query || '')
  const turbineMatch = text.match(/(?:WTG[-_ ]?)?0*(\d+)\s*(?:号机|#|机组)?/i)
  const recordSystem = record?.system || ''
  const system =
    recordSystem ||
    (/变桨|pitch/i.test(text) ? '变桨系统' :
    /偏航|yaw/i.test(text) ? '偏航系统' :
    /齿轮箱|油温|滤芯|润滑/i.test(text) ? '齿轮箱系统' :
    /发电机|绕组|轴承温度/i.test(text) ? '发电机系统' :
    /液压|制动|刹车|压力/i.test(text) ? '液压/制动系统' :
    /变流|变频|IGBT/i.test(text) ? '变流系统' :
    /通信|通讯|CAN|Profibus|EtherCAT/i.test(text) ? '通信系统' :
    '待识别')
  const component =
    /24\s*v|24V/i.test(text) ? '24V 控制电源/反馈回路' :
    /传感器|编码器/i.test(text) ? '传感器/编码器与采集回路' :
    /阀|泵|蓄能器|压力/i.test(text) ? '液压阀组/泵/压力回路' :
    /接触器|断路器|开关/i.test(text) ? '开关/接触器/断路器反馈回路' :
    record?.category || '待识别'
  const timeWindow =
    text.match(/近\s*\d+\s*(?:分钟|小时)|last[_ -]?\d+\w*/i)?.[0] ||
    (/昨天|今日|今天|刚才|当前|现在/.test(text) ? '当前/近期窗口' : '待补充')
  const missing: string[] = []
  if (!turbineMatch) missing.push('风机ID')
  if (system === '待识别') missing.push('系统/部件')
  if (!record?.code && !extractFaultCodes(text).length) missing.push('故障码')
  if (timeWindow === '待补充') missing.push('运行时间窗')
  if (!/(风速|停机|限功率|复位|作业票|HMI|SCADA|CMS)/i.test(text)) {
    missing.push('运行状态/安全条件')
  }
  return {
    turbineId: turbineMatch ? `WTG-${String(turbineMatch[1]).padStart(3, '0')}` : '待补充',
    system,
    component,
    faultCode: record?.code || extractFaultCodes(text)[0] || '待补充',
    timeWindow,
    missing,
  }
}

function renderWindOpsCaseLines(query: string, record?: FaultRecord): string[] {
  const faultCase = buildWindOpsCase(query, record)
  const missing = faultCase.missing.length ? faultCase.missing.join('、') : '无明显缺口'
  return [
    '结构化Case：',
    `- 风机：${faultCase.turbineId}`,
    `- 系统/部件：${faultCase.system} / ${faultCase.component}`,
    `- 故障码：${faultCase.faultCode}`,
    `- 时间窗：${faultCase.timeWindow}`,
    `- 待补充：${missing}`,
  ]
}

function renderWindOpsPlanLines(query: string, record?: FaultRecord): string[] {
  const action =
    record?.solution ||
    (/24\s*v|24V/i.test(query) ? '先读取24V电压曲线、充电器状态和开关/PLC反馈。' :
    /压力|液压|制动|刹车/i.test(query) ? '先对齐机械压力表、HMI压力和建压/保压曲线。' :
    '先确认告警时间窗、当前状态和伴随告警。')
  return [
    'Planner诊断路径：',
    '1. 确认风机ID、机型、控制器版本、当前停机/限功率状态。',
    '2. 拉取CMS/SCADA时间窗趋势和告警平台伴随告警。',
    '3. 检索故障码表、厂家手册、场站SOP和已关闭历史工单。',
    `4. 下一步只做一件事：${action}`,
    '5. 将验证结果写入工单草稿，等待现场反馈后再收敛根因。',
  ]
}

function renderSafetyGateLines(): string[] {
  return [
    'Safety Gate：',
    '- 复位、启停机、参数调整、登塔、开柜、带电作业只生成建议，不直连执行。',
    '- 执行前必须确认作业票、风速、停机状态、人员权限和二次确认。',
  ]
}

function renderEvidencePriorityLines(): string[] {
  return [
    '证据分级：厂家手册/故障码表 > 场站SOP > 专家知识 > 已关闭历史工单 > 未验证经验。',
  ]
}

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
      case 'trace':
      case 'pathway':
        return text(
          await traceQuestionPath(
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
    '  /llmwiki trace <question>',
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

  if (shouldRenderAmbiguousFaultAnswer(query, matches)) {
    return renderAmbiguousFaultAnswer(query, matches)
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
  const files = await collectFiles(searchableRoots)
  const terms = buildSearchTerms(query)
  const structuredMatches = await collectStructuredFaultMatches(
    project,
    files,
    query,
    terms,
    limit,
  )
  if (isFaultCodeQuery(query)) {
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

  return [...structuredMatches, ...results]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function renderSearchMatch(match: SearchMatch): string {
  return `${match.location}\n${match.snippet}`
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

  if (shouldRenderAmbiguousFaultAnswer(query, matches)) {
    return renderAmbiguousFaultAnswer(query, matches)
  }

  const primary = matches[0]
  const fields = parseChineseFields(primary.snippet)
  const code = primary.record?.code || faultCodeFromFields(fields)
  const name = cleanFaultName(primary.record?.name || faultNameFromFields(fields))
  const reason = primary.record?.reason || field(fields, '故障原因')
  const solution =
    primary.record?.solution ||
    field(fields, '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位')
  const reset =
    primary.record?.reset ||
    field(fields, '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3')
  const logic = primary.record?.logic || field(fields, '故障逻辑')
  const site = primary.record?.site || field(fields, '风场')
  const brand = primary.record?.brand || field(fields, '品牌')
  const model = primary.record?.model || field(fields, '机型')

  const lines = [
    `本地答案：${query}`,
    '',
    code && name
      ? `结论：${code} 为「${name}」。`
      : `结论：本地知识库命中 ${matches.length} 条相关资料。`,
    ...renderWindOpsCaseLines(query, primary.record),
    site || brand || model
      ? `对象：${[site, brand, model].filter(Boolean).join(' / ')}`
      : '',
    reason ? `原因：${reason}` : '',
    solution ? `处理：${solution}` : '',
    reset ? `复位：${reset}` : '',
    logic ? `逻辑：${logic}` : '',
    ...renderWindOpsPlanLines(query, primary.record),
    ...renderSafetyGateLines(),
    ...renderEvidencePriorityLines(),
    `来源：${primary.location}`,
  ].filter(Boolean)

  if (!reason && !solution && !name) {
    lines.push('', '原始命中：', primary.snippet)
  }

  const extraSources = relatedSupplementalMatches(primary, matches)
    .slice(0, 3)
    .map(match => `- ${match.location}`)
  if (extraSources.length > 0) {
    lines.push('', '补充来源：', ...extraSources)
  }

  return lines.join('\n')
}

async function traceQuestionPath(
  project: LLMWikiProject,
  query: string,
  limit = 5,
): Promise<string> {
  if (!query) return 'Usage: /llmwiki trace <question>'

  const graph = await loadMechanismGraph(project.path)
  if (!graph) {
    return [
      `推理路径：${query}`,
      '',
      `缺少故障-机理图谱：${FAULT_MECHANISM_GRAPH_FILE}`,
      '请先运行：npm run build:fault-mechanism',
    ].join('\n')
  }

  const files = await collectFiles([await getContentRoot(project.path)])
  const terms = buildSearchTerms(query)
  const matches = await collectSearchMatches(project, query, limit)
  const records = matches.map(match => match.record).filter(isFaultRecord)
  const candidateMechanisms = rankMechanismsForTrace(graph, query, records, limit)
  const primaryMechanism = candidateMechanisms[0]?.node
  const primaryRecord = records[0]

  const lines = [
    `可视推理路径：${query}`,
    '',
    '说明：这里展示的是检索证据路径和图谱路径，不是模型内部思维过程。',
    '',
    '1. 问题入口',
    `   用户问题：${query}`,
    `   检索关键词：${formatTraceTerms(terms, query)}`,
    `   结构化Case：${renderWindOpsCaseLines(query, primaryRecord).slice(1).join('；')}`,
  ]

  if (records.length > 0) {
    lines.push('', '2. 本地故障命中')
    for (const record of records.slice(0, Math.min(limit, 5))) {
      lines.push(
        `   - ${record.code}${record.name ? `：${record.name}` : ''}`,
        `     对象：${[record.site, record.brand, record.model]
          .filter(Boolean)
          .join(' / ') || '未标注'}`,
        record.reason ? `     原因：${record.reason}` : '',
        record.solution ? `     处理：${record.solution}` : '',
        `     来源：${record.location}`,
      )
    }
  } else {
    lines.push('', '2. 本地故障命中', '   - 未命中具体故障码，改按元器件/机理关键词匹配。')
  }

  if (candidateMechanisms.length > 0) {
    lines.push('', '3. 元器件/机理节点')
    for (const candidate of candidateMechanisms.slice(0, Math.min(limit, 5))) {
      const details = mechanismDetails(graph, candidate.node)
      lines.push(
        `   - ${candidate.node.label}  score=${candidate.score.toFixed(1)}`,
        details.component ? `     元器件：${details.component}` : '',
        details.system ? `     系统：${details.system}` : '',
        candidate.evidence.length
          ? `     命中依据：${candidate.evidence.slice(0, 5).join('、')}`
          : '',
        details.summary ? `     机理：${details.summary}` : '',
      )
    }
  } else {
    lines.push('', '3. 元器件/机理节点', '   - 暂未匹配到机理节点。')
  }

  if (primaryMechanism) {
    const details = mechanismDetails(graph, primaryMechanism)
    const assessment = assessTraceCandidate(primaryMechanism, details, records, query)
    lines.push('', '4. 可执行路径')
    const pathRows = [
      ['用户问题', query],
      primaryRecord
        ? ['故障记录', `${primaryRecord.code}${primaryRecord.name ? ` ${primaryRecord.name}` : ''}`]
        : undefined,
      ['机理', primaryMechanism.label],
      details.component ? ['元器件', details.component] : undefined,
      ...details.signals.slice(0, 4).map(signal => ['诊断信号', signal] as const),
      ...details.actions.slice(0, 4).map(action => ['检查处理', action] as const),
      ...details.sources.slice(0, 3).map(source => ['来源依据', source] as const),
    ].filter(Boolean) as [string, string][]

    for (let index = 0; index < pathRows.length; index++) {
      const [label, value] = pathRows[index]!
      lines.push(`   ${index + 1}. ${label} -> ${value}`)
    }

    lines.push('', '5. 推理可信度与下一步')
    lines.push(
      `   可信度：${assessment.label} (${assessment.score}/100)`,
      `   依据：${assessment.reasons.join('；') || '仅命中图谱节点，现场证据不足'}`,
      '   Safety Gate：复位、启停机、参数调整、登塔、开柜、带电作业只生成建议，必须确认作业票、风速、停机状态、权限和二次确认。',
      `   下一步只做一件事：${assessment.nextAction}`,
      `   做完反馈：${assessment.feedback}`,
    )

    const followUps = traceFollowUpQuestions(query, primaryMechanism, details, assessment)
    if (followUps.length) {
      lines.push('', '6. 可继续追问')
      for (const followUp of followUps) lines.push(`   - ${followUp}`)
    }

    lines.push('', '7. Mermaid 可视图')
    lines.push('```mermaid')
    lines.push(...renderTraceMermaid(query, primaryRecord, primaryMechanism, details))
    lines.push('```')
  }

  if (matches.length > 0) {
    lines.push('', primaryMechanism ? '8. 其他检索来源' : '6. 其他检索来源')
    for (const match of matches.slice(0, Math.min(limit, 5))) {
      lines.push(`   - ${match.location}`)
    }
  }

  if (files.length === 0) {
    lines.push('', '提示：当前项目没有可读索引文件，trace 只使用了机理图谱。')
  }

  return lines.filter(line => line !== '').join('\n')
}

function assessTraceCandidate(
  mechanism: MechanismNode,
  details: ReturnType<typeof mechanismDetails>,
  records: FaultRecord[],
  query: string,
): {
  score: number
  label: string
  reasons: string[]
  nextAction: string
  feedback: string
} {
  const reasons: string[] = []
  let score = 20
  if (records.length) {
    score += 18
    reasons.push(`命中${records.length}条本地故障记录`)
  }
  if (details.component) {
    score += 12
    reasons.push(`图谱定位到元器件：${details.component}`)
  }
  if (details.summary) {
    score += 12
    reasons.push('存在机理摘要')
  }
  if (details.signals.length) {
    score += Math.min(18, details.signals.length * 6)
    reasons.push(`有${details.signals.length}项诊断信号`)
  }
  if (details.actions.length) {
    score += Math.min(15, details.actions.length * 5)
    reasons.push(`有${details.actions.length}项处理动作`)
  }
  if (/(压力|温度|电流|电压|反馈|跳闸|动作|掉线|报警|告警|故障码|代码)/.test(query)) {
    score += 10
    reasons.push('用户问题包含现场量或告警信号')
  }
  score = Math.min(95, score)
  const label = score >= 75 ? '较高可信' : score >= 55 ? '中等可信' : '待验证'
  return {
    score,
    label,
    reasons,
    nextAction: details.actions[0] || details.signals[0] || `先围绕${details.component || mechanism.label}核对现场实测值与控制反馈`,
    feedback: details.signals[0] || '反馈实测值、告警是否复现、处理前后状态变化',
  }
}

function traceFollowUpQuestions(
  query: string,
  mechanism: MechanismNode,
  details: ReturnType<typeof mechanismDetails>,
  assessment: ReturnType<typeof assessTraceCandidate>,
): string[] {
  return [
    details.signals[0] ? `${mechanism.label}，${details.signals[0]}正常时下一步查什么？` : '',
    details.actions[0] ? `${mechanism.label}，执行“${details.actions[0]}”后如何验证闭环？` : '',
    assessment.score < 75 ? `${mechanism.label}还缺哪些现场证据才能定根因？` : '',
    query.includes('预防') ? '' : `${mechanism.label}如何预防复发？`,
  ].filter(Boolean).slice(0, 4)
}

async function loadMechanismGraph(projectPath: string): Promise<MechanismGraph | null> {
  try {
    return JSON.parse(
      await readFile(join(projectPath, FAULT_MECHANISM_GRAPH_FILE), 'utf8'),
    ) as MechanismGraph
  } catch {
    return null
  }
}

function rankMechanismsForTrace(
  graph: MechanismGraph,
  query: string,
  records: FaultRecord[],
  limit: number,
): MechanismCandidate[] {
  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const queryText = normalizeTraceText(query)
  const recordKeys = new Set(
    records.flatMap(record => [
      normalizeTraceText(record.code),
      normalizeTraceText(record.name),
      normalizeTraceText(record.location),
    ]),
  )
  const scores = new Map<string, MechanismCandidate>()

  for (const edge of edges.filter(edge => edge.type === 'EXPLAINED_BY_MECHANISM')) {
    const fault = nodeById.get(edge.source)
    const mechanism = nodeById.get(edge.target)
    if (!fault || !mechanism || mechanism.type !== 'mechanism') continue
    const props = fault.properties ?? {}
    const values = [
      stringProp(props, 'code'),
      stringProp(props, 'name'),
      stringProp(props, 'source'),
      fault.label,
    ].map(normalizeTraceText)
    if (!values.some(value => recordKeys.has(value))) continue
    addMechanismScore(scores, mechanism, (edge.weight ?? 1) + 10, [
      `故障记录 ${stringProp(props, 'code') || fault.label}`,
      ...(edge.evidence ?? []),
    ])
  }

  for (const mechanism of nodes.filter(node => node.type === 'mechanism')) {
    const props = mechanism.properties ?? {}
    const searchable = [
      mechanism.label,
      stringProp(props, 'system'),
      stringProp(props, 'component'),
      stringProp(props, 'summary'),
      ...(mechanism.aliases ?? []),
    ]
    const evidence: string[] = []
    let score = 0
    for (const value of searchable) {
      const normalized = normalizeTraceText(value)
      if (!normalized) continue
      if (queryText.includes(normalized) || normalized.includes(queryText)) {
        score += 8
        evidence.push(value)
        continue
      }
      for (const token of traceTokens(value)) {
        if (token.length >= 2 && queryText.includes(token)) {
          score += token.length >= 4 ? 3 : 1
          evidence.push(value)
          break
        }
      }
    }
    if (score > 0) addMechanismScore(scores, mechanism, score, evidence)
  }

  for (const edge of edges) {
    if (
      ![
        'INVOLVES_COMPONENT',
        'DIAGNOSED_BY',
        'MITIGATED_BY',
        'MANIFESTS_AS',
        'CAN_TRIGGER',
      ].includes(edge.type)
    ) {
      continue
    }
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    const mechanism =
      source?.type === 'mechanism'
        ? source
        : target?.type === 'mechanism'
          ? target
          : null
    const other = source?.type === 'mechanism' ? target : source
    if (!mechanism || !other) continue
    const otherText = normalizeTraceText(
      `${other.label} ${stringProp(other.properties ?? {}, 'summary')}`,
    )
    if (!otherText || !traceTokens(query).some(token => otherText.includes(token))) {
      continue
    }
    addMechanismScore(scores, mechanism, 4, [other.label])
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label, 'zh-Hans-CN'))
    .slice(0, Math.max(limit, 5))
}

function addMechanismScore(
  scores: Map<string, MechanismCandidate>,
  node: MechanismNode,
  score: number,
  evidence: string[],
): void {
  const current =
    scores.get(node.id) ?? {
      node,
      score: 0,
      evidence: [],
    }
  current.score += score
  for (const item of evidence) pushUnique(current.evidence, item)
  scores.set(node.id, current)
}

function mechanismDetails(
  graph: MechanismGraph,
  mechanism: MechanismNode,
): {
  system: string
  component: string
  summary: string
  signals: string[]
  actions: string[]
  sources: string[]
} {
  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const connected = edges.filter(
    edge => edge.source === mechanism.id || edge.target === mechanism.id,
  )
  const labelsFor = (type: string, nodeType?: string): string[] =>
    connected
      .filter(edge => edge.type === type)
      .map(edge => nodeById.get(edge.source === mechanism.id ? edge.target : edge.source))
      .filter((node): node is MechanismNode => Boolean(node))
      .filter(node => !nodeType || node.type === nodeType)
      .map(node => node.label)

  return {
    system: labelsFor('BELONGS_TO_SYSTEM', 'system')[0] || stringProp(mechanism.properties ?? {}, 'system'),
    component:
      labelsFor('INVOLVES_COMPONENT', 'component')[0] ||
      stringProp(mechanism.properties ?? {}, 'component'),
    summary: stringProp(mechanism.properties ?? {}, 'summary'),
    signals: labelsFor('DIAGNOSED_BY', 'diagnostic_signal'),
    actions: labelsFor('MITIGATED_BY', 'mitigation'),
    sources: labelsFor('SUPPORTED_BY_SOURCE', 'source'),
  }
}

function renderTraceMermaid(
  query: string,
  record: FaultRecord | undefined,
  mechanism: MechanismNode,
  details: ReturnType<typeof mechanismDetails>,
): string[] {
  const lines = ['flowchart LR']
  lines.push(`  Q["问题：${mermaidLabel(query)}"]`)
  if (record) {
    lines.push(`  F["故障：${mermaidLabel(record.code)} ${mermaidLabel(record.name)}"]`)
    lines.push('  Q --> F')
    lines.push('  F --> M')
  } else {
    lines.push('  Q --> M')
  }
  lines.push(`  M["机理：${mermaidLabel(mechanism.label)}"]`)
  if (details.component) {
    lines.push(`  C["元器件：${mermaidLabel(details.component)}"]`)
    lines.push('  M --> C')
  }
  details.signals.slice(0, 3).forEach((signal, index) => {
    lines.push(`  S${index + 1}["诊断信号：${mermaidLabel(signal)}"]`)
    lines.push(`  M --> S${index + 1}`)
  })
  details.actions.slice(0, 3).forEach((action, index) => {
    lines.push(`  A${index + 1}["检查处理：${mermaidLabel(action)}"]`)
    lines.push(`  M --> A${index + 1}`)
  })
  return lines
}

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key]
  return typeof value === 'string' ? value : ''
}

function normalizeTraceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').trim()
}

function traceTokens(value: string): string[] {
  return normalizeTraceText(value).match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []
}

function mermaidLabel(value: string): string {
  return value.replace(/["\[\]{}<>]/g, '').slice(0, 42)
}

function formatTraceTerms(terms: SearchTerm[], fallback: string): string {
  const displayTerms = terms
    .filter(term => !term.weak)
    .filter(term => !term.numeric || term.value.length >= 3)
    .map(term => term.value)
  return [...new Set(displayTerms)].slice(0, 8).join('、') || fallback
}

function shouldRenderAmbiguousFaultAnswer(
  query: string,
  matches: SearchMatch[],
): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const records = matches.map(match => match.record).filter(isFaultRecord)
  if (records.length < 2) return false

  const queryLower = query.toLowerCase()
  if (
    records.some(record =>
      [record.site, record.brand, record.model]
        .filter(Boolean)
        .some(value => queryLower.includes(value.toLowerCase())),
    )
  ) {
    return false
  }

  return aggregateFaultRecords(records).length > 1
}

function renderAmbiguousFaultAnswer(
  query: string,
  matches: SearchMatch[],
): string {
  const records = aggregateFaultRecords(
    matches.map(match => match.record).filter(isFaultRecord),
  )
  const codes = extractFaultCodes(query)
  const exactGroups =
    codes.length === 1
      ? records.filter(group => group.code === codes[0])
      : records
  const sourceGroups = exactGroups.length >= 2 ? exactGroups : records
  const displayedGroups = isBareCodeQuery(query)
    ? sourceGroups
    : sourceGroups.slice(0, 8)

  return [
    `本地答案：${query}`,
    '',
    `结论：该故障码在本地知识库中有 ${displayedGroups.length} 类不同含义，请结合品牌、机型或风场确认。`,
    '',
    ...displayedGroups.map((group, index) => {
      const object = [
        group.sites.join('、'),
        group.brand,
        group.models.join('、'),
      ]
        .filter(Boolean)
        .join(' / ')
      return [
        `${index + 1}. ${group.code}${group.name ? `：${group.name}` : ''}`,
        object ? `   对象：${object}` : '',
        group.reasons[0] ? `   原因：${group.reasons[0]}` : '',
        group.solutions[0] ? `   处理：${group.solutions[0]}` : '',
        group.resets[0] ? `   复位：${group.resets.join('；')}` : '',
        `   来源：${group.locations.slice(0, 3).join('；')}`,
      ]
        .filter(Boolean)
        .join('\n')
    }),
  ].join('\n')
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
        systems: [],
        categories: [],
        reasons: [],
        solutions: [],
        resets: [],
        logics: [],
        locations: [],
        records: [],
      }

    pushUnique(current.sites, record.site)
    pushUnique(current.models, normalizeModelName(record.model))
    pushUnique(current.systems, record.system)
    pushUnique(current.categories, record.category)
    pushUnique(current.reasons, record.reason)
    pushUnique(current.solutions, record.solution)
    pushUnique(current.resets, record.reset)
    pushUnique(current.logics, record.logic)
    pushUnique(current.locations, record.location)
    current.records.push(record)
    groups.set(key, current)
  }
  return [...groups.values()]
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
    'Unnamed: 3',
    '故障代码',
    '故障描述/现象',
    '故障描述',
    '故障名称',
    '故障名',
    '中文名称',
    '中文描述',
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

async function collectStructuredFaultMatches(
  project: LLMWikiProject,
  files: string[],
  query: string,
  terms: SearchTerm[],
  limit: number,
): Promise<SearchMatch[]> {
  const queryCodes = isFaultCodeQuery(query) ? extractFaultCodes(query) : []
  const records = await loadFaultRecords(project, files)
  const queryLower = query.toLowerCase()
  const shouldKeepAllExactCodeMatches = isBareCodeQuery(query)

  const candidates = records
    .map(record => ({
      record,
      score: scoreFaultRecord(record, queryLower, queryCodes, terms),
    }))
    .filter(candidate => candidate.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.record.location.localeCompare(b.record.location),
    )

  const selectedCandidates = shouldKeepAllExactCodeMatches
    ? candidates.filter(candidate => candidate.record.code === queryCodes[0])
    : candidates.slice(0, Math.max(limit, 8))

  return selectedCandidates
    .map(candidate => ({
      score: candidate.score,
      location: candidate.record.location,
      snippet: renderFaultRecordSnippet(candidate.record),
      record: candidate.record,
    }))
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
        code,
        name: faultNameFromFields(fields),
        site: field(fields, '风场'),
        brand: field(fields, '品牌'),
        model: field(fields, '机型'),
        reason: field(fields, '故障原因'),
        solution: field(fields, '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位'),
        reset: field(fields, '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
        logic: field(fields, '故障逻辑'),
        system: field(fields, '系统'),
        category: field(fields, '故障分类', '故障类型', '故障属性', 'SYJX（故障属性）'),
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
    code,
    name: cleanFaultName(stringField(raw.name) || faultNameFromFields(fields)),
    site: stringField(raw.site) || field(fields, '风场'),
    brand: stringField(raw.brand) || field(fields, '品牌'),
    model: stringField(raw.model) || field(fields, '机型'),
    reason: stringField(raw.reason) || field(fields, '故障原因'),
    solution:
      stringField(raw.solution) ||
      field(fields, '故障处理', '故障处理方法', '故障处理指导', '故障现象及处理方法', '解决方案', '检查部位'),
    reset:
      stringField(raw.reset) ||
      field(fields, '复位', '复位情况', '复位方式', '复位条件', '复位权限', '集控是否可复位', 'Unnamed: 3'),
    logic: stringField(raw.logic) || field(fields, '故障逻辑'),
    system: stringField(raw.system) || field(fields, '系统'),
    category:
      stringField(raw.category) ||
      field(fields, '故障分类', '故障类型', '故障属性', 'SYJX（故障属性）'),
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
    if (record.code === code) {
      score += 10000
    } else if (code.length < 5 && record.code.endsWith(code)) {
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
    record.reason,
    record.solution,
    record.reset,
    record.logic,
    record.system,
    record.category,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const filterBonus = scoreStructuredFilters(record, queryLower)
  if (filterBonus < 0) return 0
  score += filterBonus
  score += scoreQueryCoverage(searchable, terms)
  score += scoreSearchText(searchable, terms)

  return score
}

function scoreStructuredFilters(record: FaultRecord, queryLower: string): number {
  let score = 0
  const dimensions = [
    record.site,
    record.brand,
    record.model,
    record.system,
    record.category,
  ].filter(Boolean)

  for (const dimension of dimensions) {
    const lower = dimension.toLowerCase()
    if (queryLower.includes(lower)) {
      score += 600
      continue
    }
    for (const token of lower.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) ?? []) {
      if (queryLower.includes(token)) {
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
    `故障代码：${record.code}`,
    record.name ? `故障名称：${record.name}` : '',
    record.reason ? `故障原因：${record.reason}` : '',
    record.solution ? `故障处理：${record.solution}` : '',
    record.reset ? `复位：${record.reset}` : '',
    record.logic ? `故障逻辑：${record.logic}` : '',
  ]
    .filter(Boolean)
    .join('，')
}

function faultCodeFromFields(fields: Map<string, string>): string {
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
    '故障现象',
    '故障信息',
    '故障解释',
    '报警',
    '解释',
    '故障',
  )
}

function extractFaultCodes(query: string): string[] {
  const codes = query.match(/[a-z]+[a-z0-9_/-]*\d[a-z0-9_/-]*|\d+/gi) ?? []
  return [...new Set(codes.map(code => code.toLowerCase()))]
}

function isFaultCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length === 0) return false
  if (isBareCodeQuery(query)) return true
  if (/(故障码|故障代码|报警码|告警码|fault\s*code)/i.test(query)) return true
  return codes.some(code => /^\d{3,}$/.test(code))
}

function isBareCodeQuery(query: string): boolean {
  const codes = extractFaultCodes(query)
  if (codes.length !== 1) return false
  const rest = query
    .replace(codes[0]!, '')
    .replace(
      /(故障码|故障代码|报警码|告警码|代码|fault\s*code|是什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|的|为|是)/gi,
      '',
    )
    .replace(/[？?，,。.、:：\s]/g, '')
  return rest.length === 0
}

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
      term => pathText.includes(term.value) || contentText.includes(term.value),
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
    const pattern = new RegExp(`(^|\\D)${escapeRegExp(term.value)}(?=\\D|$)`, 'g')
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

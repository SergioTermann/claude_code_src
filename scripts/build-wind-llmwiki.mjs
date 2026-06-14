import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_DIR = join(ROOT, '风机故障码')
const OUT_DIR = join(ROOT, 'wind-llmwiki')
const WIKI_DIR = join(OUT_DIR, 'wiki')
const GRAPH_DIR = join(OUT_DIR, 'graph')
const META_DIR = join(OUT_DIR, '.llm-wiki')

const STANDARD_MAPPING_FILE = join(
  SOURCE_DIR,
  '00 表达式规则涉及的要配置的标准化-型号和故障手册.md',
)
const FAULT_INDEX_FILE = join(SOURCE_DIR, 'fault-index.jsonl')
const FAULT_SUMMARY_FILE = join(SOURCE_DIR, 'fault-index-summary.json')

const MAX_LIST_ITEMS = 80
const MAX_FAULT_EXAMPLES_PER_PAGE = 12
const MAX_AMBIGUOUS_CODES = 60

await main()

async function main() {
  const [standardText, faultLines, faultSummary] = await Promise.all([
    readFile(STANDARD_MAPPING_FILE, 'utf8'),
    readJsonl(FAULT_INDEX_FILE),
    readJson(FAULT_SUMMARY_FILE),
  ])

  const standardRows = parseStandardMapping(standardText)
  const records = faultLines.map(normalizeFaultRecord).filter(Boolean)
  const sourceStats = await collectSourceStats(SOURCE_DIR)
  const graph = buildKnowledgeGraph(standardRows, records, sourceStats)

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(WIKI_DIR, { recursive: true })
  await mkdir(join(WIKI_DIR, 'farms'), { recursive: true })
  await mkdir(join(WIKI_DIR, 'brands'), { recursive: true })
  await mkdir(join(WIKI_DIR, 'models'), { recursive: true })
  await mkdir(join(WIKI_DIR, 'systems'), { recursive: true })
  await mkdir(join(WIKI_DIR, 'faults'), { recursive: true })
  await mkdir(GRAPH_DIR, { recursive: true })
  await mkdir(META_DIR, { recursive: true })

  await Promise.all([
    copyFile(FAULT_INDEX_FILE, join(OUT_DIR, 'fault-index.jsonl')),
    copyFile(FAULT_SUMMARY_FILE, join(OUT_DIR, 'fault-index-summary.json')),
    writeFile(join(OUT_DIR, 'README.md'), renderReadme(), 'utf8'),
    writeFile(join(OUT_DIR, 'purpose.md'), renderPurpose(), 'utf8'),
    writeFile(join(OUT_DIR, 'schema.md'), renderSchema(), 'utf8'),
  ])

  await writeWiki(graph, faultSummary)
  await writeGraphFiles(graph)
  await writeSnapshot()

  console.log(`Built Wind LLMWiki at ${OUT_DIR}`)
  console.log(`Nodes: ${graph.nodes.length}`)
  console.log(`Edges: ${graph.edges.length}`)
  console.log(`Fault records: ${records.length}`)
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  const items = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      // Skip malformed lines but keep the build usable.
    }
  }
  return items
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return {}
  }
}

function parseStandardMapping(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const site = matchField(line, '场站')
    const brand = matchField(line, '品牌')
    const model = matchField(line, '型号名称')
    const count = matchField(line, '台数')
    const turbineIds = matchField(line, '对应编号')
    if (!site || !brand || !model) continue
    rows.push({
      site,
      brand,
      model,
      displayModel: `${brand} ${model}`,
      count: Number.parseInt(count, 10) || undefined,
      turbineIds,
      source: relative(ROOT, STANDARD_MAPPING_FILE),
    })
  }
  return rows
}

function matchField(line, name) {
  const match = line.match(new RegExp(`${escapeRegExp(name)}：([^，。]+)`))
  return match?.[1]?.trim() ?? ''
}

function normalizeFaultRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const code = clean(raw.code)
  const name = clean(raw.name)
  const source = clean(raw.source || raw.location)
  if (!code || !source) return null
  const evidenceText = clean(
    [name, raw.system, raw.category, raw.reason, raw.solution, raw.logic, raw.text]
      .filter(Boolean)
      .join(' '),
  )
  return {
    code,
    name,
    site: clean(raw.site),
    brand: clean(raw.brand),
    model: clean(raw.model),
    reason: clean(raw.reason),
    solution: clean(raw.solution),
    reset: clean(raw.reset),
    logic: clean(raw.logic),
    system: normalizeSystem(raw.system) || inferSystem(evidenceText),
    category: normalizeCategory(raw.category) || inferCategory(evidenceText),
    source,
    text: clean(raw.text),
    resetModes: extractResetModes(raw.reset, evidenceText),
    components: extractComponents(evidenceText),
  }
}

async function collectSourceStats(root) {
  const docs = []
  await walk(root, async filePath => {
    if (!/\.(md|jsonl|json|csv|txt)$/i.test(filePath)) return
    const info = await stat(filePath)
    docs.push({
      path: relative(ROOT, filePath),
      size: info.size,
    })
  })
  return docs
}

async function walk(dir, visit) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(child, visit)
    } else if (entry.isFile()) {
      await visit(child)
    }
  }
}

function buildKnowledgeGraph(standardRows, records, sourceStats) {
  const nodes = new Map()
  const edges = new Map()
  const canonicalSites = [...new Set(standardRows.map(row => row.site))]

  const addNode = (type, key, props = {}) => {
    const value = clean(key)
    if (!value) return null
    const id = `${type}:${stableId(value)}`
    const existing = nodes.get(id) ?? {
      id,
      type,
      label: value,
      aliases: [],
      count: 0,
      properties: {},
    }
    existing.count += 1
    existing.properties = { ...existing.properties, ...compactObject(props) }
    nodes.set(id, existing)
    return id
  }

  const addEdge = (source, target, type, props = {}) => {
    if (!source || !target || source === target) return
    const id = `${source}->${type}->${target}`
    const existing = edges.get(id) ?? {
      id,
      source,
      target,
      type,
      weight: 0,
      evidence: [],
      properties: {},
    }
    existing.weight += 1
    existing.properties = { ...existing.properties, ...compactObject(props) }
    if (props.evidence && existing.evidence.length < 5) {
      existing.evidence.push(props.evidence)
    }
    edges.set(id, existing)
  }

  for (const row of standardRows) {
    const site = addNode('site', row.site, { source: row.source })
    const brand = addNode('brand', row.brand)
    const model = addNode('model', row.displayModel, {
      rawModel: row.model,
      turbineCount: row.count,
      turbineIds: row.turbineIds,
    })
    addEdge(site, model, 'USES_MODEL', {
      evidence: `${row.site} -> ${row.displayModel}`,
      turbineCount: row.count,
    })
    addEdge(model, brand, 'MADE_BY', { evidence: row.displayModel })
  }

  for (const record of records) {
    const fault = addNode('fault_code', record.code, {
      name: record.name,
      source: record.source,
    })
    const name = addNode('fault_name', record.name)
    const sites = resolveSiteLabels(record.site, canonicalSites).map(site =>
      addNode('site', site),
    )
    const brand = addNode('brand', record.brand)
    const model = addNode('model', normalizeModelLabel(record.brand, record.model))
    const system = addNode('system', record.system)
    const category = addNode('category', record.category)
    const source = addNode('source_doc', sourceDocument(record.source), {
      path: record.source,
    })

    addEdge(fault, name, 'HAS_NAME', { evidence: record.name })
    for (const site of sites) {
      addEdge(fault, site, 'OCCURS_AT_SITE', { evidence: record.source })
    }
    addEdge(fault, model, 'OCCURS_ON_MODEL', { evidence: record.source })
    addEdge(model, brand, 'MADE_BY', { evidence: record.model })
    addEdge(fault, system, 'BELONGS_TO_SYSTEM', { evidence: record.system })
    addEdge(fault, category, 'HAS_CATEGORY', { evidence: record.category })
    addEdge(fault, source, 'HAS_SOURCE', { evidence: record.source })

    for (const cause of extractCauses(record.reason).slice(0, 3)) {
      const causeNode = addNode('cause', cause)
      addEdge(fault, causeNode, 'MAY_BE_CAUSED_BY', { evidence: record.reason })
    }
    for (const action of extractActions(record.solution).slice(0, 4)) {
      const actionNode = addNode('action', action)
      addEdge(fault, actionNode, 'REQUIRES_ACTION', {
        evidence: record.solution,
      })
    }
    for (const component of record.components.slice(0, 6)) {
      const componentNode = addNode('component', component)
      addEdge(fault, componentNode, 'INVOLVES_COMPONENT', {
        evidence: record.text || record.reason || record.solution || record.logic,
      })
    }
    for (const resetMode of record.resetModes) {
      const resetNode = addNode('reset_mode', resetMode)
      addEdge(fault, resetNode, 'HAS_RESET_MODE', {
        evidence: record.reset || record.logic || record.text,
      })
    }
  }

  for (const doc of sourceStats) {
    addNode('source_doc', doc.path, { size: doc.size })
  }

  const nodeList = [...nodes.values()].sort(sortByTypeLabel)
  const edgeList = [...edges.values()].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
  const byId = new Map(nodeList.map(node => [node.id, node]))

  return {
    generatedAt: new Date().toISOString(),
    source: {
      standardMapping: relative(ROOT, STANDARD_MAPPING_FILE),
      faultIndex: relative(ROOT, FAULT_INDEX_FILE),
      sourceDirectory: relative(ROOT, SOURCE_DIR),
    },
    nodes: nodeList,
    edges: edgeList,
    indexes: buildIndexes(nodeList, edgeList, byId),
  }
}

function buildIndexes(nodes, edges, byId) {
  const byType = groupBy(nodes, node => node.type)
  const edgeBySource = groupBy(edges, edge => edge.source)
  const edgeByType = groupBy(edges, edge => edge.type)
  const topSystems = topNodes(byType.system ?? [], 30)
  const topFaultCodes = topNodes(byType.fault_code ?? [], 40)
  const topActions = topNodes(byType.action ?? [], 40)
  const topComponents = topNodes(byType.component ?? [], 40)
  const topCauses = topNodes(byType.cause ?? [], 40)
  const quality = buildQualityIndex(nodes, edges, byType, edgeBySource, byId)
  const ambiguousFaultCodes = [...(byType.fault_code ?? [])]
    .map(node => {
      const modelCount = new Set(
        (edgeBySource[node.id] ?? [])
          .filter(edge => edge.type === 'OCCURS_ON_MODEL')
          .map(edge => edge.target),
      ).size
      const siteCount = new Set(
        (edgeBySource[node.id] ?? [])
          .filter(edge => edge.type === 'OCCURS_AT_SITE')
          .map(edge => edge.target),
      ).size
      return { node, modelCount, siteCount }
    })
    .filter(item => item.modelCount > 1 || item.siteCount > 1)
    .sort((a, b) => b.modelCount + b.siteCount - (a.modelCount + a.siteCount))
    .slice(0, MAX_AMBIGUOUS_CODES)
    .map(item => ({
      code: item.node.label,
      name: item.node.properties.name,
      modelCount: item.modelCount,
      siteCount: item.siteCount,
    }))

  return {
    countsByNodeType: Object.fromEntries(
      Object.entries(byType).map(([type, values]) => [type, values.length]),
    ),
    countsByEdgeType: Object.fromEntries(
      Object.entries(edgeByType).map(([type, values]) => [type, values.length]),
    ),
    topSystems,
    topFaultCodes,
    topActions,
    topComponents,
    topCauses,
    quality,
    ambiguousFaultCodes,
    labelsById: Object.fromEntries(nodes.map(node => [node.id, node.label])),
  }
}

function buildQualityIndex(nodes, edges, byType, edgeBySource, nodesById) {
  const faultCodes = byType.fault_code ?? []
  const systemNodes = byType.system ?? []
  const categoryNodes = byType.category ?? []
  const resetModeNodes = byType.reset_mode ?? []
  const componentNodes = byType.component ?? []
  const sourceDocNodes = byType.source_doc ?? []
  const faultIds = new Set(faultCodes.map(node => node.id))
  const linkedNodeIds = new Set(edges.flatMap(edge => [edge.source, edge.target]))
  const isolatedNodes = nodes.filter(node => !linkedNodeIds.has(node.id))
  const countFaultsWithEdge = type =>
    faultCodes.filter(node =>
      (edgeBySource[node.id] ?? []).some(edge => edge.type === type),
    ).length

  const classifiedFaultCount = faultCodes.filter(node =>
    (edgeBySource[node.id] ?? []).some(edge => {
      if (edge.type !== 'BELONGS_TO_SYSTEM') return false
      const target = nodesById.get(edge.target)
      return target && target.label !== '未分类系统'
    }),
  ).length
  const categorizedFaultCount = faultCodes.filter(node =>
    (edgeBySource[node.id] ?? []).some(edge => {
      if (edge.type !== 'HAS_CATEGORY') return false
      const target = nodesById.get(edge.target)
      return target && target.label !== '未分类故障'
    }),
  ).length

  return {
    faultCodeCount: faultCodes.length,
    systemCount: systemNodes.length,
    categoryCount: categoryNodes.length,
    componentCount: componentNodes.length,
    resetModeCount: resetModeNodes.length,
    sourceDocCount: sourceDocNodes.length,
    classifiedFaultCount,
    categorizedFaultCount,
    faultsWithComponents: countFaultsWithEdge('INVOLVES_COMPONENT'),
    faultsWithResetMode: countFaultsWithEdge('HAS_RESET_MODE'),
    faultsWithCause: countFaultsWithEdge('MAY_BE_CAUSED_BY'),
    faultsWithAction: countFaultsWithEdge('REQUIRES_ACTION'),
    isolatedNodeCount: isolatedNodes.length,
    isolatedNodesByType: countBy(isolatedNodes, node => node.type),
    linkedFaultCount: [...faultIds].filter(id => (edgeBySource[id] ?? []).length > 0).length,
  }
}

async function writeWiki(graph, faultSummary) {
  await writeFile(join(WIKI_DIR, 'index.md'), renderIndex(graph, faultSummary), 'utf8')
  await writeFile(join(WIKI_DIR, 'overview.md'), renderOverview(graph), 'utf8')
  await writeFile(join(WIKI_DIR, 'knowledge-graph.md'), renderGraphGuide(graph), 'utf8')
  await writeFile(join(WIKI_DIR, 'quality-report.md'), renderQualityReport(graph), 'utf8')
  await writeFile(join(WIKI_DIR, 'faults', 'ambiguous-codes.md'), renderAmbiguousFaultCodes(graph), 'utf8')
  await writeFile(join(WIKI_DIR, 'faults', 'top-fault-codes.md'), renderTopFaultCodes(graph), 'utf8')

  const byType = groupBy(graph.nodes, node => node.type)
  await writeEntityPages(graph, byType.site ?? [], 'farms', renderSitePage)
  await writeEntityPages(graph, byType.brand ?? [], 'brands', renderBrandPage)
  await writeEntityPages(graph, byType.model ?? [], 'models', renderModelPage)
  await writeEntityPages(graph, byType.system ?? [], 'systems', renderSystemPage, 40)
}

async function writeEntityPages(graph, nodes, dirName, render, limit = 200) {
  const selected = [...nodes].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN')).slice(0, limit)
  for (const node of selected) {
    await writeFile(
      join(WIKI_DIR, dirName, `${safeFileName(node.label)}.md`),
      render(graph, node),
      'utf8',
    )
  }
}

async function writeGraphFiles(graph) {
  await writeFile(join(GRAPH_DIR, 'knowledge-graph.json'), `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  await writeFile(
    join(GRAPH_DIR, 'triples.jsonl'),
    graph.edges.map(edge => JSON.stringify(edge)).join('\n') + '\n',
    'utf8',
  )
  await writeFile(
    join(GRAPH_DIR, 'nodes.csv'),
    csv([
      ['id', 'type', 'label', 'count'],
      ...graph.nodes.map(node => [node.id, node.type, node.label, node.count]),
    ]),
    'utf8',
  )
  await writeFile(
    join(GRAPH_DIR, 'edges.csv'),
    csv([
      ['source', 'type', 'target', 'weight'],
      ...graph.edges.map(edge => [edge.source, edge.type, edge.target, edge.weight]),
    ]),
    'utf8',
  )
}

async function writeSnapshot() {
  const files = {}
  await walk(OUT_DIR, async filePath => {
    const rel = relative(OUT_DIR, filePath)
    if (rel.startsWith('.llm-wiki/')) return
    if (!/\.(md|json|jsonl|csv|txt)$/i.test(rel)) return
    const info = await stat(filePath)
    files[rel] = {
      size: info.size,
      sha1: await sha1(filePath),
      updatedAt: Math.floor(info.mtimeMs),
    }
  })

  await writeFile(
    join(META_DIR, 'file-snapshot.json'),
    `${JSON.stringify({ version: 1, updatedAt: Date.now(), files }, null, 2)}\n`,
    'utf8',
  )
}

function renderPurpose() {
  return [
    '# Wind LLMWiki Purpose',
    '',
    '这个 LLMWiki 项目把本地风电知识整理成可检索 wiki 和机器可读知识图谱。',
    '',
    '核心用途：',
    '',
    '- 支持风场、品牌、机型、故障码、系统、故障分类、原因和处理动作之间的关系查询。',
    '- 为本地 LM Studio 问答提供可追溯的事实来源。',
    '- 对长故障码、同码多机型、同风场多机型等场景提供结构化 grounding。',
  ].join('\n')
}

function renderReadme() {
  return [
    '# Wind LLMWiki',
    '',
    '这是从本地风电资料生成的 LLMWiki 项目和知识图谱。',
    '',
    '## 目录',
    '',
    '- `wiki/`：面向人和 `/llmwiki search/read` 的 Markdown 知识页。',
    '- `graph/knowledge-graph.json`：完整知识图谱。',
    '- `graph/triples.jsonl`：关系三元组，适合导入图数据库。',
    '- `graph/nodes.csv`、`graph/edges.csv`：CSV 版本节点和边。',
    '- `graph/visualization.html`：离线知识图谱可视化页面，运行 `npm run visual:wind-graph` 后生成。',
    '- `wiki/quality-report.md`：图谱抽取质量和覆盖率报告。',
    '- `fault-index.jsonl`：复制自原始风机故障码索引，供 `/llmwiki ask/search` 做结构化故障码检索。',
    '- `.llm-wiki/file-snapshot.json`：LLMWiki 项目索引快照。',
    '',
    '## 数据来源',
    '',
    '- 标准风场机型映射：`风机故障码/00 表达式规则涉及的要配置的标准化-型号和故障手册.md`。',
    '- 故障码记录：`风机故障码/fault-index.jsonl`。',
    '- 原始资料目录：`风机故障码/`。',
    '',
    '## 场站说明',
    '',
    '场站机型关系优先使用标准映射文件。故障码资料中如果出现标准表未覆盖的场站或范围名，也会保留为图谱节点，用于追溯来源资料。',
    '',
    '## 使用',
    '',
    '```text',
    'LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki search 1100007 --limit 3"',
    'LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki search 新华 SE8715 --limit 3"',
    'LLMWIKI_PROJECT=wind-llmwiki node scripts/run-lmstudio-claude.mjs --print --bare --max-turns 1 "/llmwiki read wiki/knowledge-graph.md"',
    '```',
    '',
    '## 重建',
    '',
    '```text',
    'npm run build:wind-llmwiki',
    'npm run visual:wind-graph',
    'npm run smoke:wind-llmwiki',
    '```',
    '',
    '也可以一次性重建知识库和可视化：',
    '',
    '```text',
    'npm run build:wind-knowledge',
    '```',
  ].join('\n')
}

function renderSchema() {
  return [
    '# Wind Knowledge Graph Schema',
    '',
    '## Node Types',
    '',
    '- `site`: 风场或场站。',
    '- `brand`: 风机品牌。',
    '- `model`: 风机型号。',
    '- `fault_code`: 故障码。',
    '- `fault_name`: 故障名称。',
    '- `system`: 所属系统。',
    '- `category`: 故障分类。',
    '- `cause`: 故障原因短语。',
    '- `action`: 处理动作短语。',
    '- `component`: 设备部件或关键元件。',
    '- `reset_mode`: 复位方式或复位权限。',
    '- `source_doc`: 来源文档或来源路径。',
    '',
    '## Edge Types',
    '',
    '- `USES_MODEL`: 场站使用某机型。',
    '- `MADE_BY`: 机型属于某品牌。',
    '- `OCCURS_AT_SITE`: 故障码出现于某场站。',
    '- `OCCURS_ON_MODEL`: 故障码适用于某机型。',
    '- `BELONGS_TO_SYSTEM`: 故障码属于某系统。',
    '- `HAS_CATEGORY`: 故障码属于某分类。',
    '- `MAY_BE_CAUSED_BY`: 故障可能原因。',
    '- `REQUIRES_ACTION`: 故障处理动作。',
    '- `INVOLVES_COMPONENT`: 故障涉及的设备部件或关键元件。',
    '- `HAS_RESET_MODE`: 故障可用的复位方式或复位权限。',
    '- `HAS_SOURCE`: 故障码来源资料。',
  ].join('\n')
}

function renderIndex(graph, faultSummary) {
  const counts = graph.indexes.countsByNodeType
  return [
    '# 风电知识 LLMWiki',
    '',
    '这是根据本地风电资料生成的 LLMWiki 和知识图谱项目。',
    '',
    '## 数据规模',
    '',
    `- 故障记录：${faultSummary.recordCount ?? counts.fault_code ?? 0}`,
    `- 图谱节点：${graph.nodes.length}`,
    `- 图谱关系：${graph.edges.length}`,
    `- 风场节点：${counts.site ?? 0}`,
    `- 品牌节点：${counts.brand ?? 0}`,
    `- 机型节点：${counts.model ?? 0}`,
    `- 故障码节点：${counts.fault_code ?? 0}`,
    `- 系统节点：${counts.system ?? 0}`,
    '',
    '## 推荐入口',
    '',
    '- [知识概览](overview.md)',
    '- [知识图谱说明](knowledge-graph.md)',
    '- [图谱质量报告](quality-report.md)',
    '- [高频故障码](faults/top-fault-codes.md)',
    '- [同码多场站/多机型故障码](faults/ambiguous-codes.md)',
    '- [图谱 JSON](../graph/knowledge-graph.json)',
    '- [图谱三元组 JSONL](../graph/triples.jsonl)',
    '',
    '## 查询示例',
    '',
    '```text',
    '/llmwiki search 新华 SE8715',
    '/llmwiki search 1100007',
    '/llmwiki search 变桨 欠压',
    '/llmwiki read wiki/faults/ambiguous-codes.md',
    '```',
  ].join('\n')
}

function renderOverview(graph) {
  const counts = graph.indexes.countsByNodeType
  return [
    '# 风电知识概览',
    '',
    '## 节点统计',
    '',
    table(['类型', '数量'], Object.entries(counts).map(([type, count]) => [type, count])),
    '',
    '## 关系统计',
    '',
    table(['关系', '数量'], Object.entries(graph.indexes.countsByEdgeType).map(([type, count]) => [type, count])),
    '',
    '## 高频系统',
    '',
    bulletList(graph.indexes.topSystems.slice(0, 20).map(item => `${item.label}：${item.count}`)),
    '',
    '## 高频处理动作',
    '',
    bulletList(graph.indexes.topActions.slice(0, 20).map(item => `${item.label}：${item.count}`)),
    '',
    '## 高频部件',
    '',
    bulletList(graph.indexes.topComponents.slice(0, 20).map(item => `${item.label}：${item.count}`)),
  ].join('\n')
}

function renderGraphGuide(graph) {
  return [
    '# 知识图谱说明',
    '',
    '本知识图谱以风电运维问答为目标，将本地故障资料和风场机型标准化表抽取为实体与关系。',
    '',
    '## 图谱文件',
    '',
    '- `graph/knowledge-graph.json`：完整节点、关系、统计索引。',
    '- `graph/triples.jsonl`：逐行关系记录，适合导入图数据库或检索系统。',
    '- `graph/nodes.csv`：节点表。',
    '- `graph/edges.csv`：边表。',
    '',
    '## 典型路径',
    '',
    '- 风场 -> `USES_MODEL` -> 机型 -> `MADE_BY` -> 品牌',
    '- 故障码 -> `OCCURS_ON_MODEL` -> 机型',
    '- 故障码 -> `BELONGS_TO_SYSTEM` -> 系统',
    '- 故障码 -> `MAY_BE_CAUSED_BY` -> 原因',
    '- 故障码 -> `REQUIRES_ACTION` -> 处理动作',
    '- 故障码 -> `INVOLVES_COMPONENT` -> 部件',
    '- 故障码 -> `HAS_RESET_MODE` -> 复位方式',
    '',
    '## 当前规模',
    '',
    `- 节点：${graph.nodes.length}`,
    `- 关系：${graph.edges.length}`,
  ].join('\n')
}

function renderQualityReport(graph) {
  const quality = graph.indexes.quality
  const pct = value => `${((value / Math.max(quality.faultCodeCount, 1)) * 100).toFixed(1)}%`
  return [
    '# 图谱质量报告',
    '',
    '这个页面用于跟踪知识图谱抽取质量，便于后续继续降低未分类和噪声节点。',
    '',
    '## 覆盖率',
    '',
    table(
      ['指标', '数量', '占故障码比例'],
      [
        ['故障码总数', quality.faultCodeCount, '100.0%'],
        ['已归入明确系统', quality.classifiedFaultCount, pct(quality.classifiedFaultCount)],
        ['已归入明确分类', quality.categorizedFaultCount, pct(quality.categorizedFaultCount)],
        ['包含部件关系', quality.faultsWithComponents, pct(quality.faultsWithComponents)],
        ['包含复位方式', quality.faultsWithResetMode, pct(quality.faultsWithResetMode)],
        ['包含原因关系', quality.faultsWithCause, pct(quality.faultsWithCause)],
        ['包含处理动作', quality.faultsWithAction, pct(quality.faultsWithAction)],
      ],
    ),
    '',
    '## 实体统计',
    '',
    table(
      ['实体类型', '数量'],
      [
        ['系统', quality.systemCount],
        ['分类', quality.categoryCount],
        ['部件', quality.componentCount],
        ['复位方式', quality.resetModeCount],
        ['来源文档', quality.sourceDocCount],
        ['孤立节点', quality.isolatedNodeCount],
      ],
    ),
    '',
    '## 孤立节点类型',
    '',
    table(['类型', '数量'], Object.entries(quality.isolatedNodesByType)),
    '',
    '## 高频部件',
    '',
    bulletList(graph.indexes.topComponents.slice(0, 30).map(item => `${item.label}：${item.count}`)),
    '',
    '## 高频原因',
    '',
    bulletList(graph.indexes.topCauses.slice(0, 30).map(item => `${item.label}：${item.count}`)),
  ].join('\n')
}

function renderAmbiguousFaultCodes(graph) {
  return [
    '# 同码多场站/多机型故障码',
    '',
    '这些故障码在多个场站或多个机型中出现。用户只输入短码或缺少风场/机型时，应优先提示可能存在歧义。',
    '',
    table(
      ['故障码', '名称', '涉及机型数', '涉及场站数'],
      graph.indexes.ambiguousFaultCodes.map(item => [
        item.code,
        item.name ?? '',
        item.modelCount,
        item.siteCount,
      ]),
    ),
  ].join('\n')
}

function renderTopFaultCodes(graph) {
  return [
    '# 高频故障码',
    '',
    '按图谱记录次数排序，用于快速定位常见故障码。',
    '',
    table(
      ['故障码', '名称', '记录数'],
      graph.indexes.topFaultCodes.map(item => [
        item.label,
        item.properties?.name ?? '',
        item.count,
      ]),
    ),
  ].join('\n')
}

function renderSitePage(graph, node) {
  const related = relatedNodes(graph, node.id)
  return [
    `# ${node.label}`,
    '',
    '## 对应机型',
    '',
    bulletList(related('USES_MODEL', 'out').map(formatNode)),
    '',
    '## 相关故障码示例',
    '',
    bulletList(related('OCCURS_AT_SITE', 'in').slice(0, MAX_FAULT_EXAMPLES_PER_PAGE).map(formatNodeWithName)),
  ].join('\n')
}

function renderBrandPage(graph, node) {
  const related = relatedNodes(graph, node.id)
  return [
    `# ${node.label}`,
    '',
    '## 相关机型',
    '',
    bulletList(related('MADE_BY', 'in').slice(0, MAX_LIST_ITEMS).map(formatNode)),
  ].join('\n')
}

function renderModelPage(graph, node) {
  const related = relatedNodes(graph, node.id)
  return [
    `# ${node.label}`,
    '',
    '## 所属品牌',
    '',
    bulletList(related('MADE_BY', 'out').map(formatNode)),
    '',
    '## 使用场站',
    '',
    bulletList(related('USES_MODEL', 'in').map(formatNode)),
    '',
    '## 相关故障码示例',
    '',
    bulletList(related('OCCURS_ON_MODEL', 'in').slice(0, MAX_FAULT_EXAMPLES_PER_PAGE).map(formatNodeWithName)),
  ].join('\n')
}

function renderSystemPage(graph, node) {
  const related = relatedNodes(graph, node.id)
  return [
    `# ${node.label}`,
    '',
    '## 相关故障码示例',
    '',
    bulletList(related('BELONGS_TO_SYSTEM', 'in').slice(0, 40).map(formatNodeWithName)),
  ].join('\n')
}

function relatedNodes(graph, nodeId) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  return (type, direction) =>
    graph.edges
      .filter(edge =>
        direction === 'out'
          ? edge.source === nodeId && edge.type === type
          : edge.target === nodeId && edge.type === type,
      )
      .sort((a, b) => b.weight - a.weight)
      .map(edge => byId.get(direction === 'out' ? edge.target : edge.source))
      .filter(Boolean)
}

function formatNode(node) {
  return `${node.label}${node.count ? `（${node.count}）` : ''}`
}

function formatNodeWithName(node) {
  const name = node.properties?.name ? `：${node.properties.name}` : ''
  return `${node.label}${name}`
}

function normalizeSystem(value) {
  const text = clean(value)
    .replace(/变奖/g, '变桨')
    .replace(/通讯/g, '通信')
    .replace(/^#N\/A$/i, '')
  if (!text) return ''
  const rules = [
    ['变桨系统', /变桨|桨叶|桨距|pitch/i],
    ['偏航系统', /偏航|yaw/i],
    ['变流系统', /变流|变频|变流器|变频器|converter|GSC|MSC|crowbar/i],
    ['发电机系统', /^发电机$|发电机|定子|转子|碳刷/i],
    ['齿轮箱系统', /^齿轮箱$|齿轮箱/i],
    ['液压系统', /液压/i],
    ['制动系统', /制动|刹车/i],
    ['水冷系统', /水冷|冷却/i],
    ['通信系统', /通信|通讯|CAN|Profibus|EtherCAT/i],
    ['电网系统', /电网|并网|电压|频率/i],
    ['主控系统', /主控|控制|PLC|看门狗|I\/O|控制柜|电气控制/i],
    ['安全链系统', /安全链|安全系统|急停/i],
    ['电池系统', /^电池$|电池/i],
    ['变压器系统', /^变压器$|变压器/i],
    ['传动系统', /传动|变速/i],
    ['机舱与塔架系统', /机舱|塔架/i],
  ]
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? text
}

function normalizeCategory(value) {
  const text = clean(value)
    .replace(/通讯/g, '通信')
    .replace(/^#N\/A$/i, '')
  if (!text) return ''
  const rules = [
    ['PLC故障', /PLC|bachmann|ABB\.Pro|看门狗/i],
    ['可复位故障', /可复位|自动复位|手动复位|远程复位/],
    ['温度越限', /温度|过温|高温|低温/],
    ['通信故障', /通信|通讯|CAN|Profibus|EtherCAT/i],
    ['电气故障', /电压|电流|断路器|接触器|短路|过载|熔丝|继电器/],
    ['传感器故障', /传感器|编码器|限位|风速仪|风向标/],
    ['机械故障', /轴承|振动|润滑|齿轮|刹车|制动/],
    ['系统状态故障', /状态机|一般性|版本检查|属性/],
  ]
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? text
}

function inferSystem(text) {
  const rules = [
    ['变桨系统', /变桨|桨叶|桨距|pitch/i],
    ['偏航系统', /偏航|yaw/i],
    ['变流系统', /变流|变频|逆变|整流|GSC|MSC|crowbar/i],
    ['发电机系统', /发电机|定子|转子|轴承/i],
    ['齿轮箱系统', /齿轮箱/i],
    ['液压系统', /液压/i],
    ['制动系统', /刹车|制动/i],
    ['水冷系统', /水冷|冷却/i],
    ['温度系统', /温度|过温|高温|低温/i],
    ['通信系统', /通信|通讯|CAN|Profibus|EtherCAT/i],
    ['电网系统', /电网|电压|频率|并网/i],
    ['主控系统', /主控|PLC|控制器|模块|I\/O|控制柜/i],
    ['安全链系统', /安全链|急停/i],
    ['电池系统', /电池/i],
    ['变压器系统', /变压器/i],
  ]
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? '未分类系统'
}

function inferCategory(text) {
  const rules = [
    ['可复位故障', /可复位|自动复位|手动复位/],
    ['温度越限', /温度|过温|高温|低温/],
    ['通信故障', /通信|通讯/],
    ['电气故障', /电压|电流|断路器|接触器|短路|过载/],
    ['传感器故障', /传感器|编码器|限位/],
    ['机械故障', /轴承|振动|润滑|齿轮/],
  ]
  return rules.find(([, pattern]) => pattern.test(text))?.[0] ?? '未分类故障'
}

function extractCauses(text) {
  return splitPhrases(text)
    .map(item => item.replace(/^(故障原因|原因)[:：]?/, '').trim())
    .map(normalizePhrase)
    .filter(isUsefulPhrase)
    .filter(item => item.length >= 2 && item.length <= 80)
}

function extractActions(text) {
  return splitPhrases(text)
    .map(item => item.replace(/^(故障处理|处理|解决方案)[:：]?/, '').trim())
    .map(normalizePhrase)
    .filter(isUsefulPhrase)
    .filter(item => /检查|更换|复位|停机|启动|清理|测量|紧固|联系|观察|确认|处理|测试/.test(item))
    .filter(item => item.length >= 2 && item.length <= 80)
}

function normalizePhrase(value) {
  return clean(value)
    .replace(/通讯/g, '通信')
    .replace(/[。；;]+$/g, '')
    .replace(/\s*[,，]\s*/g, '，')
}

function isUsefulPhrase(value) {
  return !/^(无|备用|暂无|无故障|故障|报警|快速|立即|缓慢|---+|\/+|N\/A|NA|null)$/i.test(value)
}

function extractResetModes(...values) {
  const text = clean(values.filter(Boolean).join(' '))
  const modes = []
  if (/远程|遥控|集控/.test(text)) modes.push('远程复位')
  if (/自动复位|故障自动复位|可以自动复位/.test(text)) modes.push('自动复位')
  if (/手动复位|人工复位|就地复位|本地复位/.test(text)) modes.push('手动复位')
  if (/不可复位|不能复位|不可远程复位|集控中心不可复位/.test(text)) modes.push('不可远程复位')
  if (/自启动|可以自启动|机组可以自启动/.test(text)) modes.push('复位后可自启动')
  return unique(modes)
}

function extractComponents(text) {
  const normalized = clean(text)
  const rules = [
    ['PLC模块', /PLC模块|PLC\s*Module/i],
    ['PLC控制器', /PLC控制器|Bachmann PLC|Beckhoff控制器|控制器|主控/i],
    ['I/O模块', /I\/O|IO模块|输入输出模块/i],
    ['传感器', /传感器/],
    ['温度传感器', /温度传感器|PT100/i],
    ['振动传感器', /振动传感器|振动/],
    ['风速仪', /风速仪|风速传感器/i],
    ['风向标', /风向标|风向仪/i],
    ['编码器', /编码器|encoder/i],
    ['限位开关', /限位开关|限位/i],
    ['断路器', /断路器|空开/i],
    ['接触器', /接触器/i],
    ['继电器', /继电器/i],
    ['熔丝', /熔丝|保险/i],
    ['浪涌保护器', /浪涌保护器|浪涌/i],
    ['变桨变频器', /变桨变频器|变桨驱动器/i],
    ['变流器', /变流器|变频器|converter|GSC|MSC/i],
    ['发电机', /发电机/],
    ['轴承', /轴承/],
    ['齿轮箱', /齿轮箱/],
    ['液压站', /液压站|液压泵/i],
    ['制动器', /制动器|刹车/i],
    ['电池', /电池|蓄电池/i],
    ['变压器', /变压器/i],
    ['电缆线路', /电缆|线路|线缆|接线/i],
    ['加热器', /加热器/i],
    ['冷却风扇', /冷却风扇|风扇/i],
    ['24V电源', /24V|24\s*V/i],
  ]
  return rules
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([label]) => label)
}

function splitPhrases(text) {
  return clean(text)
    .split(/[;；。]/)
    .map(item => item.replace(/^\s*\d+[.、)\uff09-]?\s*/, '').trim())
    .filter(Boolean)
}

function normalizeModelLabel(brand, model) {
  const cleanModel = clean(model)
  const cleanBrand = clean(brand)
  if (!cleanModel) return ''
  if (!cleanBrand || cleanModel.toLowerCase().startsWith(cleanBrand.toLowerCase())) {
    return cleanModel
  }
  return `${cleanBrand} ${cleanModel}`
}

function resolveSiteLabels(rawSite, canonicalSites) {
  const raw = normalizeSiteText(rawSite)
  if (!raw || isPlaceholderSite(raw)) return []

  const exact = matchCanonicalSite(raw, canonicalSites)
  if (exact) return [exact]

  const commaParts = raw
    .split(/[、,，]+/)
    .map(part => normalizeSiteText(part))
    .filter(part => part && !isPlaceholderSite(part))

  if (commaParts.length > 1) {
    return unique(
      commaParts.flatMap(part => {
        const matched = matchCanonicalSite(part, canonicalSites)
        return matched ? [matched] : containedCanonicalSites(part, canonicalSites)
      }),
    )
  }

  const contained = containedCanonicalSites(raw, canonicalSites)
  if (contained.length > 0) return contained

  return [raw]
}

function matchCanonicalSite(value, canonicalSites) {
  const normalizedValue = normalizeSiteKey(value)
  return (
    canonicalSites.find(site => normalizeSiteKey(site) === normalizedValue) ??
    canonicalSites.find(site => {
      const normalizedSite = normalizeSiteKey(site)
      return (
        normalizedValue === `${normalizedSite}风电场` ||
        normalizedValue.replace(/风电场$/u, '') === normalizedSite
      )
    })
  )
}

function containedCanonicalSites(value, canonicalSites) {
  const normalizedValue = normalizeSiteKey(value)
  return canonicalSites
    .filter(site => normalizeSiteKey(site).length >= 2)
    .filter(site => normalizedValue.includes(normalizeSiteKey(site)))
    .sort((a, b) => b.length - a.length)
}

function normalizeSiteText(value) {
  return clean(value)
    .replace(/镇赍/g, '镇赉')
    .replace(/风力发电场/g, '风电场')
}

function normalizeSiteKey(value) {
  return normalizeSiteText(value)
    .toLowerCase()
    .replace(/[（）]/g, match => (match === '（' ? '(' : ')'))
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function isPlaceholderSite(value) {
  return /^(x+|xx+|未知|无|未填)$/i.test(value)
}

function sourceDocument(source) {
  return clean(source).split(':')[0]
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ''),
  )
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function stableId(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12)
}

async function sha1(filePath) {
  return createHash('sha1').update(await readFile(filePath)).digest('hex')
}

function safeFileName(value) {
  return clean(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120)
}

function groupBy(items, keyFn) {
  const groups = {}
  for (const item of items) {
    const key = keyFn(item)
    groups[key] ??= []
    groups[key].push(item)
  }
  return groups
}

function countBy(items, keyFn) {
  const counts = {}
  for (const item of items) {
    const key = keyFn(item)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function topNodes(nodes, limit) {
  return [...nodes]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, limit)
}

function unique(items) {
  return [...new Set(items)]
}

function sortByTypeLabel(a, b) {
  return a.type.localeCompare(b.type) || a.label.localeCompare(b.label, 'zh-Hans-CN')
}

function table(headers, rows) {
  const body = rows.length > 0 ? rows : [['无', '']]
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...body.map(row => `| ${row.map(cell => String(cell ?? '').replace(/\|/g, '/')).join(' | ')} |`),
  ].join('\n')
}

function bulletList(items) {
  if (!items.length) return '- 无'
  return items.map(item => `- ${item}`).join('\n')
}

function csv(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n'
}

function csvCell(value) {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

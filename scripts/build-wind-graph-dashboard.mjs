import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GRAPH_FILE = join(ROOT, 'wind-llmwiki', 'graph', 'knowledge-graph.json')
const OUT_FILE = join(ROOT, 'wind-llmwiki', 'graph', 'dashboard.html')

const graph = JSON.parse(await readFile(GRAPH_FILE, 'utf8'))
const byId = new Map(graph.nodes.map(node => [node.id, node]))
const adjacency = buildAdjacency(graph.edges)

const dashboard = {
  generatedAt: graph.generatedAt,
  stats: buildStats(),
  charts: {
    nodeTypes: countRows(graph.indexes.countsByNodeType, labelNodeType),
    edgeTypes: countRows(graph.indexes.countsByEdgeType, labelEdgeType),
    systems: topRows(graph.indexes.topSystems ?? topNodes('system', 12), labelNode),
    components: topRows(graph.indexes.topComponents ?? topNodes('component', 12), labelNode),
  },
  views: {
    overview: buildOverviewView(),
    farmModel: buildFarmModelView(),
    systems: buildRelationView('系统-故障码', 'system', 'BELONGS_TO_SYSTEM', 14, 170),
    components: buildRelationView('部件-故障码', 'component', 'INVOLVES_COMPONENT', 14, 170),
    resetModes: buildRelationView('复位方式-故障码', 'reset_mode', 'HAS_RESET_MODE', 5, 150),
    fault303804: buildFaultView('303804'),
    fault1100007: buildFaultView('1100007'),
  },
  searchIndex: buildSearchIndex(),
}
dashboard.neighborhoods = buildNeighborhoods(dashboard.searchIndex)

await writeFile(OUT_FILE, renderHtml(dashboard), 'utf8')
console.log(`Wrote ${OUT_FILE}`)

function buildStats() {
  const quality = graph.indexes.quality ?? {}
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    sites: graph.indexes.countsByNodeType.site ?? 0,
    models: graph.indexes.countsByNodeType.model ?? 0,
    faultCodes: graph.indexes.countsByNodeType.fault_code ?? 0,
    systems: graph.indexes.countsByNodeType.system ?? 0,
    components: graph.indexes.countsByNodeType.component ?? 0,
    classifiedFaults: quality.classifiedFaultCount ?? 0,
    faultsWithComponents: quality.faultsWithComponents ?? 0,
    faultsWithResetMode: quality.faultsWithResetMode ?? 0,
  }
}

function buildOverviewView() {
  const nodes = [{ id: 'overview', label: '风电知识图谱', type: 'root', count: graph.nodes.length }]
  const edges = []
  for (const row of countRows(graph.indexes.countsByNodeType, labelNodeType)) {
    const id = `node-type:${row.key}`
    nodes.push({ id, label: `${row.label} ${formatNumber(row.value)}`, type: row.key, count: row.value })
    edges.push({ source: 'overview', target: id, type: 'HAS_NODE_TYPE', weight: row.value })
  }
  for (const row of countRows(graph.indexes.countsByEdgeType, labelEdgeType).slice(0, 8)) {
    const id = `edge-type:${row.key}`
    nodes.push({ id, label: `${row.label} ${formatNumber(row.value)}`, type: 'relation', count: row.value })
    edges.push({ source: 'overview', target: id, type: row.key, weight: row.value })
  }
  return compactView('图谱总览', nodes, edges)
}

function buildFarmModelView() {
  const modelEdges = graph.edges.filter(edge => edge.type === 'USES_MODEL')
  const modelIds = new Set(modelEdges.map(edge => edge.target))
  const brandEdges = graph.edges.filter(edge => modelIds.has(edge.source) && edge.type === 'MADE_BY')
  return viewFromEdges('风场-机型-品牌', [...modelEdges, ...brandEdges])
}

function buildRelationView(title, targetType, relationType, targetLimit, edgeLimit) {
  const targetIds = new Set(topNodes(targetType, targetLimit).map(node => node.id))
  const edges = graph.edges
    .filter(edge => edge.type === relationType && targetIds.has(edge.target))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, edgeLimit)
  return viewFromEdges(title, edges)
}

function buildFaultView(code) {
  const fault = graph.nodes.find(node => node.type === 'fault_code' && node.label === code)
  if (!fault) return compactView(`故障码 ${code}`, [], [])
  const direct = (adjacency.get(fault.id) ?? [])
    .sort((a, b) => edgePriority(a.type) - edgePriority(b.type) || b.weight - a.weight)
    .slice(0, 42)
  return viewFromEdges(`故障码 ${code}`, direct, [fault.id])
}

function viewFromEdges(title, edges, extraNodeIds = []) {
  const nodeIds = new Set(extraNodeIds)
  for (const edge of edges) {
    nodeIds.add(edge.source)
    nodeIds.add(edge.target)
  }
  return compactView(
    title,
    [...nodeIds].map(id => toVisualNode(byId.get(id))),
    edges.map(toVisualEdge),
  )
}

function buildSearchIndex() {
  const allowedTypes = new Set([
    'site',
    'brand',
    'model',
    'fault_code',
    'fault_name',
    'system',
    'category',
    'component',
    'reset_mode',
    'action',
  ])
  const topActionIds = new Set(topNodes('action', 700).map(node => node.id))
  const topFaultNameIds = new Set(topNodes('fault_name', 900).map(node => node.id))
  return graph.nodes
    .filter(node => allowedTypes.has(node.type))
    .filter(node => node.type !== 'action' || topActionIds.has(node.id))
    .filter(node => node.type !== 'fault_name' || topFaultNameIds.has(node.id))
    .sort((a, b) => typePriority(a.type) - typePriority(b.type) || b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
      count: node.count ?? 1,
      name: node.properties?.name ?? '',
      source: node.properties?.source ?? node.properties?.path ?? '',
    }))
}

function buildNeighborhoods(index) {
  const neighborhoods = {}
  for (const item of index) {
    const limit = item.type === 'fault_code' ? 42 : item.type === 'action' ? 50 : 70
    const direct = (adjacency.get(item.id) ?? [])
      .sort((a, b) => edgePriority(a.type) - edgePriority(b.type) || b.weight - a.weight)
      .slice(0, limit)
    neighborhoods[item.id] = viewFromEdges(`节点邻域：${item.label}`, direct, [item.id])
  }
  return neighborhoods
}

function buildAdjacency(edges) {
  const map = new Map()
  for (const edge of edges) {
    if (!map.has(edge.source)) map.set(edge.source, [])
    if (!map.has(edge.target)) map.set(edge.target, [])
    map.get(edge.source).push(edge)
    map.get(edge.target).push(edge)
  }
  return map
}

function topNodes(type, limit) {
  return graph.nodes
    .filter(node => node.type === type)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, limit)
}

function countRows(counts, labeler) {
  return Object.entries(counts)
    .map(([key, value]) => ({ key, label: labeler(key), value }))
    .sort((a, b) => b.value - a.value)
}

function topRows(items, labeler) {
  return items.slice(0, 12).map(item => ({
    key: item.id,
    label: labeler(item),
    value: item.count ?? 1,
  }))
}

function compactView(title, nodes, edges) {
  const unique = new Map()
  for (const node of nodes.filter(Boolean)) unique.set(node.id, node)
  const visibleEdges = edges.filter(edge => unique.has(edge.source) && unique.has(edge.target))
  return { title, nodes: [...unique.values()], edges: visibleEdges }
}

function toVisualNode(node) {
  if (!node) return null
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    count: node.count ?? 1,
    name: node.properties?.name ?? '',
    source: node.properties?.source ?? node.properties?.path ?? '',
  }
}

function toVisualEdge(edge) {
  return {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    weight: edge.weight ?? 1,
  }
}

function typePriority(type) {
  return (
    {
      site: 1,
      model: 2,
      brand: 3,
      fault_code: 4,
      fault_name: 5,
      system: 6,
      component: 7,
      category: 8,
      reset_mode: 9,
      action: 10,
    }[type] ?? 20
  )
}

function edgePriority(type) {
  return (
    {
      USES_MODEL: 1,
      MADE_BY: 2,
      OCCURS_ON_MODEL: 3,
      OCCURS_AT_SITE: 4,
      BELONGS_TO_SYSTEM: 5,
      INVOLVES_COMPONENT: 6,
      HAS_RESET_MODE: 7,
      HAS_CATEGORY: 8,
      HAS_NAME: 9,
      REQUIRES_ACTION: 10,
      MAY_BE_CAUSED_BY: 11,
      HAS_SOURCE: 12,
    }[type] ?? 30
  )
}

function labelNode(node) {
  return node.label
}

function labelNodeType(type) {
  return (
    {
      action: '处理动作',
      brand: '品牌',
      category: '分类',
      cause: '原因',
      component: '部件',
      fault_code: '故障码',
      fault_name: '故障名称',
      model: '机型',
      reset_mode: '复位方式',
      site: '风场',
      source_doc: '来源文档',
      system: '系统',
      relation: '关系类型',
      root: '中心',
    }[type] ?? type
  )
}

function labelEdgeType(type) {
  return (
    {
      MADE_BY: '机型品牌',
      OCCURS_AT_SITE: '发生风场',
      INVOLVES_COMPONENT: '涉及部件',
      HAS_CATEGORY: '故障分类',
      BELONGS_TO_SYSTEM: '所属系统',
      HAS_NAME: '故障名称',
      HAS_RESET_MODE: '复位方式',
      OCCURS_ON_MODEL: '发生机型',
      REQUIRES_ACTION: '处理动作',
      MAY_BE_CAUSED_BY: '可能原因',
      HAS_SOURCE: '来源文档',
      USES_MODEL: '风场机型',
    }[type] ?? type
  )
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderHtml(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>风电知识图谱仪表盘</title>
<style>
:root {
  --bg: #f5f7f9;
  --panel: #ffffff;
  --ink: #182230;
  --muted: #667085;
  --line: #d7dde6;
  --soft: #eef3f6;
  --blue: #2563eb;
  --teal: #0f766e;
  --green: #2f7d4e;
  --red: #cf3f4a;
  --gold: #b7791f;
  --violet: #6d5bd0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.app {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto auto minmax(560px, 1fr);
}
header {
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 16px 20px;
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto;
  gap: 16px;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
}
.meta {
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
button, input, select {
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
}
button {
  padding: 0 10px;
  cursor: pointer;
}
button.active {
  border-color: var(--blue);
  background: #eaf1ff;
  color: var(--blue);
}
input {
  width: 280px;
  padding: 0 10px;
}
.summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px;
  padding: 12px 20px;
}
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
}
.metric strong {
  display: block;
  font-size: 22px;
  line-height: 1.1;
}
.metric span {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  border-top: 1px solid var(--line);
}
.stage {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto 1fr;
}
.viewbar {
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 10px 14px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.canvas {
  position: relative;
  min-height: 0;
}
svg {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 520px;
  background: linear-gradient(#f9fbfc, #f3f6f8);
}
.side {
  background: var(--panel);
  border-left: 1px solid var(--line);
  overflow: auto;
  padding: 14px;
}
.panel {
  border-top: 1px solid var(--line);
  padding-top: 12px;
  margin-top: 14px;
}
.section-title {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .02em;
  margin: 0 0 9px;
}
.bars {
  display: grid;
  gap: 7px;
}
.bar-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 54px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar-track {
  height: 9px;
  border-radius: 999px;
  background: var(--soft);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--blue);
}
.bar-value {
  color: var(--muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.legend {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  margin-bottom: 12px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
}
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  flex: none;
}
.detail h2 {
  margin: 0 0 8px;
  font-size: 18px;
  line-height: 1.28;
}
.kv {
  margin: 7px 0;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.kv span {
  color: var(--muted);
}
.results {
  display: grid;
  gap: 6px;
}
.result {
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 8px;
  cursor: pointer;
}
.result:hover {
  border-color: var(--blue);
}
.result b {
  display: block;
  font-size: 13px;
  line-height: 1.35;
}
.result span {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
}
.edge {
  stroke: #a6b1c2;
  stroke-opacity: .7;
  cursor: pointer;
}
.edge.selected {
  stroke: #111827;
  stroke-opacity: 1;
}
.edge-label {
  fill: #5c6678;
  font-size: 10px;
  pointer-events: none;
}
.node circle {
  stroke: #fff;
  stroke-width: 2px;
  filter: drop-shadow(0 2px 3px rgba(24, 34, 48, .18));
}
.node text {
  fill: var(--ink);
  font-size: 12px;
  paint-order: stroke;
  stroke: #fff;
  stroke-width: 4px;
  stroke-linejoin: round;
  pointer-events: none;
}
.node.selected circle {
  stroke: #111827;
  stroke-width: 3px;
}
@media (max-width: 1100px) {
  .summary { grid-template-columns: repeat(3, minmax(120px, 1fr)); }
  main { grid-template-columns: 1fr; grid-template-rows: minmax(520px, 1fr) 420px; }
  .side { border-left: 0; border-top: 1px solid var(--line); }
}
@media (max-width: 720px) {
  header { grid-template-columns: 1fr; }
  .toolbar { justify-content: flex-start; }
  input { width: min(100%, 300px); }
  .summary { grid-template-columns: repeat(2, minmax(120px, 1fr)); padding: 10px; }
}
</style>
</head>
<body>
<div class="app">
  <header>
    <div>
      <h1>风电知识图谱仪表盘</h1>
      <div class="meta">生成时间 ${escapeHtml(data.generatedAt)} · 离线 HTML · 数据来自 wind-llmwiki/graph/knowledge-graph.json</div>
    </div>
    <div class="toolbar">
      <input id="search" placeholder="搜索：新华 / SE8715 / 303804 / 变桨">
      <button id="resetView">重置视图</button>
      <button id="fitView">适配画布</button>
    </div>
  </header>
  <section class="summary">
    <div class="metric"><strong>${formatNumber(data.stats.nodes)}</strong><span>节点</span></div>
    <div class="metric"><strong>${formatNumber(data.stats.edges)}</strong><span>关系</span></div>
    <div class="metric"><strong>${formatNumber(data.stats.faultCodes)}</strong><span>故障码</span></div>
    <div class="metric"><strong>${formatNumber(data.stats.sites)}</strong><span>风场</span></div>
    <div class="metric"><strong>${formatNumber(data.stats.models)}</strong><span>机型</span></div>
    <div class="metric"><strong>${formatNumber(data.stats.faultsWithComponents)}</strong><span>已关联部件故障</span></div>
  </section>
  <main>
    <section class="stage">
      <div class="viewbar">
        <button data-view="overview" class="active">总览</button>
        <button data-view="farmModel">风场机型</button>
        <button data-view="systems">系统故障</button>
        <button data-view="components">部件故障</button>
        <button data-view="resetModes">复位方式</button>
        <button data-view="fault303804">303804</button>
        <button data-view="fault1100007">1100007</button>
      </div>
      <div class="canvas">
        <svg id="graph" role="img" aria-label="风电知识图谱网络视图"></svg>
      </div>
    </section>
    <aside class="side">
      <div class="section-title">节点图例</div>
      <div id="legend" class="legend"></div>
      <div class="section-title">搜索结果</div>
      <div id="results" class="results"></div>
      <div id="detail" class="detail panel"></div>
      <div class="panel">
        <div class="section-title">节点类型分布</div>
        <div id="nodeBars" class="bars"></div>
      </div>
      <div class="panel">
        <div class="section-title">关系类型分布</div>
        <div id="edgeBars" class="bars"></div>
      </div>
      <div class="panel">
        <div class="section-title">高频系统</div>
        <div id="systemBars" class="bars"></div>
      </div>
      <div class="panel">
        <div class="section-title">高频部件</div>
        <div id="componentBars" class="bars"></div>
      </div>
    </aside>
  </main>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const COLORS = {
  root: '#111827',
  relation: '#8b5cf6',
  site: '#2563eb',
  brand: '#0f766e',
  model: '#2f7d4e',
  fault_code: '#cf3f4a',
  fault_name: '#b7791f',
  system: '#6d5bd0',
  category: '#64748b',
  cause: '#c05621',
  action: '#087f8c',
  component: '#d97706',
  reset_mode: '#0284c7',
  source_doc: '#6b7280'
};
const TYPE_LABEL = {
  root: '中心',
  relation: '关系类型',
  site: '风场',
  brand: '品牌',
  model: '机型',
  fault_code: '故障码',
  fault_name: '故障名称',
  system: '系统',
  category: '分类',
  cause: '原因',
  action: '处理动作',
  component: '部件',
  reset_mode: '复位方式',
  source_doc: '来源文档'
};
const EDGE_LABEL = {
  MADE_BY: '机型品牌',
  OCCURS_AT_SITE: '发生风场',
  INVOLVES_COMPONENT: '涉及部件',
  HAS_CATEGORY: '故障分类',
  BELONGS_TO_SYSTEM: '所属系统',
  HAS_NAME: '故障名称',
  HAS_RESET_MODE: '复位方式',
  OCCURS_ON_MODEL: '发生机型',
  REQUIRES_ACTION: '处理动作',
  MAY_BE_CAUSED_BY: '可能原因',
  HAS_SOURCE: '来源文档',
  USES_MODEL: '风场机型'
};
const svg = document.getElementById('graph');
const detail = document.getElementById('detail');
const results = document.getElementById('results');
const search = document.getElementById('search');
let selectedId = null;
let selectedEdgeId = null;
let currentNodes = [];
let currentEdges = [];
let nodeMap = new Map();
let viewport;
let edgeLayer;
let nodeLayer;
let transform = { x: 0, y: 0, scale: 1 };
let dragNode = null;
let panState = null;

function init() {
  renderLegend();
  renderBars('nodeBars', DATA.charts.nodeTypes, '#2563eb');
  renderBars('edgeBars', DATA.charts.edgeTypes, '#0f766e');
  renderBars('systemBars', DATA.charts.systems, '#6d5bd0');
  renderBars('componentBars', DATA.charts.components, '#d97706');
  renderResults('');
  renderView('overview');
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => renderView(button.dataset.view));
  });
  search.addEventListener('input', () => renderResults(search.value));
  document.getElementById('resetView').addEventListener('click', () => renderView('overview'));
  document.getElementById('fitView').addEventListener('click', fitView);
  window.addEventListener('resize', () => renderView(document.querySelector('[data-view].active')?.dataset.view || 'overview'));
}

function renderView(name) {
  selectedId = null;
  selectedEdgeId = null;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  draw(DATA.views[name]);
}

function draw(view) {
  svg.replaceChildren();
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 680);
  const height = Math.max(rect.height, 520);
  svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);
  currentNodes = view.nodes.map(node => ({ ...node }));
  currentEdges = view.edges.map(edge => ({ ...edge, id: edgeKey(edge) }));
  nodeMap = new Map(currentNodes.map(node => [node.id, node]));
  layout(currentNodes, currentEdges, width, height);
  viewport = el('g', { class: 'viewport' });
  edgeLayer = el('g');
  nodeLayer = el('g');
  viewport.append(edgeLayer, nodeLayer);
  svg.append(viewport);

  for (const edge of currentEdges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    const line = el('line', {
      class: 'edge',
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      'stroke-width': Math.max(1, Math.min(5, Math.sqrt(edge.weight || 1))),
    });
    line.addEventListener('click', event => {
      event.stopPropagation();
      selectedEdgeId = edge.id;
      selectedId = null;
      showEdge(edge);
      updateSelection();
    });
    edge.element = line;
    edgeLayer.append(line);
    if (currentEdges.length <= 100) {
      const label = el('text', {
        class: 'edge-label',
        x: (source.x + target.x) / 2,
        y: (source.y + target.y) / 2 - 5,
        'text-anchor': 'middle',
      }, EDGE_LABEL[edge.type] || edge.type);
      edge.labelElement = label;
      edgeLayer.append(label);
    }
  }

  for (const node of currentNodes) {
    const group = el('g', { class: 'node', transform: \`translate(\${node.x},\${node.y})\` });
    const radius = radiusFor(node);
    group.append(el('circle', { r: radius, fill: COLORS[node.type] || '#64748b' }));
    group.append(el('text', { x: radius + 7, y: 4 }, trim(node.label, node.type === 'action' ? 24 : 18)));
    group.addEventListener('pointerdown', event => startDrag(event, node));
    group.addEventListener('click', event => {
      event.stopPropagation();
      selectedId = node.id;
      selectedEdgeId = null;
      showNode(node);
      updateSelection();
    });
    node.element = group;
    nodeLayer.append(group);
  }

  transform = { x: 0, y: 0, scale: 1 };
  installPanZoom();
  updatePositions();
  fitView();
  showNode(currentNodes[0]);
}

function layout(nodes, edges, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const center = nodes.find(node => node.type === 'root') || nodes[0];
  if (center) {
    center.x = centerX;
    center.y = centerY;
  }
  const groups = groupBy(nodes.filter(node => node !== center), node => node.type);
  const types = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
  types.forEach((type, typeIndex) => {
    const items = groups[type];
    const ring = 150 + typeIndex * 72;
    items.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, items.length) + typeIndex * 0.47;
      node.x = centerX + Math.cos(angle) * Math.min(ring, width * 0.42);
      node.y = centerY + Math.sin(angle) * Math.min(ring, height * 0.42);
    });
  });
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (let pass = 0; pass < 90; pass++) {
    for (const edge of edges) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = source.type === 'root' || target.type === 'root' ? 210 : 150;
      const force = (distance - desired) * 0.004;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      if (source.type !== 'root') {
        source.x += fx;
        source.y += fy;
      }
      if (target.type !== 'root') {
        target.x -= fx;
        target.y -= fy;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        if (distance > 78) continue;
        const push = (78 - distance) * 0.015;
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        if (a.type !== 'root') {
          a.x -= fx;
          a.y -= fy;
        }
        if (b.type !== 'root') {
          b.x += fx;
          b.y += fy;
        }
      }
    }
  }
}

function fitView() {
  if (!currentNodes.length) return;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 680);
  const height = Math.max(rect.height, 520);
  const xs = currentNodes.map(node => node.x);
  const ys = currentNodes.map(node => node.y);
  const minX = Math.min(...xs) - 120;
  const maxX = Math.max(...xs) + 180;
  const minY = Math.min(...ys) - 80;
  const maxY = Math.max(...ys) + 80;
  const scale = Math.min(1.35, Math.max(0.35, Math.min(width / (maxX - minX), height / (maxY - minY))));
  transform = {
    scale,
    x: (width - (minX + maxX) * scale) / 2,
    y: (height - (minY + maxY) * scale) / 2,
  };
  applyTransform();
}

function renderLegend() {
  const legend = document.getElementById('legend');
  legend.replaceChildren(...Object.entries(TYPE_LABEL).map(([type, label]) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = \`<span class="swatch" style="background:\${COLORS[type] || '#64748b'}"></span><span>\${escapeHtml(label)}</span>\`;
    return item;
  }));
}

function renderBars(id, rows, color) {
  const max = Math.max(1, ...rows.map(row => row.value));
  const host = document.getElementById(id);
  host.replaceChildren(...rows.slice(0, 12).map(row => {
    const div = document.createElement('div');
    div.className = 'bar-row';
    div.innerHTML = \`
      <div class="bar-label" title="\${escapeHtml(row.label)}">\${escapeHtml(row.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:\${Math.max(3, row.value / max * 100)}%;background:\${color}"></div></div>
      <div class="bar-value">\${formatNumber(row.value)}</div>
    \`;
    return div;
  }));
}

function renderResults(query) {
  const q = query.trim().toLowerCase();
  const items = q
    ? DATA.searchIndex.filter(item =>
        item.label.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.type.toLowerCase().includes(q)
      ).slice(0, 14)
    : DATA.searchIndex.slice(0, 10);
  results.replaceChildren(...items.map(item => {
    const div = document.createElement('div');
    div.className = 'result';
    div.innerHTML = \`<b>\${escapeHtml(item.label)}</b><span>\${escapeHtml(TYPE_LABEL[item.type] || item.type)} · \${formatNumber(item.count)}\${item.name ? ' · ' + escapeHtml(item.name) : ''}</span>\`;
    div.addEventListener('click', () => {
      document.querySelectorAll('[data-view]').forEach(button => button.classList.remove('active'));
      selectedId = item.id;
      draw(DATA.neighborhoods[item.id] || { title: item.label, nodes: [item], edges: [] });
      const node = nodeMap.get(item.id) || item;
      selectedId = item.id;
      showNode(node);
      updateSelection();
    });
    return div;
  }));
}

function showNode(node) {
  if (!node) {
    detail.innerHTML = '<h2>无节点</h2>';
    return;
  }
  const connected = currentEdges.filter(edge => edge.source === node.id || edge.target === node.id);
  detail.innerHTML = \`
    <h2>\${escapeHtml(node.label)}</h2>
    <div class="kv"><span>类型：</span>\${escapeHtml(TYPE_LABEL[node.type] || node.type)}</div>
    <div class="kv"><span>权重：</span>\${formatNumber(node.count || 0)}</div>
    \${node.name ? \`<div class="kv"><span>名称：</span>\${escapeHtml(node.name)}</div>\` : ''}
    \${node.source ? \`<div class="kv"><span>来源：</span>\${escapeHtml(node.source)}</div>\` : ''}
    <div class="kv"><span>当前视图关系：</span>\${formatNumber(connected.length)}</div>
    <div class="kv"><span>节点 ID：</span>\${escapeHtml(node.id)}</div>
  \`;
}

function showEdge(edge) {
  const source = nodeMap.get(edge.source);
  const target = nodeMap.get(edge.target);
  detail.innerHTML = \`
    <h2>\${escapeHtml(EDGE_LABEL[edge.type] || edge.type)}</h2>
    <div class="kv"><span>起点：</span>\${escapeHtml(source?.label ?? edge.source)}</div>
    <div class="kv"><span>终点：</span>\${escapeHtml(target?.label ?? edge.target)}</div>
    <div class="kv"><span>权重：</span>\${formatNumber(edge.weight || 1)}</div>
    <div class="kv"><span>关系类型：</span>\${escapeHtml(edge.type)}</div>
  \`;
}

function installPanZoom() {
  svg.onpointerdown = event => {
    if (event.target.closest && event.target.closest('.node')) return;
    panState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: transform.x,
      originY: transform.y,
    };
    svg.setPointerCapture(event.pointerId);
  };
  svg.onpointermove = event => {
    if (dragNode) {
      const point = screenToGraph(event.clientX, event.clientY);
      dragNode.x = point.x;
      dragNode.y = point.y;
      updatePositions();
      return;
    }
    if (!panState) return;
    transform.x = panState.originX + event.clientX - panState.startX;
    transform.y = panState.originY + event.clientY - panState.startY;
    applyTransform();
  };
  svg.onpointerup = event => {
    dragNode = null;
    if (panState) {
      try { svg.releasePointerCapture(panState.pointerId); } catch {}
      panState = null;
    }
  };
  svg.onpointercancel = () => {
    dragNode = null;
    panState = null;
  };
  svg.onwheel = event => {
    event.preventDefault();
    const before = screenToGraph(event.clientX, event.clientY);
    transform.scale = clamp(transform.scale * (event.deltaY < 0 ? 1.12 : 0.89), 0.25, 4);
    const after = screenToGraph(event.clientX, event.clientY);
    transform.x += (after.x - before.x) * transform.scale;
    transform.y += (after.y - before.y) * transform.scale;
    applyTransform();
  };
}

function startDrag(event, node) {
  event.preventDefault();
  event.stopPropagation();
  dragNode = node;
  selectedId = node.id;
  selectedEdgeId = null;
  showNode(node);
  updateSelection();
  svg.setPointerCapture(event.pointerId);
}

function updatePositions() {
  for (const edge of currentEdges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target || !edge.element) continue;
    edge.element.setAttribute('x1', source.x);
    edge.element.setAttribute('y1', source.y);
    edge.element.setAttribute('x2', target.x);
    edge.element.setAttribute('y2', target.y);
    if (edge.labelElement) {
      edge.labelElement.setAttribute('x', (source.x + target.x) / 2);
      edge.labelElement.setAttribute('y', (source.y + target.y) / 2 - 5);
    }
  }
  for (const node of currentNodes) {
    if (node.element) node.element.setAttribute('transform', \`translate(\${node.x},\${node.y})\`);
  }
  applyTransform();
}

function updateSelection() {
  for (const node of currentNodes) {
    if (node.element) node.element.classList.toggle('selected', node.id === selectedId);
  }
  for (const edge of currentEdges) {
    if (edge.element) edge.element.classList.toggle('selected', edge.id === selectedEdgeId);
  }
}

function applyTransform() {
  if (viewport) viewport.setAttribute('transform', \`translate(\${transform.x},\${transform.y}) scale(\${transform.scale})\`);
}

function screenToGraph(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - transform.x) / transform.scale,
    y: (clientY - rect.top - transform.y) / transform.scale,
  };
}

function radiusFor(node) {
  return Math.max(7, Math.min(24, 7 + Math.sqrt(node.count || 1) * 0.45));
}

function edgeKey(edge) {
  return \`\${edge.source}->\${edge.type}->\${edge.target}\`;
}

function groupBy(items, keyer) {
  return items.reduce((groups, item) => {
    const key = keyer(item);
    (groups[key] ||= []).push(item);
    return groups;
  }, {});
}

function el(name, attrs = {}, text = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function trim(value, max) {
  const text = String(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(value);
}

init();
</script>
</body>
</html>`
}

import { readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GRAPH_FILE = join(ROOT, 'wind-llmwiki', 'graph', 'knowledge-graph.json')
const OUT_FILE = join(ROOT, 'wind-llmwiki', 'graph', 'visualization.html')

const graph = JSON.parse(await readFile(GRAPH_FILE, 'utf8'))
const byId = new Map(graph.nodes.map(node => [node.id, node]))

const visual = {
  generatedAt: graph.generatedAt,
  stats: {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    countsByNodeType: graph.indexes.countsByNodeType,
    countsByEdgeType: graph.indexes.countsByEdgeType,
  },
  views: {
    overview: buildOverviewView(),
    farmModel: buildFarmModelView(),
    fault1100007: buildFaultCodeView('1100007'),
    systems: buildSystemView(),
    components: buildComponentView(),
  },
  searchIndex: buildSearchIndex(),
  neighborhoods: buildNeighborhoods(),
}

await writeFile(OUT_FILE, renderHtml(visual), 'utf8')
console.log(`Wrote ${OUT_FILE}`)

function buildOverviewView() {
  const nodes = []
  const edges = []
  const center = addSynthetic(nodes, 'overview:center', '风电知识图谱', 'root', 0)

  for (const [type, count] of Object.entries(graph.indexes.countsByNodeType)) {
    const id = addSynthetic(nodes, `overview:type:${type}`, `${labelType(type)} ${count}`, type, count)
    edges.push({ source: center, target: id, type: 'HAS_NODE_TYPE', weight: count })
  }

  for (const item of graph.indexes.topSystems.slice(0, 14)) {
    const id = item.id
    nodes.push(toVisualNode(byId.get(id), item.count))
    edges.push({ source: 'overview:type:system', target: id, type: 'TOP_SYSTEM', weight: item.count })
  }

  for (const item of graph.indexes.topActions.slice(0, 12)) {
    const id = item.id
    nodes.push(toVisualNode(byId.get(id), item.count))
    edges.push({ source: 'overview:type:action', target: id, type: 'TOP_ACTION', weight: item.count })
  }

  for (const item of (graph.indexes.topComponents ?? []).slice(0, 12)) {
    const id = item.id
    nodes.push(toVisualNode(byId.get(id), item.count))
    edges.push({ source: 'overview:type:component', target: id, type: 'TOP_COMPONENT', weight: item.count })
  }

  return compactView('全局概览', nodes, edges)
}

function buildFarmModelView() {
  const wantedSites = new Set([
    '新华',
    '(一期)通榆团结风电场',
    '华能四平风电场一期',
    '同发',
    '镇赉',
    '洮北',
    '良井子',
    '裕民',
  ])
  const siteIds = graph.nodes
    .filter(node => node.type === 'site' && wantedSites.has(node.label))
    .map(node => node.id)
  const selectedEdges = graph.edges.filter(edge =>
    (siteIds.includes(edge.source) && edge.type === 'USES_MODEL') ||
    edge.type === 'MADE_BY',
  )
  const modelIds = new Set(
    selectedEdges
      .filter(edge => edge.type === 'USES_MODEL')
      .map(edge => edge.target),
  )
  const brandEdges = graph.edges.filter(
    edge => modelIds.has(edge.source) && edge.type === 'MADE_BY',
  )
  const edgeList = [...selectedEdges.filter(edge => edge.type === 'USES_MODEL'), ...brandEdges]
  const nodeIds = new Set(edgeList.flatMap(edge => [edge.source, edge.target]))
  const nodes = [...nodeIds].map(id => toVisualNode(byId.get(id)))
  return compactView('风场-机型-品牌', nodes, edgeList.map(toVisualEdge))
}

function buildFaultCodeView(code) {
  const fault = graph.nodes.find(node => node.type === 'fault_code' && node.label === code)
  if (!fault) return compactView(`故障码 ${code}`, [], [])

  const firstHop = graph.edges.filter(edge => edge.source === fault.id)
  const secondHop = graph.edges.filter(edge =>
    firstHop.some(item => item.target === edge.source) &&
    ['MADE_BY'].includes(edge.type),
  )
  const selectedEdges = [...firstHop, ...secondHop].slice(0, 80)
  const nodeIds = new Set([fault.id, ...selectedEdges.flatMap(edge => [edge.source, edge.target])])
  return compactView(
    `故障码 ${code}`,
    [...nodeIds].map(id => toVisualNode(byId.get(id))),
    selectedEdges.map(toVisualEdge),
  )
}

function buildSystemView() {
  const systemIds = new Set(graph.indexes.topSystems.slice(0, 12).map(item => item.id))
  const systemEdges = graph.edges
    .filter(edge => systemIds.has(edge.target) && edge.type === 'BELONGS_TO_SYSTEM')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 120)
  const nodeIds = new Set([...systemIds, ...systemEdges.flatMap(edge => [edge.source, edge.target])])
  return compactView('系统-故障码', [...nodeIds].map(id => toVisualNode(byId.get(id))), systemEdges.map(toVisualEdge))
}

function buildComponentView() {
  const componentIds = new Set((graph.indexes.topComponents ?? []).slice(0, 16).map(item => item.id))
  const componentEdges = graph.edges
    .filter(edge => componentIds.has(edge.target) && edge.type === 'INVOLVES_COMPONENT')
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 140)
  const nodeIds = new Set([...componentIds, ...componentEdges.flatMap(edge => [edge.source, edge.target])])
  return compactView('部件-故障码', [...nodeIds].map(id => toVisualNode(byId.get(id))), componentEdges.map(toVisualEdge))
}

function buildSearchIndex() {
  const allowedTypes = new Set(['site', 'brand', 'model', 'fault_code', 'system', 'category', 'action', 'component', 'reset_mode'])
  const actionLimit = 800
  const actions = graph.nodes
    .filter(node => node.type === 'action')
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, actionLimit)
  const actionIds = new Set(actions.map(node => node.id))

  return graph.nodes
    .filter(node => allowedTypes.has(node.type))
    .filter(node => node.type !== 'action' || actionIds.has(node.id))
    .sort((a, b) => searchTypePriority(a.type) - searchTypePriority(b.type) || b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
      count: node.count,
      name: node.properties?.name ?? '',
    }))
}

function buildNeighborhoods() {
  const index = buildSearchIndex()
  const bySearchId = new Set(index.map(item => item.id))
  const adjacency = new Map()
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, [])
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, [])
    adjacency.get(edge.source).push(edge)
    adjacency.get(edge.target).push(edge)
  }
  const neighborhoods = {}

  for (const item of index) {
    const directLimit = item.type === 'fault_code' ? 18 : item.type === 'action' ? 35 : 55
    const directEdges = [...(adjacency.get(item.id) ?? [])]
      .sort((a, b) => edgePriority(a.type) - edgePriority(b.type) || b.weight - a.weight)
      .slice(0, directLimit)
    const nodeIds = new Set([item.id, ...directEdges.flatMap(edge => [edge.source, edge.target])])

    if (item.type === 'fault_code' || item.type === 'action') {
      neighborhoods[item.id] = compactView(
        `节点关系：${item.label}`,
        [...nodeIds].map(id => toVisualNode(byId.get(id))),
        directEdges.map(toVisualEdge),
      )
      continue
    }

    const secondHopSeeds = directEdges
      .map(edge => (edge.source === item.id ? edge.target : edge.source))
      .filter(id => {
        const node = byId.get(id)
        return node && ['site', 'model', 'brand', 'system', 'fault_code', 'component', 'reset_mode'].includes(node.type)
      })
      .slice(0, 8)

    const secondHopEdges = secondHopSeeds
      .flatMap(id => adjacency.get(id) ?? [])
      .filter(edge => bySearchId.has(edge.source) || bySearchId.has(edge.target))
      .sort((a, b) => edgePriority(a.type) - edgePriority(b.type) || b.weight - a.weight)
      .slice(0, 20)

    for (const edge of secondHopEdges) {
      directEdges.push(edge)
      nodeIds.add(edge.source)
      nodeIds.add(edge.target)
    }

    neighborhoods[item.id] = compactView(
      `节点关系：${item.label}`,
      [...nodeIds].map(id => toVisualNode(byId.get(id))),
      directEdges.map(toVisualEdge),
    )
  }

  return neighborhoods
}

function searchTypePriority(type) {
  return (
    {
      site: 1,
      model: 2,
      brand: 3,
      fault_code: 4,
      system: 5,
      category: 6,
      component: 7,
      reset_mode: 8,
      action: 9,
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
      REQUIRES_ACTION: 6,
      MAY_BE_CAUSED_BY: 7,
      HAS_NAME: 8,
      HAS_CATEGORY: 9,
      INVOLVES_COMPONENT: 10,
      HAS_RESET_MODE: 11,
      HAS_SOURCE: 12,
    }[type] ?? 20
  )
}

function compactView(title, nodes, edges) {
  const uniqueNodes = new Map()
  for (const node of nodes.filter(Boolean)) uniqueNodes.set(node.id, node)
  return {
    title,
    nodes: [...uniqueNodes.values()],
    edges: edges.filter(edge => uniqueNodes.has(edge.source) && uniqueNodes.has(edge.target)),
  }
}

function addSynthetic(nodes, id, label, type, count) {
  nodes.push({ id, label, type, count, name: '', source: '' })
  return id
}

function toVisualNode(node, overrideCount) {
  if (!node) return null
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    count: overrideCount ?? node.count ?? 1,
    name: node.properties?.name ?? '',
    source: node.properties?.source ?? node.properties?.path ?? '',
  }
}

function toVisualEdge(edge) {
  return {
    source: edge.source,
    target: edge.target,
    type: edge.type,
    weight: edge.weight,
  }
}

function labelType(type) {
  return (
    {
      site: '风场',
      brand: '品牌',
      model: '机型',
      fault_code: '故障码',
      fault_name: '故障名称',
      system: '系统',
      category: '分类',
      cause: '原因',
      action: '处理',
      component: '部件',
      reset_mode: '复位',
      source_doc: '来源',
    }[type] ?? type
  )
}

function renderHtml(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>风电知识图谱</title>
<style>
:root {
  --bg: #f7f8fa;
  --panel: #ffffff;
  --ink: #1f2933;
  --muted: #667085;
  --line: #d8dee8;
  --blue: #2f6fed;
  --teal: #168f8b;
  --green: #27864f;
  --gold: #b7791f;
  --red: #cf3f4a;
  --violet: #7657c8;
  --orange: #c05621;
  --cyan: #057a85;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.app {
  height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
}
header {
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  padding: 12px 18px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: 20px;
  line-height: 1.25;
  font-weight: 700;
}
.meta {
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
}
button {
  height: 34px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
  border-radius: 6px;
  padding: 0 10px;
  font-size: 13px;
  cursor: pointer;
}
button.active {
  border-color: var(--blue);
  color: var(--blue);
  background: #edf4ff;
}
input {
  width: 240px;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 10px;
  font-size: 13px;
}
main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
}
.stage {
  position: relative;
  min-width: 0;
  min-height: 0;
}
svg {
  width: 100%;
  height: 100%;
  display: block;
}
.sidebar {
  border-left: 1px solid var(--line);
  background: var(--panel);
  overflow: auto;
  padding: 14px;
}
.section-title {
  font-size: 13px;
  color: var(--muted);
  margin: 4px 0 8px;
}
.stat-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 16px;
}
.stat {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
}
.stat strong {
  display: block;
  font-size: 18px;
}
.stat span {
  color: var(--muted);
  font-size: 12px;
}
.detail {
  border-top: 1px solid var(--line);
  padding-top: 12px;
  margin-top: 12px;
}
.detail h2 {
  margin: 0 0 8px;
  font-size: 17px;
  line-height: 1.3;
}
.kv {
  margin: 7px 0;
  font-size: 13px;
  line-height: 1.45;
}
.kv span {
  color: var(--muted);
}
.edit-panel {
  border-top: 1px solid var(--line);
  padding-top: 12px;
  margin-top: 12px;
}
.edit-grid {
  display: grid;
  gap: 8px;
}
.edit-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.edit-grid input {
  width: 100%;
}
.pill {
  min-height: 30px;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.results {
  display: grid;
  gap: 6px;
}
.result {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px;
  cursor: pointer;
}
.result:hover { border-color: var(--blue); }
.result b {
  display: block;
  font-size: 13px;
  line-height: 1.35;
}
.result span {
  color: var(--muted);
  font-size: 12px;
}
.edge {
  stroke: #a8b3c5;
  stroke-opacity: .68;
  cursor: pointer;
}
.edge.selected {
  stroke: #111827;
  stroke-opacity: 1;
}
.edge-label {
  fill: #667085;
  font-size: 10px;
  pointer-events: none;
}
.node circle {
  stroke: #fff;
  stroke-width: 2px;
  filter: drop-shadow(0 2px 3px rgba(31, 41, 51, .16));
}
.node text {
  font-size: 12px;
  fill: var(--ink);
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
@media (max-width: 900px) {
  header { grid-template-columns: 1fr; }
  .toolbar { justify-content: flex-start; }
  input { width: min(100%, 280px); }
  main { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 1fr) 300px; }
  .sidebar { border-left: 0; border-top: 1px solid var(--line); }
}
</style>
</head>
<body>
<div class="app">
  <header>
    <div>
      <h1>风电知识图谱</h1>
      <div class="meta">节点 ${data.stats.nodes} · 关系 ${data.stats.edges} · 生成时间 ${escapeHtml(data.generatedAt)}</div>
    </div>
    <div class="toolbar">
      <button data-view="overview" class="active">全局</button>
      <button data-view="farmModel">风场机型</button>
      <button data-view="fault1100007">1100007</button>
      <button data-view="systems">系统故障</button>
      <button data-view="components">部件故障</button>
      <button id="connectMode">连线模式</button>
      <button id="resetView">重置</button>
      <input id="search" placeholder="搜索：新华 / SE8715 / 变桨 / 1100007">
    </div>
  </header>
  <main>
    <div class="stage">
      <svg id="graph" role="img" aria-label="风电知识图谱可视化"></svg>
    </div>
    <aside class="sidebar">
      <div class="section-title">统计</div>
      <div class="stat-grid">
        <div class="stat"><strong>${data.stats.nodes}</strong><span>节点</span></div>
        <div class="stat"><strong>${data.stats.edges}</strong><span>关系</span></div>
        <div class="stat"><strong>${data.stats.countsByNodeType.site ?? 0}</strong><span>风场</span></div>
        <div class="stat"><strong>${data.stats.countsByNodeType.fault_code ?? 0}</strong><span>故障码</span></div>
      </div>
      <div class="section-title">搜索结果</div>
      <div id="results" class="results"></div>
      <div id="detail" class="detail"></div>
      <div class="edit-panel">
        <div class="section-title">编辑关系</div>
        <div class="edit-grid">
          <div class="edit-row">
            <button id="setSource">设为起点</button>
            <button id="setTarget">设为终点</button>
          </div>
          <div class="pill">起点：<span id="sourceLabel">未选择</span></div>
          <div class="pill">终点：<span id="targetLabel">未选择</span></div>
          <input id="edgeTypeInput" value="RELATED_TO" placeholder="关系类型，例如 RELATED_TO">
          <button id="addEdge">新增关系</button>
          <button id="deleteEdge">删除选中关系</button>
          <button id="exportGraph">导出当前编辑图谱 JSON</button>
        </div>
      </div>
    </aside>
  </main>
</div>
<script>
const DATA = ${JSON.stringify(data)};
const COLORS = {
  root: '#111827',
  site: '#2f6fed',
  brand: '#168f8b',
  model: '#27864f',
  fault_code: '#cf3f4a',
  fault_name: '#b7791f',
  system: '#7657c8',
  category: '#64748b',
  cause: '#c05621',
  action: '#0f766e',
  component: '#d97706',
  reset_mode: '#057a85',
  source_doc: '#6b7280'
};
const TYPE_LABEL = {
  root: '根',
  site: '风场',
  brand: '品牌',
  model: '机型',
  fault_code: '故障码',
  fault_name: '故障名称',
  system: '系统',
  category: '分类',
  cause: '原因',
  action: '处理',
  component: '部件',
  reset_mode: '复位',
  source_doc: '来源'
};
const svg = document.getElementById('graph');
const detail = document.getElementById('detail');
const results = document.getElementById('results');
const search = document.getElementById('search');
const resetView = document.getElementById('resetView');
const connectModeButton = document.getElementById('connectMode');
const setSourceButton = document.getElementById('setSource');
const setTargetButton = document.getElementById('setTarget');
const addEdgeButton = document.getElementById('addEdge');
const deleteEdgeButton = document.getElementById('deleteEdge');
const exportGraphButton = document.getElementById('exportGraph');
const edgeTypeInput = document.getElementById('edgeTypeInput');
const sourceLabel = document.getElementById('sourceLabel');
const targetLabel = document.getElementById('targetLabel');
let activeView = 'overview';
let selectedId = null;
let selectedEdgeId = null;
let editSourceId = null;
let editTargetId = null;
let connectModeEnabled = false;
let pendingConnectSourceId = null;
let currentView = null;
let currentNodes = [];
let currentEdges = [];
let currentNodeMap = new Map();
let viewport = null;
let edgeLayer = null;
let nodeLayer = null;
let transform = { x: 0, y: 0, scale: 1 };
let dragNode = null;
let panState = null;

function render(viewName) {
  activeView = viewName;
  selectedId = null;
  selectedEdgeId = null;
  for (const button of document.querySelectorAll('button[data-view]')) {
    button.classList.toggle('active', button.dataset.view === viewName);
  }
  const view = DATA.views[viewName];
  drawGraph(view);
  showDetail(view.nodes[0]);
  renderResults(search.value);
}

function drawGraph(view) {
  currentView = view;
  svg.replaceChildren();
  const rect = svg.getBoundingClientRect();
  const width = Math.max(rect.width, 640);
  const height = Math.max(rect.height, 420);
  svg.setAttribute('viewBox', \`0 0 \${width} \${height}\`);

  currentNodes = view.nodes.map(node => ({ ...node }));
  currentEdges = view.edges.map(edge => ({ ...edge }));
  currentNodeMap = new Map(currentNodes.map(node => [node.id, node]));
  layout(currentNodes, currentEdges, width, height);
  transform = { x: 0, y: 0, scale: 1 };

  viewport = el('g', { class: 'viewport' });
  edgeLayer = el('g');
  nodeLayer = el('g');
  viewport.append(edgeLayer, nodeLayer);
  svg.append(viewport);

  for (const edge of currentEdges) {
    const s = currentNodeMap.get(edge.source);
    const t = currentNodeMap.get(edge.target);
    if (!s || !t) continue;
    const line = el('line', {
      x1: s.x, y1: s.y, x2: t.x, y2: t.y,
      class: 'edge',
      'stroke-width': Math.max(1, Math.min(5, Math.sqrt(edge.weight || 1)))
    });
    edge.element = line;
    line.addEventListener('click', event => {
      event.stopPropagation();
      selectedEdgeId = edge.id || edgeKey(edge);
      selectedId = null;
      showEdgeDetail(edge);
      updateSelection();
    });
    edgeLayer.append(line);
    if (currentEdges.length < 90) {
      const label = el('text', {
        x: (s.x + t.x) / 2,
        y: (s.y + t.y) / 2 - 4,
        class: 'edge-label',
        'text-anchor': 'middle'
      }, edge.type);
      edge.labelElement = label;
      edgeLayer.append(label);
    }
  }

  for (const node of currentNodes) {
    const g = el('g', { class: \`node\${node.id === selectedId ? ' selected' : ''}\`, transform: \`translate(\${node.x},\${node.y})\` });
    const radius = nodeRadius(node);
    g.append(el('circle', { r: radius, fill: COLORS[node.type] || '#64748b' }));
    g.append(el('text', { x: radius + 6, y: 4 }, trimLabel(node.label, node.type === 'fault_code' ? 18 : 22)));
    node.element = g;
    g.addEventListener('pointerdown', event => startNodeDrag(event, node));
    g.addEventListener('click', event => {
      event.stopPropagation();
      if (connectModeEnabled) {
        handleConnectModeNodeClick(node);
        return;
      }
      selectedId = node.id;
      selectedEdgeId = null;
      showDetail(node);
      updateSelection();
    });
    nodeLayer.append(g);
  }

  installCanvasInteractions();
  updatePositions();
}

function layout(nodes, edges, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const groups = groupBy(nodes, node => node.type);
  const order = Object.keys(groups).sort((a, b) => (groups[b].length - groups[a].length));
  const rings = Math.max(2, order.length);
  order.forEach((type, index) => {
    const items = groups[type];
    const radius = type === 'root' ? 0 : Math.min(width, height) * (0.18 + 0.32 * (index / rings));
    items.forEach((node, i) => {
      const angle = (Math.PI * 2 * i) / Math.max(1, items.length) + index * 0.41;
      node.x = centerX + Math.cos(angle) * radius;
      node.y = centerY + Math.sin(angle) * radius;
    });
  });

  const linked = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  nodes.forEach((node, i) => {
    if (!linked.has(node.id)) {
      node.x = 80 + (i % 8) * 120;
      node.y = 70 + Math.floor(i / 8) * 70;
    }
  });

  for (let pass = 0; pass < 80; pass++) {
    for (const edge of edges) {
      const s = nodes.find(node => node.id === edge.source);
      const t = nodes.find(node => node.id === edge.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const target = 155;
      const force = (dist - target) * 0.004;
      const fx = dx / dist * force;
      const fy = dy / dist * force;
      s.x += fx; s.y += fy;
      t.x -= fx; t.y -= fy;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        if (dist > 82) continue;
        const push = (82 - dist) * 0.014;
        const fx = dx / dist * push;
        const fy = dy / dist * push;
        a.x -= fx; a.y -= fy;
        b.x += fx; b.y += fy;
      }
    }
  }
  for (const node of nodes) {
    node.x = clamp(node.x, 36, width - 170);
    node.y = clamp(node.y, 34, height - 34);
  }
}

function showDetail(node) {
  if (!node) {
    detail.innerHTML = '<h2>无节点</h2>';
    return;
  }
  const connected = currentEdges.filter(edge => edge.source === node.id || edge.target === node.id);
  detail.innerHTML = \`
    <h2>\${escapeHtml(node.label)}</h2>
    <div class="kv"><span>类型：</span>\${escapeHtml(TYPE_LABEL[node.type] || node.type)}</div>
    <div class="kv"><span>权重：</span>\${escapeHtml(String(node.count || 0))}</div>
    \${node.name ? \`<div class="kv"><span>名称：</span>\${escapeHtml(node.name)}</div>\` : ''}
    \${node.source ? \`<div class="kv"><span>来源：</span>\${escapeHtml(node.source)}</div>\` : ''}
    <div class="kv"><span>当前视图关系数：</span>\${connected.length}</div>
    <div class="kv"><span>节点 ID：</span>\${escapeHtml(node.id)}</div>
  \`;
}

function showEdgeDetail(edge) {
  const source = currentNodeMap.get(edge.source);
  const target = currentNodeMap.get(edge.target);
  detail.innerHTML = \`
    <h2>\${escapeHtml(edge.type)}</h2>
    <div class="kv"><span>起点：</span>\${escapeHtml(source?.label ?? edge.source)}</div>
    <div class="kv"><span>终点：</span>\${escapeHtml(target?.label ?? edge.target)}</div>
    <div class="kv"><span>权重：</span>\${escapeHtml(String(edge.weight || 1))}</div>
    <div class="kv"><span>来源：</span>\${edge.manual ? '手动新增' : '图谱生成'}</div>
    <div class="kv"><span>关系 ID：</span>\${escapeHtml(edge.id || edgeKey(edge))}</div>
  \`;
}

function renderResults(query) {
  const q = query.trim().toLowerCase();
  const items = q
    ? DATA.searchIndex.filter(item =>
        item.label.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.type.toLowerCase().includes(q)
      ).slice(0, 12)
    : DATA.searchIndex.slice(0, 12);
  results.replaceChildren(...items.map(item => {
    const div = document.createElement('div');
    div.className = 'result';
    div.innerHTML = \`<b>\${escapeHtml(item.label)}</b><span>\${escapeHtml(TYPE_LABEL[item.type] || item.type)} · \${item.count}</span>\`;
    div.addEventListener('click', () => focusSearchResult(item));
    return div;
  }));
}

function focusSearchResult(item) {
  const view = DATA.neighborhoods[item.id] || { title: '搜索', nodes: [item], edges: [] };
  activeView = 'search';
  for (const button of document.querySelectorAll('button[data-view]')) button.classList.remove('active');
  selectedId = item.id;
  drawGraph(view);
  const selected = currentNodeMap.get(item.id) || item;
  showDetail(selected);
  updateSelection();
}

function installCanvasInteractions() {
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
    if (dragNode) {
      dragNode = null;
    }
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
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    transform.scale = clamp(transform.scale * factor, 0.35, 3.5);
    const after = screenToGraph(event.clientX, event.clientY);
    transform.x += (after.x - before.x) * transform.scale;
    transform.y += (after.y - before.y) * transform.scale;
    applyTransform();
  };
}

function startNodeDrag(event, node) {
  event.preventDefault();
  event.stopPropagation();
  dragNode = node;
  selectedId = node.id;
  selectedEdgeId = null;
  showDetail(node);
  updateSelection();
  svg.setPointerCapture(event.pointerId);
}

function screenToGraph(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (clientX - rect.left - transform.x) / transform.scale,
    y: (clientY - rect.top - transform.y) / transform.scale,
  };
}

function applyTransform() {
  if (!viewport) return;
  viewport.setAttribute('transform', \`translate(\${transform.x},\${transform.y}) scale(\${transform.scale})\`);
}

function updatePositions() {
  for (const edge of currentEdges) {
    const s = currentNodeMap.get(edge.source);
    const t = currentNodeMap.get(edge.target);
    if (!s || !t || !edge.element) continue;
    edge.element.setAttribute('x1', s.x);
    edge.element.setAttribute('y1', s.y);
    edge.element.setAttribute('x2', t.x);
    edge.element.setAttribute('y2', t.y);
    if (edge.labelElement) {
      edge.labelElement.setAttribute('x', (s.x + t.x) / 2);
      edge.labelElement.setAttribute('y', (s.y + t.y) / 2 - 4);
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
    if (edge.element) edge.element.classList.toggle('selected', (edge.id || edgeKey(edge)) === selectedEdgeId);
  }
  updateEditLabels();
}

function selectedNode() {
  return selectedId ? currentNodeMap.get(selectedId) : null;
}

function setEndpoint(kind) {
  const node = selectedNode();
  if (!node) return;
  if (kind === 'source') editSourceId = node.id;
  else editTargetId = node.id;
  updateEditLabels();
}

function addManualEdge() {
  if (!editSourceId || !editTargetId || editSourceId === editTargetId) return;
  const type = (edgeTypeInput.value || 'RELATED_TO').trim().replace(/\\s+/g, '_').toUpperCase();
  const edge = {
    id: \`manual:\${Date.now()}:\${Math.random().toString(16).slice(2)}\`,
    source: editSourceId,
    target: editTargetId,
    type,
    weight: 1,
    manual: true,
  };
  currentEdges.push(edge);
  if (currentView) currentView.edges = currentEdges.map(stripRuntimeEdge);
  selectedEdgeId = edge.id;
  renderCurrentWithoutRelayout();
  const selectedEdge = currentEdges.find(item => item.id === selectedEdgeId);
  if (selectedEdge) showEdgeDetail(selectedEdge);
  updateSelection();
}

function toggleConnectMode() {
  connectModeEnabled = !connectModeEnabled;
  pendingConnectSourceId = null;
  connectModeButton.classList.toggle('active', connectModeEnabled);
  detail.innerHTML = connectModeEnabled
    ? '<h2>连线模式</h2><div class="kv">点击第一个节点作为起点，再点击第二个节点新增关系。</div>'
    : '<h2>已退出连线模式</h2>';
  updateEditLabels();
}

function handleConnectModeNodeClick(node) {
  if (!pendingConnectSourceId) {
    pendingConnectSourceId = node.id;
    editSourceId = node.id;
    selectedId = node.id;
    selectedEdgeId = null;
    showDetail(node);
    detail.insertAdjacentHTML(
      'beforeend',
      '<div class="kv"><span>连线模式：</span>已选择起点，请点击终点节点。</div>',
    );
    updateSelection();
    return;
  }

  if (pendingConnectSourceId === node.id) return;
  editSourceId = pendingConnectSourceId;
  editTargetId = node.id;
  pendingConnectSourceId = null;
  addManualEdge();
}

function deleteSelectedEdge() {
  if (!selectedEdgeId) return;
  currentEdges = currentEdges.filter(edge => (edge.id || edgeKey(edge)) !== selectedEdgeId);
  if (currentView) currentView.edges = currentEdges.map(stripRuntimeEdge);
  selectedEdgeId = null;
  renderCurrentWithoutRelayout();
  detail.innerHTML = '<h2>已删除关系</h2>';
}

function renderCurrentWithoutRelayout() {
  const positions = new Map(currentNodes.map(node => [node.id, { x: node.x, y: node.y }]));
  const view = {
    title: currentView?.title ?? '编辑视图',
    nodes: currentNodes.map(stripRuntimeNode),
    edges: currentEdges.map(stripRuntimeEdge),
  };
  drawGraph(view);
  for (const node of currentNodes) {
    const position = positions.get(node.id);
    if (position) {
      node.x = position.x;
      node.y = position.y;
    }
  }
  updatePositions();
}

function exportEditedGraph() {
  const payload = {
    title: currentView?.title ?? activeView,
    exportedAt: new Date().toISOString(),
    nodes: currentNodes.map(stripRuntimeNode),
    edges: currentEdges.map(stripRuntimeEdge),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = \`wind-graph-edited-\${Date.now()}.json\`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function updateEditLabels() {
  const source = editSourceId ? currentNodeMap.get(editSourceId) : null;
  const target = editTargetId ? currentNodeMap.get(editTargetId) : null;
  sourceLabel.textContent = source?.label ?? (connectModeEnabled ? '连线模式：先点击起点节点' : '未选择');
  targetLabel.textContent = target?.label ?? '未选择';
}

function stripRuntimeNode(node) {
  const { element, x, y, ...rest } = node;
  return rest;
}

function stripRuntimeEdge(edge) {
  const { element, labelElement, ...rest } = edge;
  return rest;
}

function edgeKey(edge) {
  return \`\${edge.source}->\${edge.type}->\${edge.target}\`;
}

function nodeRadius(node) {
  return Math.max(8, Math.min(24, 7 + Math.sqrt(node.count || 1) * 1.3));
}

function trimLabel(value, max) {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
  }
  return groups;
}

function el(name, attrs = {}, text) {
  const item = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, value);
  if (text !== undefined) item.textContent = text;
  return item;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

for (const button of document.querySelectorAll('button[data-view]')) {
  button.addEventListener('click', () => render(button.dataset.view));
}
search.addEventListener('input', () => renderResults(search.value));
resetView.addEventListener('click', () => {
  if (activeView === 'search' && currentView) {
    drawGraph(currentView);
  } else {
    render(activeView === 'search' ? 'overview' : activeView);
  }
});
connectModeButton.addEventListener('click', toggleConnectMode);
setSourceButton.addEventListener('click', () => setEndpoint('source'));
setTargetButton.addEventListener('click', () => setEndpoint('target'));
addEdgeButton.addEventListener('click', addManualEdge);
deleteEdgeButton.addEventListener('click', deleteSelectedEdge);
exportGraphButton.addEventListener('click', exportEditedGraph);
window.addEventListener('keydown', event => {
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) {
    event.preventDefault();
    deleteSelectedEdge();
  }
});
window.addEventListener('resize', () => drawGraph(DATA.views[activeView] || DATA.views.overview));
render('overview');
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

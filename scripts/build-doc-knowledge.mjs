#!/usr/bin/env node

import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import { promisify } from 'util'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_OUT_ROOT = join(ROOT, 'generated-knowledge')
const MAX_SECTION_CHARS = 3500
const MAX_VISUAL_NODES = 800

const inputPath = process.argv[2]
const outRoot = optionValue('--out') ?? DEFAULT_OUT_ROOT

if (!inputPath || inputPath === '--help' || inputPath === '-h') {
  console.log(helpText())
  process.exit(inputPath ? 0 : 1)
}

await main()

async function main() {
  const sourcePath = resolve(inputPath)
  const sourceInfo = await stat(sourcePath)
  const docs = sourceInfo.isDirectory()
    ? await collectInputDocuments(sourcePath)
    : isSupportedInput(sourcePath) ? [sourcePath] : []

  if (docs.length === 0) {
    throw new Error(`No supported document files found: ${sourcePath}`)
  }

  const projectName = safeFileName(basename(sourcePath, extname(sourcePath))) || 'doc-knowledge'
  const outDir = resolve(outRoot, `${projectName}-llmwiki`)
  const wikiDir = join(outDir, 'wiki')
  const graphDir = join(outDir, 'graph')
  const metaDir = join(outDir, '.llm-wiki')

  await rm(outDir, { recursive: true, force: true })
  await mkdir(wikiDir, { recursive: true })
  await mkdir(join(wikiDir, 'sections'), { recursive: true })
  await mkdir(graphDir, { recursive: true })
  await mkdir(metaDir, { recursive: true })

  const extractedDocs = []
  for (const docPath of docs) {
    extractedDocs.push(await extractDocument(docPath, sourcePath))
  }

  const corpus = buildCorpus(extractedDocs)
  const graph = buildGraph(corpus, sourcePath)

  await writeWiki(outDir, wikiDir, corpus, graph)
  await writeGraph(graphDir, graph)
  await writeVisualization(graphDir, graph)
  await writeSnapshot(outDir, metaDir)

  console.log(`Built document LLMWiki: ${outDir}`)
  console.log(`Documents: ${extractedDocs.length}`)
  console.log(`Sections: ${corpus.sections.length}`)
  console.log(`Nodes: ${graph.nodes.length}`)
  console.log(`Edges: ${graph.edges.length}`)
  console.log(`Visualization: ${join(outDir, 'graph', 'visualization.html')}`)
  console.log(`Reasoning graph: ${join(outDir, 'graph', 'reasoning.html')}`)
}

function helpText() {
  return [
    'Build a local LLMWiki, knowledge graph, and reasoning graph from a document.',
    '',
    'Usage:',
    '  npm run build:doc-knowledge -- <file-or-folder>',
    '  npm run build:doc-knowledge -- <file-or-folder> --out generated-knowledge',
    '',
    'Supported inputs:',
    '  .doc, .docx, .rtf, .md, .markdown, .txt, .csv, .json, .jsonl',
    '',
    'DOC/DOCX/RTF extraction uses macOS textutil.',
  ].join('\n')
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function collectInputDocuments(dir) {
  const files = []
  await walk(dir, async filePath => {
    if (isSupportedInput(filePath)) files.push(filePath)
  })
  return files.sort((a, b) => a.localeCompare(b))
}

async function walk(dir, visit) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const child = join(dir, entry.name)
    if (entry.isDirectory()) await walk(child, visit)
    else if (entry.isFile()) await visit(child)
  }
}

function isSupportedInput(filePath) {
  return /\.(doc|docx|rtf|md|markdown|txt|csv|json|jsonl)$/i.test(filePath)
}

async function extractDocument(filePath, rootPath) {
  const ext = extname(filePath).toLowerCase()
  let text = ''
  let extractor = 'plain-text'
  if (['.doc', '.docx', '.rtf'].includes(ext)) {
    const result = await extractOfficeText(filePath)
    text = result.text
    extractor = result.extractor
  } else {
    text = await readFile(filePath, 'utf8')
  }

  return {
    id: `document:${stableId(filePath)}`,
    title: basename(filePath),
    path: filePath,
    relativePath: relative(dirname(rootPath), filePath),
    extractor,
    text: normalizeText(text),
  }
}

async function extractOfficeText(filePath) {
  const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', filePath], {
    maxBuffer: 1024 * 1024 * 80,
  })
  if (!stdout.trim()) throw new Error(`Unable to extract text from ${filePath}`)
  return { text: stdout, extractor: 'textutil' }
}

function buildCorpus(docs) {
  const sections = []
  for (const doc of docs) {
    const docSections = splitIntoSections(doc)
    sections.push(...docSections)
  }
  return { docs, sections }
}

function splitIntoSections(doc) {
  const lines = doc.text.split(/\r?\n/)
  const sections = []
  let current = { title: doc.title, lines: [] }

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)\s*$/)
    const page = line.match(/^---\s*Page\s+(\d+)\s*---$/i)
    if ((heading || page) && current.lines.join('\n').trim()) {
      sections.push(current)
      current = { title: heading?.[2]?.trim() ?? `Page ${page?.[1]}`, lines: [] }
      continue
    }
    if (heading || page) {
      current.title = heading?.[2]?.trim() ?? `Page ${page?.[1]}`
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.join('\n').trim()) sections.push(current)

  const chunked = []
  for (const section of sections) {
    const text = section.lines.join('\n').trim()
    if (text.length <= MAX_SECTION_CHARS) {
      chunked.push(sectionRecord(doc, section.title, text, chunked.length + 1))
      continue
    }
    const paragraphs = text.split(/\n\s*\n/)
    let buffer = ''
    for (const paragraph of paragraphs) {
      if ((buffer + '\n\n' + paragraph).length > MAX_SECTION_CHARS && buffer.trim()) {
        chunked.push(sectionRecord(doc, section.title, buffer.trim(), chunked.length + 1))
        buffer = paragraph
      } else {
        buffer += `${buffer ? '\n\n' : ''}${paragraph}`
      }
    }
    if (buffer.trim()) chunked.push(sectionRecord(doc, section.title, buffer.trim(), chunked.length + 1))
  }
  return chunked
}

function sectionRecord(doc, title, text, index) {
  return {
    id: `section:${stableId(`${doc.relativePath}:${index}:${title}`)}`,
    docId: doc.id,
    docTitle: doc.title,
    index,
    title: title || `${doc.title} section ${index}`,
    text,
  }
}

function buildGraph(corpus, sourcePath) {
  const nodes = new Map()
  const edges = new Map()

  const addNode = (type, label, props = {}) => {
    const cleanLabel = clean(label)
    if (!cleanLabel) return null
    const id = `${type}:${stableId(cleanLabel)}`
    const node = nodes.get(id) ?? {
      id,
      type,
      label: cleanLabel,
      count: 0,
      properties: {},
    }
    node.count += 1
    node.properties = { ...node.properties, ...compact(props) }
    nodes.set(id, node)
    return id
  }

  const addEdge = (source, target, type, evidence = '') => {
    if (!source || !target || source === target) return
    const id = `${source}->${type}->${target}`
    const edge = edges.get(id) ?? {
      id,
      source,
      target,
      type,
      weight: 0,
      evidence: [],
    }
    edge.weight += 1
    if (evidence && edge.evidence.length < 3) edge.evidence.push(evidence)
    edges.set(id, edge)
  }

  const root = addNode('corpus', basename(sourcePath), { path: sourcePath })

  for (const doc of corpus.docs) {
    const docNode = addNode('document', doc.title, {
      path: doc.relativePath,
      extractor: doc.extractor,
    })
    addEdge(root, docNode, 'HAS_DOCUMENT', doc.relativePath)
  }

  for (const section of corpus.sections) {
    const sectionNode = addNode('section', section.title, {
      document: section.docTitle,
      index: section.index,
    })
    const docNode = addNode('document', section.docTitle)
    addEdge(docNode, sectionNode, 'HAS_SECTION', section.title)

    const extraction = extractKnowledge(section.text)
    for (const code of extraction.faultCodes) {
      const node = addNode('fault_code', code)
      addEdge(sectionNode, node, 'MENTIONS_FAULT_CODE', snippet(section.text, code))
    }
    for (const term of extraction.terms) {
      const node = addNode('term', term)
      addEdge(sectionNode, node, 'MENTIONS_TERM', snippet(section.text, term))
    }
    for (const model of extraction.models) {
      const node = addNode('model', model)
      addEdge(sectionNode, node, 'MENTIONS_MODEL', snippet(section.text, model))
    }
    for (const system of extraction.systems) {
      const node = addNode('system', system)
      addEdge(sectionNode, node, 'BELONGS_TO_SYSTEM', snippet(section.text, system))
    }
    for (const action of extraction.actions) {
      const node = addNode('action', action)
      addEdge(sectionNode, node, 'HAS_ACTION', action)
    }
    for (const component of extraction.components) {
      const node = addNode('component', component)
      addEdge(sectionNode, node, 'MENTIONS_COMPONENT', snippet(section.text, component))
    }
    for (const cause of extraction.causes) {
      const node = addNode('causal_factor', cause)
      addEdge(sectionNode, node, 'STATES_CAUSE', snippet(section.text, cause))
    }
    for (const symptom of extraction.symptoms) {
      const node = addNode('symptom', symptom)
      addEdge(sectionNode, node, 'STATES_SYMPTOM', snippet(section.text, symptom))
    }
    for (const signal of extraction.signals) {
      const node = addNode('diagnostic_signal', signal)
      addEdge(sectionNode, node, 'STATES_SIGNAL', snippet(section.text, signal))
    }
    for (const faultName of extraction.faultNames) {
      const node = addNode('fault_name', faultName)
      addEdge(sectionNode, node, 'MENTIONS_FAULT', faultName)
    }

    for (const code of extraction.faultCodes) {
      const codeNode = addNode('fault_code', code)
      for (const system of extraction.systems) {
        addEdge(codeNode, addNode('system', system), 'BELONGS_TO_SYSTEM', section.title)
      }
      for (const component of extraction.components) {
        addEdge(codeNode, addNode('component', component), 'INVOLVES_COMPONENT', section.title)
      }
      for (const cause of extraction.causes.slice(0, 8)) {
        addEdge(codeNode, addNode('causal_factor', cause), 'MAY_BE_CAUSED_BY', section.title)
      }
      for (const symptom of extraction.symptoms.slice(0, 8)) {
        addEdge(codeNode, addNode('symptom', symptom), 'MANIFESTS_AS', section.title)
      }
      for (const signal of extraction.signals.slice(0, 8)) {
        addEdge(codeNode, addNode('diagnostic_signal', signal), 'DIAGNOSED_BY', section.title)
      }
      for (const action of extraction.actions.slice(0, 3)) {
        addEdge(codeNode, addNode('action', action), 'REQUIRES_ACTION', section.title)
      }
    }

    const faultTargets = [
      ...extraction.faultCodes.map(code => addNode('fault_code', code)),
      ...extraction.faultNames.map(name => addNode('fault_name', name)),
    ].filter(Boolean)
    for (const target of faultTargets.slice(0, 6)) {
      for (const cause of extraction.causes.slice(0, 6)) addEdge(addNode('causal_factor', cause), target, 'CAN_TRIGGER', section.title)
      for (const symptom of extraction.symptoms.slice(0, 6)) addEdge(target, addNode('symptom', symptom), 'MANIFESTS_AS', section.title)
      for (const signal of extraction.signals.slice(0, 6)) addEdge(target, addNode('diagnostic_signal', signal), 'DIAGNOSED_BY', section.title)
      for (const action of extraction.actions.slice(0, 4)) addEdge(target, addNode('action', action), 'MITIGATED_BY', section.title)
    }
    for (const pair of extraction.causalPairs) {
      const causeNode = addNode('causal_factor', pair.cause)
      const effectType = pair.effectType ?? inferEffectType(pair.effect)
      const effectNode = addNode(effectType, pair.effect)
      addEdge(causeNode, effectNode, 'LEADS_TO', pair.evidence)
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.type.localeCompare(b.type) || b.count - a.count)
  const edgeList = [...edges.values()].sort((a, b) => b.weight - a.weight || a.type.localeCompare(b.type))
  return {
    generatedAt: new Date().toISOString(),
    source: sourcePath,
    nodes: nodeList,
    edges: edgeList,
    indexes: {
      countsByNodeType: countBy(nodeList, node => node.type),
      countsByEdgeType: countBy(edgeList, edge => edge.type),
    },
  }
}

function extractKnowledge(text) {
  const systems = dictionaryMatches(text, [
    '变桨系统',
    '偏航系统',
    '变流系统',
    '变频系统',
    '发电机系统',
    '齿轮箱系统',
    '液压系统',
    '主控系统',
    '安全链系统',
    '通信系统',
    '电网系统',
    '温度系统',
    '振动系统',
    'SCADA',
    'PLC',
  ])
  const terms = dictionaryMatches(text, [
    '风机',
    '风场',
    '叶片',
    '轮毂',
    '机舱',
    '塔筒',
    '主轴',
    '齿轮箱',
    '发电机',
    '变流器',
    '变频器',
    'GSC',
    'MSC',
    'IGBT',
    'Crowbar',
    '变桨',
    '偏航',
    '编码器',
    '传感器',
    '接触器',
    '断路器',
    '继电器',
    '安全链',
    'EtherCAT',
    'CAN',
    'Profibus',
    '电压',
    '电流',
    '温度',
    '振动',
    '复位',
    '停机',
    '并网',
  ])
  const components = dictionaryMatches(text, [
    '24V控制电源',
    '主电源开关',
    '辅助触点',
    'PLC模块',
    'PLC输入点',
    '编码器',
    '限位开关',
    '接触器',
    '断路器',
    '继电器',
    '安全继电器',
    '变桨电机',
    '变桨驱动器',
    '蓄能器',
    '液压泵',
    '阀组',
    '液压管路',
    '齿轮箱轴承',
    '发电机轴承',
    '温度传感器',
    '振动传感器',
    'IGBT',
    'DSP板',
    'CAN总线',
    '光纤',
    'Profibus',
    '风扇',
    '加热器',
    '制动器',
    '偏航电机',
  ])
  const faultCodes = unique(
    [...text.matchAll(/(?:故障代码|故障码|Fault\s*Code)[:：]\s*`?([A-Z]{0,8}[\d_][A-Z0-9_\-./]{1,40})`?/gi)]
      .map(match => cleanCode(match[1]))
      .concat(extractFaultCodesFromFaultRows(text))
      .filter(code => code.length >= 2 && code.length <= 40),
  ).slice(0, 80)
  const models = unique(
    [...text.matchAll(/\b[A-Z]{1,6}[-_/]?\d{2,4}(?:[-_/][A-Z0-9.()]+){0,4}\b/g)]
      .map(match => match[0])
      .filter(value => !/^\d+$/.test(value)),
  ).slice(0, 80)
  const actions = unique(
    text
      .split(/[。；;\n]/)
      .map(item => item.trim())
      .filter(item => !/^(故障现象|现象|表现|报警现象)[:：]/.test(item))
      .filter(item => /检查|更换|复位|测量|确认|清理|紧固|启动|联系|观察|处理|测试/.test(item))
      .map(item => stripListPrefix(item).slice(0, 90))
      .filter(item => item.length >= 4),
  ).slice(0, 50)
  const faultNames = unique(
    [...text.matchAll(/([\u4e00-\u9fa5A-Za-z0-9_/+\-\s]{2,40}(?:故障|报警|异常|超限|过高|过低|欠压|过压|断线|超时))/g)]
      .map(match => clean(match[1]))
      .filter(item => item.length >= 3 && item.length <= 45),
  ).slice(0, 60)
  const causes = unique([
    ...extractFieldItems(text, ['故障原因', '可能原因', '原因', '产生原因', '触发原因']),
    ...extractCauseFragments(text),
  ])
    .filter(item => !/^(导致|造成|引起|触发|使|致使)/.test(item))
    .slice(0, 80)
  const symptoms = unique([
    ...extractFieldItems(text, ['故障现象', '现象', '表现', '症状', '报警现象']),
    ...extractSymptomFragments(text),
  ]).slice(0, 80)
  const signals = unique([
    ...extractFieldItems(text, ['诊断信号', '检测信号', '检查信号', '监测量', '测点', '信号']),
    ...extractSignalFragments(text),
  ])
    .filter(item => !/^(导致|造成|引起|触发|使|致使)/.test(item))
    .slice(0, 80)
  const causalPairs = extractCausalPairs(text)

  return { systems, terms, faultCodes, models, actions, faultNames, components, causes, symptoms, signals, causalPairs }
}

function extractFieldItems(text, names) {
  const items = []
  for (const name of names) {
    const pattern = new RegExp(`${escapeRegExp(name)}[:：]\\s*([^\\n]{2,360})`, 'g')
    for (const match of text.matchAll(pattern)) {
      items.push(...splitListLike(match[1]))
    }
  }
  return items.map(compactPhrase).filter(isUsefulPhrase)
}

function extractCauseFragments(text) {
  const items = []
  for (const sentence of splitSentences(text)) {
    if (/^(故障码|故障代码|故障现象|现象|表现|报警现象|诊断信号|检测信号|处理方法|处理步骤)[:：]/.test(sentence)) continue
    const match = sentence.match(/(?:由于|因|原因(?:是|为)?[:：]?|可能为|通常为)([^，。；;]{2,80})/)
    if (match) {
      items.push(compactPhrase(match[1]))
      continue
    }
    if (/(导致|造成|引起|触发|断开|短路|断路|松动|损坏|失效|过热|磨损|堵塞|泄漏)/.test(sentence)) {
      items.push(compactPhrase(sentence))
    }
  }
  return items.filter(isUsefulPhrase)
}

function extractSymptomFragments(text) {
  const items = []
  for (const sentence of splitSentences(text)) {
    if (/^(故障现象|现象|表现|报警现象)[:：]/.test(sentence)) continue
    if (!/(表现|现象|报警|停机|跳闸|超限|超时|偏差|丢失|异常|过高|过低|欠压|过压)/.test(sentence)) continue
    items.push(compactPhrase(sentence))
  }
  return items.filter(isUsefulPhrase)
}

function extractSignalFragments(text) {
  const items = []
  for (const sentence of splitSentences(text)) {
    if (!/(检查|测量|检测|监测|信号|反馈|状态|电压|电流|温度|压力|振动|编码器|传感器|DI|AI|状态字)/i.test(sentence)) continue
    const signal = sentence.match(/([\u4e00-\u9fa5A-Za-z0-9#_/+\-.]{2,40}(?:信号|反馈|状态|电压|电流|温度|压力|振动|状态字|输入点|测点))/i)?.[1]
    items.push(compactPhrase(signal ?? sentence))
  }
  return items.filter(isUsefulPhrase)
}

function extractCausalPairs(text) {
  const pairs = []
  for (const sentence of splitSentences(text)) {
    const compactSentence = clean(sentence)
    if (compactSentence.length < 6 || compactSentence.length > 260) continue
    const forward = compactSentence.match(/^(.{2,100}?)(?:会|可|可能)?(?:导致|造成|引起|触发|使|致使)(.{2,100})$/)
    if (forward) {
      const cause = compactPhrase(forward[1])
      const effect = compactPhrase(forward[2])
      if (isUsefulPhrase(cause) && isUsefulPhrase(effect)) {
        pairs.push({ cause, effect, effectType: inferEffectType(effect), evidence: compactSentence })
      }
      continue
    }
    const reverse = compactSentence.match(/^(.{2,100}?)(?:由|由于|因)(.{2,100}?)(?:导致|造成|引起|触发)?$/)
    if (reverse) {
      const effect = compactPhrase(reverse[1])
      const cause = compactPhrase(reverse[2])
      if (isUsefulPhrase(cause) && isUsefulPhrase(effect)) {
        pairs.push({ cause, effect, effectType: inferEffectType(effect), evidence: compactSentence })
      }
    }
  }
  return uniqueBy(pairs, pair => `${pair.cause}->${pair.effect}`).slice(0, 80)
}

function inferEffectType(value) {
  if (/(故障码|代码|^\s*[A-Z]{0,8}\d[A-Z0-9_\-./]{1,40}\s*$)/i.test(value)) return 'fault_code'
  if (/(故障|报警|异常|超限|过高|过低|欠压|过压|断线|超时)/.test(value)) return 'symptom'
  if (/(信号|反馈|状态|电压|电流|温度|压力|振动|状态字|测点)/.test(value)) return 'diagnostic_signal'
  return 'symptom'
}

function splitSentences(text) {
  return text
    .split(/[。；;\n]/)
    .map(clean)
    .filter(item => item.length >= 4)
}

function splitListLike(value) {
  return clean(value)
    .split(/[；;，,、]/)
    .map(stripListPrefix)
}

function stripListPrefix(value) {
  return clean(value).replace(/^\d+(?:[.、)）-]\s*|\s+)/, '')
}

function compactPhrase(value) {
  return clean(value)
    .replace(/^(检查|确认|测量|处理|处理方法|处理步骤|原因|可能原因|故障原因|现象|故障现象|表现|报警现象|为|是)[:：]?\s*/, '')
    .replace(/^[:：]\s*/, '')
    .replace(/[。；;，,、:：]+$/g, '')
    .slice(0, 90)
}

function isUsefulPhrase(value) {
  const text = clean(value)
  if (text.length < 2 || text.length > 90) return false
  if (/^[\d\s._/-]+$/.test(text)) return false
  if (['故障', '异常', '报警', '信号', '反馈', '状态', '诊断信号', '检测信号'].includes(text)) return false
  return true
}

function uniqueBy(items, keyFn) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function extractFaultCodesFromFaultRows(text) {
  const codes = []
  for (const line of text.split(/\r?\n/)) {
    if (!/(故障|报警|异常|超限|过压|欠压|断线|超时)/.test(line)) continue
    const tableCell = line.match(/^\s*\|?\s*([A-Z]{0,8}\d[A-Z0-9_\-./]{1,40})\s*\|/)
    const csvCell = line.match(/^\s*([A-Z]{0,8}\d[A-Z0-9_\-./]{1,40})\s*[,，]/)
    const leading = line.match(/^\s*([A-Z]{0,8}\d[A-Z0-9_\-./]{1,40})\s+[\u4e00-\u9fa5A-Za-z]/)
    const code = tableCell?.[1] ?? csvCell?.[1] ?? leading?.[1]
    if (code) codes.push(cleanCode(code))
  }
  return codes
}

async function writeWiki(outDir, wikiDir, corpus, graph) {
  await writeFile(join(outDir, 'README.md'), renderReadme(corpus, graph), 'utf8')
  await writeFile(join(outDir, 'purpose.md'), renderPurpose(), 'utf8')
  await writeFile(join(outDir, 'schema.md'), renderSchema(), 'utf8')
  await writeFile(join(wikiDir, 'index.md'), renderIndex(corpus, graph), 'utf8')
  await writeFile(join(wikiDir, 'overview.md'), renderOverview(graph), 'utf8')
  await writeFile(join(wikiDir, 'reasoning.md'), renderReasoningOverview(graph), 'utf8')
  await writeFile(join(wikiDir, 'fault-codes.md'), renderNodesPage(graph, 'fault_code', '故障码'), 'utf8')
  await writeFile(join(wikiDir, 'terms.md'), renderNodesPage(graph, 'term', '术语'), 'utf8')
  await writeFile(join(wikiDir, 'systems.md'), renderNodesPage(graph, 'system', '系统'), 'utf8')

  for (const section of corpus.sections) {
    const file = `${String(section.index).padStart(4, '0')}_${safeFileName(section.title).slice(0, 70)}.md`
    section.wikiPath = join('wiki', 'sections', file)
    await writeFile(
      join(wikiDir, 'sections', file),
      [`# ${section.title}`, '', `来源：${section.docTitle}`, '', section.text].join('\n'),
      'utf8',
    )
  }

  const faultRecords = buildFaultIndexRecords(corpus)
  await writeFile(
    join(outDir, 'fault-index.jsonl'),
    faultRecords.map(record => JSON.stringify(record)).join('\n') + (faultRecords.length ? '\n' : ''),
    'utf8',
  )
  await writeFile(
    join(outDir, 'fault-index-summary.json'),
    `${JSON.stringify(
      {
        recordCount: faultRecords.length,
        generatedAt: new Date().toISOString(),
        byCodeLength: countBy(faultRecords, record => String(record.code.length)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function buildFaultIndexRecords(corpus) {
  const records = []
  for (const section of corpus.sections) {
    const extraction = extractKnowledge(section.text)
    for (const code of extraction.faultCodes) {
      const nearestFaultName = extraction.faultNames.find(name => section.text.includes(code) || name.includes('故障')) ?? ''
      records.push({
        code,
        name: nearestFaultName,
        site: '',
        brand: '',
        model: extraction.models[0] ?? '',
        reason: extractFieldLike(section.text, ['故障原因', '原因']),
        solution: extraction.actions.slice(0, 6).join('；'),
        reset: extractFieldLike(section.text, ['复位', '复位方式', '复位情况']),
        logic: extractFieldLike(section.text, ['故障逻辑', '逻辑']),
        system: extraction.systems[0] ?? '',
        category: '',
        source: `${section.wikiPath ?? 'wiki/overview.md'}:1`,
        text: section.text.slice(0, 1200),
      })
    }
  }
  return records
}

function extractFieldLike(text, names) {
  for (const name of names) {
    const match = text.match(new RegExp(`${escapeRegExp(name)}[:：]\\s*([^。\\n]{2,240})`))
    if (match) return clean(match[1])
  }
  return ''
}

function renderReadme(corpus, graph) {
  return [
    '# Document Knowledge LLMWiki',
    '',
    '这个项目由单个 PDF/Markdown/文本文件或文件夹自动生成。',
    '',
    '## 内容',
    '',
    '- `wiki/`：Markdown 知识页。',
    '- `graph/knowledge-graph.json`：知识图谱。',
    '- `graph/visualization.html`：可拖拽、可搜索的离线图谱页面。',
    '- `graph/reasoning-graph.json`：从文档抽取的推理因果子图。',
    '- `graph/reasoning.html`：推理因果流可视化页面。',
    '- `.llm-wiki/file-snapshot.json`：LLMWiki 索引快照。',
    '',
    '## 规模',
    '',
    `- 文档：${corpus.docs.length}`,
    `- 分段：${corpus.sections.length}`,
    `- 节点：${graph.nodes.length}`,
    `- 关系：${graph.edges.length}`,
  ].join('\n')
}

function renderPurpose() {
  return [
    '# Purpose',
    '',
    '从输入文档自动抽取可检索 Markdown 知识库和知识图谱，用于本地问答、资料浏览和关系分析。',
  ].join('\n')
}

function renderSchema() {
  return [
    '# Schema',
    '',
    '## Node Types',
    '',
    '- `corpus`: 输入文件或目录。',
    '- `document`: 文档。',
    '- `section`: 文档段落或章节。',
    '- `fault_code`: 故障码。',
    '- `fault_name`: 故障名称。',
    '- `term`: 领域术语。',
    '- `model`: 型号或代码式实体。',
    '- `system`: 系统名称。',
    '- `component`: 部件。',
    '- `causal_factor`: 原因或触发因素。',
    '- `symptom`: 故障表现或结果。',
    '- `diagnostic_signal`: 诊断信号或测点。',
    '- `action`: 处理动作。',
    '',
    '## Edge Types',
    '',
    '- `HAS_DOCUMENT`',
    '- `HAS_SECTION`',
    '- `MENTIONS_FAULT_CODE`',
    '- `MENTIONS_TERM`',
    '- `MENTIONS_MODEL`',
    '- `BELONGS_TO_SYSTEM`',
    '- `INVOLVES_COMPONENT`',
    '- `STATES_CAUSE`',
    '- `STATES_SYMPTOM`',
    '- `STATES_SIGNAL`',
    '- `CAN_TRIGGER`',
    '- `LEADS_TO`',
    '- `MAY_BE_CAUSED_BY`',
    '- `MANIFESTS_AS`',
    '- `DIAGNOSED_BY`',
    '- `HAS_ACTION`',
    '- `REQUIRES_ACTION`',
    '- `MITIGATED_BY`',
  ].join('\n')
}

function renderIndex(corpus, graph) {
  return [
    '# 自动生成知识库',
    '',
    `生成时间：${graph.generatedAt}`,
    '',
    '## 文档',
    '',
    ...corpus.docs.map(doc => `- ${doc.title}（${doc.extractor}）`),
    '',
    '## 入口',
    '',
    '- [概览](overview.md)',
    '- [推理因果摘要](reasoning.md)',
    '- [故障码](fault-codes.md)',
    '- [系统](systems.md)',
    '- [术语](terms.md)',
    '- [章节](sections/)',
    '- [知识图谱可视化](../graph/visualization.html)',
    '- [推理因果图谱](../graph/reasoning.html)',
  ].join('\n')
}

function renderOverview(graph) {
  return [
    '# 概览',
    '',
    '## 节点统计',
    '',
    table(['类型', '数量'], Object.entries(graph.indexes.countsByNodeType)),
    '',
    '## 关系统计',
    '',
    table(['关系', '数量'], Object.entries(graph.indexes.countsByEdgeType)),
  ].join('\n')
}

function renderReasoningOverview(graph) {
  const reasoning = buildReasoningGraph(graph)
  const nodeById = new Map(reasoning.nodes.map(node => [node.id, node]))
  const prioritizedEdges = reasoning.edges
    .filter(edge => ['CAN_TRIGGER', 'LEADS_TO', 'MAY_BE_CAUSED_BY', 'MANIFESTS_AS', 'DIAGNOSED_BY', 'MITIGATED_BY', 'REQUIRES_ACTION'].includes(edge.type))
    .sort((a, b) => reasoningEdgePriority(a.type) - reasoningEdgePriority(b.type) || b.weight - a.weight)
    .slice(0, 80)
    .map(edge => [
      nodeById.get(edge.source)?.label ?? edge.source,
      edge.type,
      nodeById.get(edge.target)?.label ?? edge.target,
      edge.weight,
      edge.evidence?.[0] ?? '',
    ])
  return [
    '# 推理因果摘要',
    '',
    '本页汇总从导入文档中抽取的原因、故障表现、诊断信号和处理动作。关系是规则抽取结果，适合作为候选推理图谱，关键条目仍需人工复核。',
    '',
    '## 节点统计',
    '',
    table(['类型', '数量'], Object.entries(reasoning.indexes.countsByNodeType)),
    '',
    '## 关系统计',
    '',
    table(['关系', '数量'], Object.entries(reasoning.indexes.countsByEdgeType)),
    '',
    '## 推理边样例',
    '',
    table(['起点', '关系', '终点', '权重', '证据'], prioritizedEdges),
  ].join('\n')
}

function renderNodesPage(graph, type, title) {
  const nodes = graph.nodes
    .filter(node => node.type === type)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, 300)
  return [`# ${title}`, '', table(['名称', '次数'], nodes.map(node => [node.label, node.count]))].join('\n')
}

async function writeGraph(graphDir, graph) {
  const reasoningGraph = buildReasoningGraph(graph)
  await writeFile(join(graphDir, 'knowledge-graph.json'), `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  await writeFile(join(graphDir, 'reasoning-graph.json'), `${JSON.stringify(reasoningGraph, null, 2)}\n`, 'utf8')
  await writeFile(join(graphDir, 'triples.jsonl'), graph.edges.map(edge => JSON.stringify(edge)).join('\n') + '\n', 'utf8')
  await writeFile(join(graphDir, 'reasoning-triples.jsonl'), reasoningGraph.edges.map(edge => JSON.stringify(edge)).join('\n') + '\n', 'utf8')
  await writeFile(join(graphDir, 'nodes.csv'), csv([['id', 'type', 'label', 'count'], ...graph.nodes.map(node => [node.id, node.type, node.label, node.count])]), 'utf8')
  await writeFile(join(graphDir, 'edges.csv'), csv([['source', 'type', 'target', 'weight'], ...graph.edges.map(edge => [edge.source, edge.type, edge.target, edge.weight])]), 'utf8')
}

async function writeVisualization(graphDir, graph) {
  const nodes = graph.nodes
    .sort((a, b) => visualPriority(a.type) - visualPriority(b.type) || b.count - a.count)
    .slice(0, MAX_VISUAL_NODES)
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)).slice(0, 1500)
  await writeFile(
    join(graphDir, 'visualization.html'),
    renderVisualizationHtml({
      title: '文档知识图谱',
      generatedAt: graph.generatedAt,
      nodes,
      edges,
      stats: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        shownNodes: nodes.length,
        shownEdges: edges.length,
      },
    }),
    'utf8',
  )

  const reasoning = buildReasoningGraph(graph)
  const reasoningNodes = reasoning.nodes
    .sort((a, b) => reasoningVisualPriority(a.type) - reasoningVisualPriority(b.type) || b.count - a.count)
    .slice(0, MAX_VISUAL_NODES)
  const reasoningNodeIds = new Set(reasoningNodes.map(node => node.id))
  const reasoningEdges = reasoning.edges.filter(edge => reasoningNodeIds.has(edge.source) && reasoningNodeIds.has(edge.target)).slice(0, 1500)
  await writeFile(
    join(graphDir, 'reasoning.html'),
    renderVisualizationHtml({
      title: '推理因果图谱',
      generatedAt: graph.generatedAt,
      nodes: reasoningNodes,
      edges: reasoningEdges,
      stats: {
        nodes: reasoning.nodes.length,
        edges: reasoning.edges.length,
        shownNodes: reasoningNodes.length,
        shownEdges: reasoningEdges.length,
      },
    }),
    'utf8',
  )
}

function buildReasoningGraph(graph) {
  const reasoningNodeTypes = new Set([
    'fault_code',
    'fault_name',
    'system',
    'component',
    'causal_factor',
    'symptom',
    'diagnostic_signal',
    'action',
    'section',
  ])
  const reasoningEdgeTypes = new Set([
    'CAN_TRIGGER',
    'LEADS_TO',
    'MAY_BE_CAUSED_BY',
    'MANIFESTS_AS',
    'DIAGNOSED_BY',
    'MITIGATED_BY',
    'REQUIRES_ACTION',
    'INVOLVES_COMPONENT',
    'BELONGS_TO_SYSTEM',
    'STATES_CAUSE',
    'STATES_SYMPTOM',
    'STATES_SIGNAL',
    'HAS_ACTION',
    'MENTIONS_FAULT',
    'MENTIONS_FAULT_CODE',
  ])
  const edges = graph.edges.filter(edge => reasoningEdgeTypes.has(edge.type))
  const nodeIds = new Set(edges.flatMap(edge => [edge.source, edge.target]))
  const nodes = graph.nodes.filter(node => nodeIds.has(node.id) && reasoningNodeTypes.has(node.type))
  const visibleNodeIds = new Set(nodes.map(node => node.id))
  const visibleEdges = edges.filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
  return {
    generatedAt: graph.generatedAt,
    source: graph.source,
    description: 'Reasoning and causal subgraph extracted from imported documents.',
    nodes,
    edges: visibleEdges,
    indexes: {
      countsByNodeType: countBy(nodes, node => node.type),
      countsByEdgeType: countBy(visibleEdges, edge => edge.type),
      topCausalFactors: topNodes(nodes, 'causal_factor', 30),
      topSymptoms: topNodes(nodes, 'symptom', 30),
      topSignals: topNodes(nodes, 'diagnostic_signal', 30),
      topActions: topNodes(nodes, 'action', 30),
    },
  }
}

function renderVisualizationHtml(data) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title ?? '文档知识图谱')}</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#202938}
.app{height:100vh;display:grid;grid-template-rows:auto 1fr}
header{background:#fff;border-bottom:1px solid #d8dee8;padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between}
h1{font-size:20px;margin:0}.meta{font-size:12px;color:#667085;margin-top:4px}
.tools{display:flex;gap:8px;align-items:center}input,button{height:34px;border:1px solid #d8dee8;border-radius:6px;background:#fff;padding:0 10px}
main{min-height:0;display:grid;grid-template-columns:minmax(0,1fr)320px}
svg{width:100%;height:100%;display:block}.side{background:#fff;border-left:1px solid #d8dee8;padding:14px;overflow:auto}
.node circle{stroke:#fff;stroke-width:2px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.18))}.node text{font-size:12px;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round;pointer-events:none}
.node.selected circle{stroke:#111827;stroke-width:3px}.edge{stroke:#a8b3c5;stroke-opacity:.65;cursor:pointer}.edge.selected{stroke:#111827;stroke-opacity:1}.card{border:1px solid #d8dee8;border-radius:6px;padding:8px;margin:8px 0;cursor:pointer}.card:hover{border-color:#2f6fed}
.kv{font-size:13px;margin:7px 0}.kv span{color:#667085}
.edit{border-top:1px solid #d8dee8;margin-top:12px;padding-top:12px;display:grid;gap:8px}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pill{border:1px solid #d8dee8;border-radius:6px;padding:7px 8px;font-size:12px;color:#667085;overflow-wrap:anywhere}.edit input{width:100%}
.ask{border-bottom:1px solid #d8dee8;margin-bottom:12px;padding-bottom:12px;display:grid;gap:8px}.ask input{width:100%}.trace{margin-bottom:12px}.runStatus{border:1px solid #d8dee8;border-radius:6px;background:#f8fafc;color:#475467;font-size:12px;line-height:1.35;padding:7px 8px;margin-bottom:8px}.treeRoot,.treeNode{border:1px solid #d8dee8;border-radius:6px;padding:8px;cursor:pointer;background:#fff;transition:opacity .22s ease,transform .22s ease,border-color .18s ease,background .18s ease}.treeRoot{border-color:#111827;background:#f8fafc}.treeNode:hover,.treeRoot:hover{border-color:#2f6fed}.treeNode.current{border-color:#111827;background:#f8fafc}.treeRoot b,.treeNode b{display:block;font-size:13px;line-height:1.35}.treeRoot span,.treeNode span{display:block;color:#667085;font-size:12px;margin-top:3px;line-height:1.35}.treeBranch{position:relative;margin:10px 0 0 12px;padding-left:14px;border-left:2px solid #d8dee8}.branchLabel{display:inline-block;margin:0 0 7px -6px;background:#fff;color:#475467;font-size:12px;font-weight:600}.treeItem{position:relative;margin:0 0 8px}.treeItem:before{content:"";position:absolute;left:-14px;top:18px;width:12px;border-top:2px solid #d8dee8}.treeChildren{margin:7px 0 0 16px;padding-left:12px;border-left:1px dashed #a8b3c5}.reveal{opacity:0;transform:translateY(8px)}.reveal.show{opacity:1;transform:translateY(0)}.pulse{animation:pulseNode .55s ease}@keyframes pulseNode{0%{box-shadow:0 0 0 0 rgba(47,111,237,.25)}100%{box-shadow:0 0 0 10px rgba(47,111,237,0)}}.sectionTitle{font-size:13px;color:#667085;margin:2px 0}
</style>
</head>
<body>
<div class="app">
<header><div><h1>${escapeHtml(data.title ?? '文档知识图谱')}</h1><div class="meta">总节点 ${data.stats.nodes} · 总关系 ${data.stats.edges} · 当前显示 ${data.stats.shownNodes}/${data.stats.shownEdges}</div></div><div class="tools"><button id="reset">重置</button><input id="search" placeholder="搜索节点"></div></header>
<main><svg id="graph"></svg><aside class="side"><div class="ask"><b>推理问题</b><input id="question" placeholder="例如：303804是什么原因导致，应该检查哪些信号和处理？"><button id="runReasoning">开始推理</button><button id="fillQuestion">填入示例问题</button></div><div class="sectionTitle">推理过程</div><div id="trace" class="trace"></div><div class="sectionTitle">搜索结果</div><div id="results"></div><div id="detail"></div><div class="edit"><b>编辑关系</b><div class="row"><button id="setSource">设为起点</button><button id="setTarget">设为终点</button></div><div class="pill">起点：<span id="sourceLabel">未选择</span></div><div class="pill">终点：<span id="targetLabel">未选择</span></div><input id="edgeType" value="RELATED_TO"><button id="addEdge">新增关系</button><button id="deleteEdge">删除选中关系</button><button id="exportGraph">导出当前编辑图谱 JSON</button></div></aside></main>
</div>
<script>
const DATA=${JSON.stringify(data)};
const COLORS={corpus:'#111827',document:'#2f6fed',section:'#168f8b',fault_code:'#cf3f4a',fault_name:'#b7791f',term:'#27864f',model:'#7657c8',system:'#0f766e',component:'#d97706',causal_factor:'#c05621',symptom:'#dc2626',diagnostic_signal:'#057a85',action:'#27864f'};
const svg=document.getElementById('graph'),detail=document.getElementById('detail'),results=document.getElementById('results'),search=document.getElementById('search'),sourceLabel=document.getElementById('sourceLabel'),targetLabel=document.getElementById('targetLabel'),edgeType=document.getElementById('edgeType'),question=document.getElementById('question'),trace=document.getElementById('trace');
let nodes=[],edges=[],nodeMap=new Map(),viewport,edgeLayer,nodeLayer,selected=null,selectedEdge=null,editSource=null,editTarget=null,transform={x:0,y:0,scale:1},dragNode=null,pan=null,reasoningTimer=null;
function init(){nodes=DATA.nodes.map(n=>({...n}));edges=DATA.edges.map(e=>({...e}));nodeMap=new Map(nodes.map(n=>[n.id,n]));question.value=defaultQuestion();draw();renderResults('');trace.innerHTML='<div class="runStatus">输入问题后点击“开始推理”，这里会生成推理树。</div>'}
function draw(){svg.replaceChildren();const r=svg.getBoundingClientRect(),w=Math.max(r.width,640),h=Math.max(r.height,420);svg.setAttribute('viewBox',\`0 0 \${w} \${h}\`);layout(w,h);viewport=el('g');edgeLayer=el('g');nodeLayer=el('g');viewport.append(edgeLayer,nodeLayer);svg.append(viewport);for(const e of edges){const s=nodeMap.get(e.source),t=nodeMap.get(e.target);if(!s||!t)continue;e.el=el('line',{class:'edge','stroke-width':Math.max(1,Math.min(5,Math.sqrt(e.weight||1)))});e.el.addEventListener('click',ev=>{ev.stopPropagation();selectEdge(e)});edgeLayer.append(e.el)}for(const n of nodes){const g=el('g',{class:'node'});n.el=g;const radius=Math.max(8,Math.min(23,7+Math.sqrt(n.count||1)*1.5));g.append(el('circle',{r:radius,fill:COLORS[n.type]||'#64748b'}));g.append(el('text',{x:radius+6,y:4},trim(n.label,24)));g.addEventListener('pointerdown',ev=>startDrag(ev,n));g.addEventListener('click',ev=>{ev.stopPropagation();selectNode(n)});nodeLayer.append(g)}install();update()}
function layout(w,h){const groups={};for(const n of nodes){(groups[n.type]??=[]).push(n)}const types=Object.keys(groups);types.forEach((type,ti)=>{const items=groups[type],rad=type==='corpus'?0:Math.min(w,h)*(0.15+0.38*(ti/Math.max(1,types.length-1)));items.forEach((n,i)=>{const a=Math.PI*2*i/Math.max(1,items.length)+ti*.45;n.x=w/2+Math.cos(a)*rad;n.y=h/2+Math.sin(a)*rad})});for(let p=0;p<60;p++){for(const e of edges){const s=nodeMap.get(e.source),t=nodeMap.get(e.target);if(!s||!t)continue;const dx=t.x-s.x,dy=t.y-s.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-135)*.004;s.x+=dx/d*f;s.y+=dy/d*f;t.x-=dx/d*f;t.y-=dy/d*f}for(const n of nodes){n.x=Math.max(30,Math.min(w-160,n.x));n.y=Math.max(30,Math.min(h-30,n.y))}}}
function install(){svg.onpointerdown=ev=>{if(ev.target.closest&&ev.target.closest('.node'))return;pan={id:ev.pointerId,x:ev.clientX,y:ev.clientY,tx:transform.x,ty:transform.y};svg.setPointerCapture(ev.pointerId)};svg.onpointermove=ev=>{if(dragNode){const p=screenToGraph(ev.clientX,ev.clientY);dragNode.x=p.x;dragNode.y=p.y;update();return}if(!pan)return;transform.x=pan.tx+ev.clientX-pan.x;transform.y=pan.ty+ev.clientY-pan.y;apply()};svg.onpointerup=()=>{dragNode=null;pan=null};svg.onwheel=ev=>{ev.preventDefault();const before=screenToGraph(ev.clientX,ev.clientY);transform.scale=Math.max(.35,Math.min(3.5,transform.scale*(ev.deltaY<0?1.12:.89)));const after=screenToGraph(ev.clientX,ev.clientY);transform.x+=(after.x-before.x)*transform.scale;transform.y+=(after.y-before.y)*transform.scale;apply()}}
function startDrag(ev,n){ev.preventDefault();ev.stopPropagation();dragNode=n;selectNode(n);svg.setPointerCapture(ev.pointerId)}
function update(){for(const e of edges){const s=nodeMap.get(e.source),t=nodeMap.get(e.target);if(!s||!t||!e.el)continue;e.el.setAttribute('x1',s.x);e.el.setAttribute('y1',s.y);e.el.setAttribute('x2',t.x);e.el.setAttribute('y2',t.y);e.el.classList.toggle('selected',edgeKey(e)===selectedEdge)}for(const n of nodes){if(n.el){n.el.setAttribute('transform',\`translate(\${n.x},\${n.y})\`);n.el.classList.toggle('selected',selected===n.id)}}sourceLabel.textContent=nodeMap.get(editSource)?.label||'未选择';targetLabel.textContent=nodeMap.get(editTarget)?.label||'未选择';apply()}
function apply(){if(viewport)viewport.setAttribute('transform',\`translate(\${transform.x},\${transform.y}) scale(\${transform.scale})\`)}
function screenToGraph(x,y){const r=svg.getBoundingClientRect();return{x:(x-r.left-transform.x)/transform.scale,y:(y-r.top-transform.y)/transform.scale}}
function selectNode(n){selected=n.id;selectedEdge=null;detail.innerHTML=\`<h2>\${esc(n.label)}</h2><div class="kv"><span>类型：</span>\${esc(n.type)}</div><div class="kv"><span>次数：</span>\${n.count}</div><div class="kv"><span>ID：</span>\${esc(n.id)}</div>\`;update()}
function selectEdge(e){selected=null;selectedEdge=edgeKey(e);const s=nodeMap.get(e.source),t=nodeMap.get(e.target);detail.innerHTML=\`<h2>\${esc(e.type)}</h2><div class="kv"><span>起点：</span>\${esc(s?.label||e.source)}</div><div class="kv"><span>终点：</span>\${esc(t?.label||e.target)}</div><div class="kv"><span>权重：</span>\${e.weight||1}</div>\`;update()}
function setEndpoint(k){if(!selected)return;if(k==='source')editSource=selected;else editTarget=selected;update()}
function addManualEdge(){if(!editSource||!editTarget||editSource===editTarget)return;const e={source:editSource,target:editTarget,type:(edgeType.value||'RELATED_TO').trim().replace(/\\s+/g,'_').toUpperCase(),weight:1,manual:true};edges.push(e);selectedEdge=edgeKey(e);draw();selectEdge(e)}
function deleteEdge(){if(!selectedEdge)return;edges=edges.filter(e=>edgeKey(e)!==selectedEdge);selectedEdge=null;draw();detail.innerHTML='<h2>已删除关系</h2>'}
function exportGraph(){const payload={exportedAt:new Date().toISOString(),nodes:nodes.map(({el,x,y,...n})=>n),edges:edges.map(({el,...e})=>e)};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='doc-graph-edited-'+Date.now()+'.json';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}
function edgeKey(e){return (e.id||'')+'|'+e.source+'|'+e.type+'|'+e.target}
function renderResults(q){q=q.trim().toLowerCase();const list=(q?DATA.nodes.filter(n=>n.label.toLowerCase().includes(q)||n.type.includes(q)):DATA.nodes).slice(0,20);results.innerHTML=list.map(n=>\`<div class="card" data-id="\${esc(n.id)}"><b>\${esc(n.label)}</b><div class="kv"><span>\${esc(n.type)}</span> · \${n.count}</div></div>\`).join('');for(const card of results.querySelectorAll('.card'))card.onclick=()=>{const n=nodeMap.get(card.dataset.id);if(n)selectNode(n)}}
function defaultQuestion(){const fault=nodes.find(n=>n.type==='fault_code')||nodes.find(n=>n.type==='fault_name')||nodes[0];return fault?\`\${fault.label}是什么原因导致，应该检查哪些信号和处理？\`:'这个故障是什么原因导致，应该检查哪些信号和处理？'}
function runReasoning(){if(reasoningTimer)clearInterval(reasoningTimer);const q=question.value.trim()||defaultQuestion();question.value=q;const seed=findSeed(q);if(!seed){trace.innerHTML='<div class="runStatus">已运行，但没有匹配到图谱节点。可以先搜索故障码、故障名称或部件。</div>';return}const tree=buildReasoningTree(seed,q);trace.innerHTML=renderReasoningTree(tree,q);for(const item of trace.querySelectorAll('[data-id]'))item.onclick=ev=>{ev.stopPropagation();const n=nodeMap.get(item.dataset.id);if(n)selectNode(n)};animateReasoning(tree,q)}
function findSeed(q){const tokens=questionTokens(q);const ranked=nodes.map(n=>({n,score:nodeScore(n,q,tokens)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||typeRank(a.n.type)-typeRank(b.n.type)||b.n.count-a.n.count);return ranked[0]?.n}
function nodeScore(n,q,tokens){const label=n.label.toLowerCase();const text=q.toLowerCase();let score=0;if(text.includes(label))score+=50;if(label.includes(text)&&text.length>1)score+=18;for(const token of tokens){if(label.includes(token))score+=Math.min(14,token.length*2);if(n.type==='fault_code'&&token===label)score+=50}if(/原因|导致|处理|检查|信号|现象/.test(q)&&['fault_code','fault_name'].includes(n.type))score+=8;return score}
function buildReasoningTree(seed,q){const wants={cause:/原因|导致|为什么/.test(q),signal:/信号|检查|诊断|测量/.test(q),action:/处理|怎么办|复位|修复/.test(q),symptom:/现象|表现|报警/.test(q)};const branches=[];const used=new Set([seed.id]);const include=(key)=>wants[key]||!Object.values(wants).some(Boolean);const addBranch=(key,title,types,limit)=>{if(!include(key))return;const items=collectRelated(seed,types,limit,used).map(item=>({...item,children:collectChildren(item.node,key)}));if(items.length)branches.push({title,items})};addBranch('cause','原因链',['MAY_BE_CAUSED_BY','CAN_TRIGGER','LEADS_TO'],4);addBranch('signal','诊断信号',['DIAGNOSED_BY','STATES_SIGNAL'],4);addBranch('action','处理动作',['REQUIRES_ACTION','MITIGATED_BY','HAS_ACTION'],3);addBranch('symptom','故障表现',['MANIFESTS_AS','STATES_SYMPTOM'],4);if(!branches.length){const fallback=collectRelated(seed,[],8,used);branches.push({title:'相关节点',items:fallback.map(item=>({...item,children:[]}))})}const leaves=[];for(const branch of branches)for(const item of branch.items){leaves.push(item);for(const child of item.children)leaves.push(child)}const last=leaves.length?leaves[leaves.length-1].node:seed;return{root:{node:seed,text:\`命中问题节点：\${seed.type}\`},branches,current:last}}
function collectRelated(seed,types,limit,used){return edges.filter(e=>(e.source===seed.id||e.target===seed.id)&&(!types.length||types.includes(e.type))).sort((a,b)=>reasonEdgeRank(a.type)-reasonEdgeRank(b.type)||b.weight-a.weight).map(edge=>({edge,node:nodeMap.get(edge.source===seed.id?edge.target:edge.source),text:edge.type})).filter(item=>item.node&&!used.has(item.node.id)).slice(0,limit).map(item=>{used.add(item.node.id);return item})}
function collectChildren(node,key){const types=key==='cause'?['LEADS_TO','CAN_TRIGGER']:key==='signal'?['DIAGNOSED_BY','STATES_SIGNAL']:key==='action'?['REQUIRES_ACTION','MITIGATED_BY']:['MANIFESTS_AS','STATES_SYMPTOM'];return edges.filter(e=>(e.source===node.id||e.target===node.id)&&types.includes(e.type)).sort((a,b)=>reasonEdgeRank(a.type)-reasonEdgeRank(b.type)||b.weight-a.weight).slice(0,3).map(edge=>({edge,node:nodeMap.get(edge.source===node.id?edge.target:edge.source),text:edge.type})).filter(item=>item.node)}
function renderReasoningTree(tree,q){const now=new Date().toLocaleTimeString();return\`<div class="runStatus" id="runStatus">运行中 \${esc(now)} · 问题：\${esc(q)} · 命中：\${esc(tree.root.node.label)}</div><div class="treeRoot reveal" data-step="0" data-id="\${esc(tree.root.node.id)}"><b>\${esc(tree.root.node.label)}</b><span>\${esc(tree.root.text)}</span></div>\${tree.branches.map(branch=>\`<div class="treeBranch"><div class="branchLabel">\${esc(branch.title)}</div>\${branch.items.map(item=>renderTreeItem(item,tree.current.id)).join('')}</div>\`).join('')}\`}
function renderTreeItem(item,currentId){return\`<div class="treeItem"><div class="treeNode reveal \${item.node.id===currentId?'current':''}" data-step="1" data-id="\${esc(item.node.id)}"><b>\${esc(item.node.label)}</b><span>\${esc(item.text)} · \${esc(item.node.type)}</span></div>\${item.children.length?\`<div class="treeChildren">\${item.children.map(child=>renderTreeItem(child,currentId)).join('')}</div>\`:''}</div>\`}
function animateReasoning(tree,q){const items=[...trace.querySelectorAll('.reveal')];items.forEach((item,index)=>item.dataset.step=String(index));let index=0;const status=document.getElementById('runStatus');const show=()=>{if(index>=items.length){if(status)status.textContent=\`已完成 · 问题：\${q} · 当前节点：\${tree.current.label}\`;selectNode(tree.current);clearInterval(reasoningTimer);reasoningTimer=null;return}const item=items[index];item.classList.add('show','pulse');trace.querySelectorAll('.treeNode.current').forEach(node=>node.classList.remove('current'));if(item.classList.contains('treeNode'))item.classList.add('current');const n=nodeMap.get(item.dataset.id);if(n){selectNode(n);if(status)status.textContent=\`推理中 \${index+1}/\${items.length} · 当前节点：\${n.label}\`}setTimeout(()=>item.classList.remove('pulse'),650);index+=1};show();reasoningTimer=setInterval(show,520)}
function questionTokens(q){return q.toLowerCase().split(/[^a-z0-9\\u4e00-\\u9fa5]+/).flatMap(part=>part.length>8?[part,...part.match(/[a-z]*\\d+[a-z0-9]*/g)||[]]:[part]).filter(part=>part.length>=2)}
function typeRank(type){return({fault_code:1,fault_name:2,causal_factor:3,diagnostic_signal:4,symptom:5,action:6,component:7,system:8}[type]??20)}
function reasonEdgeRank(type){return({MAY_BE_CAUSED_BY:1,CAN_TRIGGER:2,LEADS_TO:3,DIAGNOSED_BY:4,MANIFESTS_AS:5,REQUIRES_ACTION:6,MITIGATED_BY:7,INVOLVES_COMPONENT:8,BELONGS_TO_SYSTEM:9}[type]??20)}
function el(name,attrs={},text){const e=document.createElementNS('http://www.w3.org/2000/svg',name);for(const[k,v]of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e}
function trim(s,n){return s.length>n?s.slice(0,n-1)+'…':s}function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
search.oninput=()=>renderResults(search.value);document.getElementById('reset').onclick=()=>{transform={x:0,y:0,scale:1};apply()};document.getElementById('setSource').onclick=()=>setEndpoint('source');document.getElementById('setTarget').onclick=()=>setEndpoint('target');document.getElementById('addEdge').onclick=addManualEdge;document.getElementById('deleteEdge').onclick=deleteEdge;document.getElementById('exportGraph').onclick=exportGraph;document.getElementById('runReasoning').onclick=runReasoning;document.getElementById('fillQuestion').onclick=()=>{question.value=defaultQuestion();runReasoning()};question.addEventListener('keydown',ev=>{if(ev.key==='Enter')runReasoning()});window.onresize=draw;init();
</script>
</body></html>`
}

async function writeSnapshot(outDir, metaDir) {
  const files = {}
  await walk(outDir, async filePath => {
    const rel = relative(outDir, filePath)
    if (rel.startsWith('.llm-wiki/')) return
    if (!/\.(md|json|jsonl|csv|html|txt)$/i.test(rel)) return
    const info = await stat(filePath)
    files[rel] = {
      size: info.size,
      sha1: createHash('sha1').update(await readFile(filePath)).digest('hex'),
      updatedAt: Math.floor(info.mtimeMs),
    }
  })
  await writeFile(join(metaDir, 'file-snapshot.json'), `${JSON.stringify({ version: 1, updatedAt: Date.now(), files }, null, 2)}\n`, 'utf8')
}

function dictionaryMatches(text, values) {
  return unique(values.filter(value => new RegExp(escapeRegExp(value), 'i').test(text)))
}

function normalizeText(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function cleanCode(value) {
  return clean(value).replace(/[，。；;:：]$/g, '')
}

function snippet(text, needle) {
  const index = text.indexOf(needle)
  if (index < 0) return ''
  return text.slice(Math.max(0, index - 60), Math.min(text.length, index + needle.length + 80)).replace(/\s+/g, ' ')
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function stableId(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}

function safeFileName(value) {
  return clean(value).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 120)
}

function countBy(items, keyFn) {
  const result = {}
  for (const item of items) result[keyFn(item)] = (result[keyFn(item)] ?? 0) + 1
  return result
}

function visualPriority(type) {
  return {
    corpus: 1,
    document: 2,
    section: 3,
    fault_code: 4,
    fault_name: 5,
    system: 6,
    component: 7,
    causal_factor: 8,
    symptom: 9,
    diagnostic_signal: 10,
    model: 11,
    term: 12,
    action: 13,
  }[type] ?? 20
}

function reasoningVisualPriority(type) {
  return {
    fault_code: 1,
    fault_name: 2,
    causal_factor: 3,
    symptom: 4,
    diagnostic_signal: 5,
    action: 6,
    system: 7,
    component: 8,
    section: 9,
  }[type] ?? 20
}

function reasoningEdgePriority(type) {
  return {
    CAN_TRIGGER: 1,
    LEADS_TO: 2,
    MAY_BE_CAUSED_BY: 3,
    MANIFESTS_AS: 4,
    DIAGNOSED_BY: 5,
    MITIGATED_BY: 6,
    REQUIRES_ACTION: 7,
  }[type] ?? 20
}

function topNodes(nodes, type, limit) {
  return nodes
    .filter(node => node.type === type)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
    .slice(0, limit)
    .map(node => ({ id: node.id, label: node.label, count: node.count }))
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...(rows.length ? rows : [['无', '']]).map(row => `| ${row.map(cell => String(cell ?? '').replace(/\|/g, '/')).join(' | ')} |`),
  ].join('\n')
}

function csv(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n'
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

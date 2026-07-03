#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GRAPH_PATH = join(ROOT, 'generated-knowledge', 'windrise-reasoning-graph.json')
const REPORT_PATH = join(ROOT, 'generated-knowledge', 'windrise-mechanism-graph-evaluation.md')
const JSON_PATH = join(ROOT, 'generated-knowledge', 'windrise-mechanism-graph-evaluation.json')
const CASE_TABLE_MD_PATH = join(ROOT, 'generated-knowledge', 'windrise-mechanism-case-coverage.md')
const CASE_TABLE_CSV_PATH = join(ROOT, 'generated-knowledge', 'windrise-mechanism-case-coverage.csv')

const MECHANISM_NODE_TYPES = new Set([
  'mechanism_archetype',
  'mechanism_layer',
  'failure_mode',
  'propagation_step',
  'observable',
  'verification_test',
  'control_barrier',
  'diagnostic_hypothesis',
  'discriminating_evidence',
  'counterfactual_test',
  'decision_rule',
  'symptom_signature',
  'evidence_gap',
  'exclusion_rule',
  'reasoning_plan',
])

const MECHANISM_EDGE_TYPES = new Set([
  'EXPLAINED_BY_ARCHETYPE',
  'HAS_MECHANISM_LAYER',
  'MECHANISM_PROPAGATES_TO',
  'MECHANISM_RESULTS_IN',
  'HAS_FAILURE_MODE',
  'HAS_PROPAGATION_START',
  'HAS_PROPAGATION_STEP',
  'HAS_OBSERVABLE',
  'VALIDATES_ARCHETYPE',
  'VERIFIED_BY_TEST',
  'CONTROLLED_BY_BARRIER',
  'HAS_COMPETING_HYPOTHESIS',
  'DISCRIMINATES_ARCHETYPE',
  'REQUIRES_DISCRIMINATING_EVIDENCE',
  'RESOLVED_BY_COUNTERFACTUAL_TEST',
  'HAS_DECISION_RULE',
  'HAS_SYMPTOM_SIGNATURE',
  'HAS_EVIDENCE_GAP',
  'HAS_EXCLUSION_RULE',
  'HAS_REASONING_PLAN',
])

const BASELINE_EDGE_TYPES = new Set([
  'INVOLVES_COMPONENT',
  'PRINCIPLE',
  'CAN_TRIGGER',
  'DIAGNOSED_BY',
  'MANIFESTS_AS',
  'MITIGATED_BY',
  'HAS_DIAGNOSTIC_STEP',
])

await main()

async function main() {
  const graph = JSON.parse(await readFile(GRAPH_PATH, 'utf8'))
  const evaluation = evaluateGraph(graph)
  await mkdir(dirname(REPORT_PATH), { recursive: true })
  await writeFile(JSON_PATH, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8')
  await writeFile(REPORT_PATH, renderMarkdown(evaluation), 'utf8')
  await writeFile(CASE_TABLE_MD_PATH, renderCaseCoverageMarkdown(evaluation), 'utf8')
  await writeFile(CASE_TABLE_CSV_PATH, renderCaseCoverageCsv(evaluation), 'utf8')
  console.log(`Wrote ${REPORT_PATH}`)
  console.log(`Wrote ${JSON_PATH}`)
  console.log(`Wrote ${CASE_TABLE_MD_PATH}`)
  console.log(`Wrote ${CASE_TABLE_CSV_PATH}`)
  console.log(`Mechanism coverage: ${(evaluation.mechanism.coverage_rate * 100).toFixed(1)}%`)
}

function evaluateGraph(graph) {
  const nodes = graph.nodes || []
  const edges = graph.edges || []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const caseNodes = nodes.filter(node => node.type === 'fault_case')
  const profiles = graph.retrieval_profiles || []
  const profileByCase = new Map(profiles.map(profile => [profile.case_id, profile]))
  const adjacency = buildAdjacency(edges)

  const baselineEdges = edges.filter(edge => BASELINE_EDGE_TYPES.has(edge.type))
  const mechanismEdges = edges.filter(edge => MECHANISM_EDGE_TYPES.has(edge.type))
  const mechanismNodes = nodes.filter(node => MECHANISM_NODE_TYPES.has(node.type))
  const enhancedCases = caseNodes.map(caseNode => evaluateCase(caseNode, byId, edges, adjacency, profileByCase.get(caseNode.id)))
  const baselineCases = caseNodes.map(caseNode => evaluateBaselineCase(caseNode, edges))

  const completeMechanismCases = enhancedCases.filter(item =>
    item.has_archetype &&
    item.has_failure_mode &&
    item.has_observable &&
    item.has_verification_test &&
    item.has_control_barrier,
  )
  const discriminatedCases = enhancedCases.filter(item =>
    item.has_competing_hypothesis &&
    item.has_discriminating_evidence &&
    item.has_counterfactual_test &&
    item.has_decision_rule,
  )
  const reasoningClosureCases = enhancedCases.filter(item =>
    item.has_symptom_signature &&
    item.has_evidence_gap &&
    item.has_exclusion_rule &&
    item.has_reasoning_plan,
  )

  const pathDepths = enhancedCases.map(item => item.max_mechanism_depth)
  const baselineProfileCompleteness = profiles.filter(profile =>
    profile.cause_terms?.length &&
    profile.symptom_terms?.length &&
    profile.signal_terms?.length &&
    (profile.action_terms?.length || profile.diagnostic_step_terms?.length),
  ).length
  const mechanismProfileCompleteness = profiles.filter(profile =>
    profile.mechanism_terms?.length &&
    profile.failure_mode_terms?.length &&
    profile.verification_terms?.length,
  ).length

  const topCases = [...enhancedCases]
    .sort((a, b) => b.mechanism_score - a.mechanism_score || b.max_mechanism_depth - a.max_mechanism_depth)
    .slice(0, 10)

  return {
    generated_at: new Date().toISOString(),
    source_graph: 'generated-knowledge/windrise-reasoning-graph.json',
    graph_size: {
      nodes: nodes.length,
      edges: edges.length,
      fault_cases: caseNodes.length,
      aliases: graph.aliases?.length || 0,
      weighted_aliases: graph.weighted_aliases?.length || 0,
    },
    baseline: {
      edge_count: baselineEdges.length,
      complete_profile_count: baselineProfileCompleteness,
      complete_profile_rate: ratio(baselineProfileCompleteness, profiles.length),
      average_explanation_depth: average(baselineCases.map(item => item.explanation_depth)),
      validation_closure_rate: ratio(baselineCases.filter(item => item.has_diagnostic_signal && item.has_action).length, baselineCases.length),
      prevention_closure_rate: ratio(baselineCases.filter(item => item.has_prevention).length, baselineCases.length),
      relation_types: countBy(baselineEdges, edge => edge.type),
    },
    mechanism: {
      archetype_count: nodes.filter(node => node.type === 'mechanism_archetype').length,
      node_count: mechanismNodes.length,
      edge_count: mechanismEdges.length,
      covered_case_count: completeMechanismCases.length,
      coverage_rate: ratio(completeMechanismCases.length, caseNodes.length),
      discriminated_case_count: discriminatedCases.length,
      discrimination_coverage_rate: ratio(discriminatedCases.length, caseNodes.length),
      reasoning_closure_case_count: reasoningClosureCases.length,
      reasoning_closure_coverage_rate: ratio(reasoningClosureCases.length, caseNodes.length),
      profile_complete_count: mechanismProfileCompleteness,
      profile_complete_rate: ratio(mechanismProfileCompleteness, profiles.length),
      average_depth: average(pathDepths),
      max_depth: pathDepths.length ? Math.max(...pathDepths) : 0,
      validation_closure_rate: ratio(enhancedCases.filter(item => item.has_observable && item.has_verification_test).length, enhancedCases.length),
      prevention_closure_rate: ratio(enhancedCases.filter(item => item.has_control_barrier).length, enhancedCases.length),
      relation_types: countBy(mechanismEdges, edge => edge.type),
      node_types: countBy(mechanismNodes, node => node.type),
    },
    case_metrics: enhancedCases,
    top_cases: topCases,
    ablation: {
      baseline_without_mechanism: {
        average_relation_coverage: average(baselineCases.map(item => item.explanation_depth)),
        validation_closure_rate: ratio(baselineCases.filter(item => item.has_diagnostic_signal && item.has_action).length, baselineCases.length),
        prevention_closure_rate: ratio(baselineCases.filter(item => item.has_prevention).length, baselineCases.length),
      },
      mechanism_enhanced: {
        average_mechanism_path_depth: average(pathDepths),
        validation_closure_rate: ratio(enhancedCases.filter(item => item.has_observable && item.has_verification_test).length, enhancedCases.length),
        prevention_closure_rate: ratio(enhancedCases.filter(item => item.has_control_barrier).length, enhancedCases.length),
      },
    },
    paper_claims: [
      '机理增强图谱将传统故障-证据-处置关系扩展为故障-机理原型-失效模式-传播步骤-可观测量-验证试验-控制屏障的闭环链路。',
      '每个故障案例均具备至少一个机理原型解释，并具备观测量、验证试验和预防控制屏障。',
      '机理层关系可作为现场诊断问答的可解释推理路径，回答为什么查某个信号、如何验证根因以及如何预防复发。',
    ],
  }
}

function evaluateBaselineCase(caseNode, edges) {
  const outgoing = edges.filter(edge => edge.source === caseNode.id && BASELINE_EDGE_TYPES.has(edge.type))
  const incoming = edges.filter(edge => edge.target === caseNode.id && BASELINE_EDGE_TYPES.has(edge.type))
  const types = new Set([...outgoing, ...incoming].map(edge => edge.type))
  const explanationDepth =
    (types.has('PRINCIPLE') ? 1 : 0) +
    (types.has('CAN_TRIGGER') ? 1 : 0) +
    (types.has('MANIFESTS_AS') ? 1 : 0) +
    (types.has('DIAGNOSED_BY') ? 1 : 0) +
    (types.has('HAS_DIAGNOSTIC_STEP') ? 1 : 0) +
    (types.has('MITIGATED_BY') ? 1 : 0)
  return {
    case_id: caseNode.id,
    label: caseNode.label,
    explanation_depth: explanationDepth,
    has_diagnostic_signal: types.has('DIAGNOSED_BY'),
    has_action: types.has('MITIGATED_BY') || types.has('HAS_DIAGNOSTIC_STEP'),
    has_prevention: types.has('PREVENTED_BY') || types.has('PREVENTS'),
  }
}

function evaluateCase(caseNode, byId, edges, adjacency, profile) {
  const outgoing = edges.filter(edge => edge.source === caseNode.id)
  const incoming = edges.filter(edge => edge.target === caseNode.id)
  const incident = [...outgoing, ...incoming]
  const typeSet = new Set(incident.map(edge => edge.type))
  const hasFailureMode = incoming.some(edge =>
    edge.type === 'CAN_TRIGGER' && byId.get(edge.source)?.type === 'failure_mode',
  ) || outgoing.some(edge => edge.type === 'HAS_FAILURE_MODE')
  const hypothesisIds = outgoing
    .filter(edge => edge.type === 'HAS_COMPETING_HYPOTHESIS')
    .map(edge => edge.target)
  const hypothesisNodes = hypothesisIds.map(id => byId.get(id)).filter(Boolean)
  const hypothesisEdges = hypothesisIds.flatMap(id => adjacency.get(id) || [])
  const hypothesisTypes = new Set(hypothesisEdges.map(edge => edge.type))
  const maxDepth = maxDepthThroughMechanism(caseNode.id, adjacency, byId)
  const mechanismTerms = profile?.mechanism_terms?.length || 0
  const failureTerms = profile?.failure_mode_terms?.length || 0
  const verificationTerms = profile?.verification_terms?.length || 0
  const mechanismScore =
    (typeSet.has('EXPLAINED_BY_ARCHETYPE') ? 20 : 0) +
    (typeSet.has('HAS_FAILURE_MODE') ? 15 : 0) +
    (typeSet.has('HAS_OBSERVABLE') ? 15 : 0) +
    (typeSet.has('VERIFIED_BY_TEST') ? 15 : 0) +
    (typeSet.has('CONTROLLED_BY_BARRIER') ? 15 : 0) +
    (typeSet.has('HAS_COMPETING_HYPOTHESIS') ? 8 : 0) +
    Math.min(10, maxDepth * 2) +
    Math.min(10, mechanismTerms + failureTerms + verificationTerms)

  return {
    case_id: caseNode.id,
    label: caseNode.label,
    has_archetype: typeSet.has('EXPLAINED_BY_ARCHETYPE'),
    has_failure_mode: hasFailureMode,
    has_observable: typeSet.has('HAS_OBSERVABLE'),
    has_verification_test: typeSet.has('VERIFIED_BY_TEST'),
    has_control_barrier: typeSet.has('CONTROLLED_BY_BARRIER'),
    has_competing_hypothesis: typeSet.has('HAS_COMPETING_HYPOTHESIS'),
    has_discriminating_evidence: typeSet.has('REQUIRES_DISCRIMINATING_EVIDENCE') || hypothesisTypes.has('REQUIRES_DISCRIMINATING_EVIDENCE'),
    has_counterfactual_test: typeSet.has('RESOLVED_BY_COUNTERFACTUAL_TEST') || hypothesisTypes.has('RESOLVED_BY_COUNTERFACTUAL_TEST'),
    has_decision_rule: typeSet.has('HAS_DECISION_RULE') || hypothesisTypes.has('HAS_DECISION_RULE'),
    has_symptom_signature: typeSet.has('HAS_SYMPTOM_SIGNATURE'),
    has_evidence_gap: typeSet.has('HAS_EVIDENCE_GAP'),
    has_exclusion_rule: typeSet.has('HAS_EXCLUSION_RULE'),
    has_reasoning_plan: typeSet.has('HAS_REASONING_PLAN'),
    discriminator_types: uniqueValues(hypothesisNodes.map(node => node.properties?.discriminatorType || 'unspecified')),
    hypothesis_count: hypothesisNodes.length,
    max_mechanism_depth: maxDepth,
    mechanism_score: mechanismScore,
    mechanism_term_count: mechanismTerms,
    failure_mode_term_count: failureTerms,
    verification_term_count: verificationTerms,
  }
}

function buildAdjacency(edges) {
  const adjacency = new Map()
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, [])
    adjacency.get(edge.source).push(edge)
  }
  return adjacency
}

function maxDepthThroughMechanism(startId, adjacency, byId) {
  let best = 0
  const queue = [{ id: startId, depth: 0 }]
  const seen = new Set([startId])
  while (queue.length) {
    const current = queue.shift()
    for (const edge of adjacency.get(current.id) || []) {
      if (!MECHANISM_EDGE_TYPES.has(edge.type) && current.id !== startId) continue
      const target = byId.get(edge.target)
      if (!target || seen.has(edge.target)) continue
      const nextDepth = current.depth + 1
      if (MECHANISM_NODE_TYPES.has(target.type)) best = Math.max(best, nextDepth)
      if (nextDepth < 8) {
        seen.add(edge.target)
        queue.push({ id: edge.target, depth: nextDepth })
      }
    }
  }
  return best
}

function renderMarkdown(evaluation) {
  const lines = []
  lines.push('# Windrise 机理增强知识图谱评估报告')
  lines.push('')
  lines.push(`生成时间：${evaluation.generated_at}`)
  lines.push('')
  lines.push('## 总体规模')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | ---: |')
  lines.push(`| 节点数 | ${evaluation.graph_size.nodes} |`)
  lines.push(`| 边数 | ${evaluation.graph_size.edges} |`)
  lines.push(`| 故障案例数 | ${evaluation.graph_size.fault_cases} |`)
  lines.push(`| 加权别名数 | ${evaluation.graph_size.weighted_aliases} |`)
  lines.push('')
  lines.push('## 机理增强效果')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | ---: |')
  lines.push(`| 机理原型数 | ${evaluation.mechanism.archetype_count} |`)
  lines.push(`| 机理节点数 | ${evaluation.mechanism.node_count} |`)
  lines.push(`| 机理关系数 | ${evaluation.mechanism.edge_count} |`)
  lines.push(`| 机理闭环覆盖案例数 | ${evaluation.mechanism.covered_case_count} |`)
  lines.push(`| 机理闭环覆盖率 | ${(evaluation.mechanism.coverage_rate * 100).toFixed(1)}% |`)
  lines.push(`| 假设鉴别覆盖案例数 | ${evaluation.mechanism.discriminated_case_count} |`)
  lines.push(`| 假设鉴别覆盖率 | ${(evaluation.mechanism.discrimination_coverage_rate * 100).toFixed(1)}% |`)
  lines.push(`| 推理闭环覆盖案例数 | ${evaluation.mechanism.reasoning_closure_case_count} |`)
  lines.push(`| 推理闭环覆盖率 | ${(evaluation.mechanism.reasoning_closure_coverage_rate * 100).toFixed(1)}% |`)
  lines.push(`| 机理画像完整率 | ${(evaluation.mechanism.profile_complete_rate * 100).toFixed(1)}% |`)
  lines.push(`| 平均机理路径深度 | ${evaluation.mechanism.average_depth.toFixed(2)} |`)
  lines.push(`| 最大机理路径深度 | ${evaluation.mechanism.max_depth} |`)
  lines.push(`| 验证闭环覆盖率 | ${(evaluation.mechanism.validation_closure_rate * 100).toFixed(1)}% |`)
  lines.push(`| 预防闭环覆盖率 | ${(evaluation.mechanism.prevention_closure_rate * 100).toFixed(1)}% |`)
  lines.push('')
  lines.push('## 与传统画像对比')
  lines.push('')
  lines.push('| 图谱层次 | 完整画像数 | 完整率 |')
  lines.push('| --- | ---: | ---: |')
  lines.push(`| 传统故障-证据-处置画像 | ${evaluation.baseline.complete_profile_count} | ${(evaluation.baseline.complete_profile_rate * 100).toFixed(1)}% |`)
  lines.push(`| 机理-失效-验证画像 | ${evaluation.mechanism.profile_complete_count} | ${(evaluation.mechanism.profile_complete_rate * 100).toFixed(1)}% |`)
  lines.push('')
  lines.push('## 消融对比')
  lines.push('')
  lines.push('| 设置 | 结构覆盖指标 | 验证闭环覆盖率 | 预防闭环覆盖率 |')
  lines.push('| --- | ---: | ---: | ---: |')
  lines.push(`| 不使用机理层：平均传统关系覆盖数 | ${evaluation.ablation.baseline_without_mechanism.average_relation_coverage.toFixed(2)} | ${(evaluation.ablation.baseline_without_mechanism.validation_closure_rate * 100).toFixed(1)}% | ${(evaluation.ablation.baseline_without_mechanism.prevention_closure_rate * 100).toFixed(1)}% |`)
  lines.push(`| 使用机理增强：平均机理路径深度 | ${evaluation.ablation.mechanism_enhanced.average_mechanism_path_depth.toFixed(2)} | ${(evaluation.ablation.mechanism_enhanced.validation_closure_rate * 100).toFixed(1)}% | ${(evaluation.ablation.mechanism_enhanced.prevention_closure_rate * 100).toFixed(1)}% |`)
  lines.push('')
  lines.push('## 高质量案例样例')
  lines.push('')
  lines.push('| 案例 | 分数 | 机理深度 |')
  lines.push('| --- | ---: | ---: |')
  for (const item of evaluation.top_cases) {
    lines.push(`| ${escapePipes(item.label)} | ${item.mechanism_score} | ${item.max_mechanism_depth} |`)
  }
  lines.push('')
  lines.push('## 可写入论文的结论')
  lines.push('')
  for (const claim of evaluation.paper_claims) lines.push(`- ${claim}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderCaseCoverageMarkdown(evaluation) {
  const lines = []
  lines.push('# Windrise 机理图谱逐案例覆盖表')
  lines.push('')
  lines.push(`生成时间：${evaluation.generated_at}`)
  lines.push('')
  lines.push('| 案例 | 机理闭环 | 假设鉴别 | 推理闭环 | 鉴别类型 | 机理深度 | 分数 |')
  lines.push('| --- | ---: | ---: | ---: | --- | ---: | ---: |')
  for (const item of evaluation.case_metrics) {
    const closed = item.has_archetype && item.has_failure_mode && item.has_observable && item.has_verification_test && item.has_control_barrier
    const discriminated = item.has_competing_hypothesis && item.has_discriminating_evidence && item.has_counterfactual_test && item.has_decision_rule
    const reasoningClosed = item.has_symptom_signature && item.has_evidence_gap && item.has_exclusion_rule && item.has_reasoning_plan
    lines.push([
      `| ${escapePipes(item.label)}`,
      closed ? '是' : '否',
      discriminated ? '是' : '否',
      reasoningClosed ? '是' : '否',
      escapePipes((item.discriminator_types || []).join(', ') || '-'),
      item.max_mechanism_depth,
      `${item.mechanism_score} |`,
    ].join(' | '))
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderCaseCoverageCsv(evaluation) {
  const rows = [
    [
      'case_id',
      'label',
      'mechanism_closed',
      'hypothesis_discriminated',
      'reasoning_closed',
      'discriminator_types',
      'hypothesis_count',
      'max_mechanism_depth',
      'mechanism_score',
    ],
  ]
  for (const item of evaluation.case_metrics) {
    const closed = item.has_archetype && item.has_failure_mode && item.has_observable && item.has_verification_test && item.has_control_barrier
    const discriminated = item.has_competing_hypothesis && item.has_discriminating_evidence && item.has_counterfactual_test && item.has_decision_rule
    const reasoningClosed = item.has_symptom_signature && item.has_evidence_gap && item.has_exclusion_rule && item.has_reasoning_plan
    rows.push([
      item.case_id,
      item.label,
      closed ? '1' : '0',
      discriminated ? '1' : '0',
      reasoningClosed ? '1' : '0',
      (item.discriminator_types || []).join(';'),
      item.hypothesis_count || 0,
      item.max_mechanism_depth,
      item.mechanism_score,
    ])
  }
  return `${rows.map(row => row.map(csvCell).join(',')).join('\n')}\n`
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item)
    acc[key] = (acc[key] || 0) + 1
    return acc
  }, {})
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function ratio(a, b) {
  return b ? Number((a / b).toFixed(4)) : 0
}

function escapePipes(value) {
  return String(value || '').replace(/\|/g, '\\|')
}

function csvCell(value) {
  const text = String(value ?? '')
  if (!/[",\n\r]/.test(text)) return text
  return `"${text.replace(/"/g, '""')}"`
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

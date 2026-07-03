import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'simple_home.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const graphMatch = html.match(/<script id="curatedPartsGraphData" type="application\/json">([\s\S]*?)<\/script>/);
if (!graphMatch) throw new Error('curatedPartsGraphData not found in simple_home.html');

const graphData = JSON.parse(graphMatch[1]);
const pageScripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .join('\n');

const fakeEl = () => ({
  textContent: '',
  value: '',
  style: {},
  classList: { add() {}, remove() {}, contains() { return false; } },
  querySelector: () => fakeEl(),
  querySelectorAll: () => [],
  appendChild() {},
  remove() {},
  innerHTML: '',
  dataset: {},
  focus() {},
  addEventListener() {},
  setAttribute() {},
  getAttribute() { return '0 0 900 430'; },
  getBoundingClientRect() { return { width: 900, height: 430 }; },
});

globalThis.window = {
  __reasoningNodes: [],
  __reasoningEdges: [],
  __reasoningGraphCache: null,
  CSS: { escape: value => String(value) },
  addEventListener() {},
  location: { href: 'http://localhost/simple_home.html?chat=1', search: '?chat=1' },
};
globalThis.document = {
  getElementById: () => fakeEl(),
  querySelectorAll: () => [],
  querySelector: () => fakeEl(),
  addEventListener() {},
  body: fakeEl(),
  createElement: () => fakeEl(),
  createElementNS: () => fakeEl(),
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = globalThis.window.location;
globalThis.marked = { parse: value => value };
globalThis.fetch = async () => ({ ok: false });
globalThis.requestAnimationFrame = fn => fn();

const api = new Function(`${pageScripts}
return {
  enhanceWindFaultReasoningGraph,
  buildReasoningGraph,
  reasoningFinalConclusion,
  reasoningScoreBreakdownText,
  reasoningVisualState,
  reasoningNodeStatus,
  reasoningVisibleNetwork,
  rememberReasoningEvidence,
  findOriginalDocxAnswer,
  shouldUseReasoningChain
};`)();

const enhanced = api.enhanceWindFaultReasoningGraph(graphData);
window.__reasoningNodes = enhanced.nodes;
window.__reasoningEdges = enhanced.edges.map((edge, index) => ({ ...edge, id: edge.id || `edge:${index}` }));
window.__reasoningGraphCache = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function graphFor(message, intent = 'cause') {
  return api.buildReasoningGraph('case:yaw_hydraulic_pressure', intent, message);
}

function visibleLabels(graph) {
  return api.reasoningVisibleNetwork(graph.seed, graph.graph).nodes.map(node => node.label);
}

function labels(items) {
  return items.map(item => item.label).join('、');
}

assert(api.shouldUseReasoningChain('你好') === false, 'plain greeting must not trigger reasoning chain');
assert(api.shouldUseReasoningChain('您好，在吗？') === false, 'small talk must not trigger reasoning chain');
assert(api.shouldUseReasoningChain('你好，齿轮箱过热了怎么办') === true, 'fault question with greeting should still trigger reasoning chain');
assert(api.shouldUseReasoningChain('SCADA报偏航压力异常波动，液压站持续欠压。下一步先做什么？') === true, 'fault diagnostic question should trigger reasoning chain');

const cases = [
  {
    name: 'low-evidence alarm only',
    message: 'SCADA报偏航压力异常波动，液压站持续欠压。现场尚未拆阀，也未更换液压泵。下一步先做哪一个验证动作？',
    expect: graph => {
      assert(graph.assessment.score === 18, `expected score 18, got ${graph.assessment.score}`);
      assert(graph.assessment.level === '待验证', `expected 待验证, got ${graph.assessment.level}`);
      assert(!graph.assessment.confirmedCauses.length, 'alarm-only case must not confirm a root cause');
      assert(api.reasoningFinalConclusion(graph, graph.steps).includes('等待现场证据闭环'), 'alarm-only conclusion must wait for evidence closure');
      assert(!visibleLabels(graph).includes('隐蔽阻尼缓冲器堵塞'), 'alarm-only graph must not expose hidden damper root cause');
    },
  },
  {
    name: 'pressure-time supports abnormal link only',
    message: '已按要求手动释放并恢复刹车：系统压力从151bar迅速降至27bar，恢复至135bar用120s，恢复至145bar用150s，恢复至150bar用300s。下一步只需要观察什么？',
    expect: graph => {
      assert(graph.assessment.score === 40, `expected score 40, got ${graph.assessment.score}`);
      assert(graph.assessment.supportedFaultLinks.includes('偏航回路液压油流量受限'), 'pressure-time case should support flow restriction');
      assert(!graph.assessment.confirmedCauses.length, 'pressure-time case must not confirm hidden damper root cause');
      assert(api.reasoningFinalConclusion(graph, graph.steps).includes('仍需继续定位具体元器件'), 'pressure-time conclusion must require component localization');
      assert(!visibleLabels(graph).includes('隐蔽阻尼缓冲器堵塞'), 'pressure-time graph must not expose hidden damper root cause');
    },
  },
  {
    name: 'complete positive closure',
    message: '已按要求手动释放并恢复刹车：系统压力从151bar迅速降至27bar，恢复至135bar用120s，恢复至145bar用150s，恢复至150bar用300s。已将偏航回路和高速制动回路的常开电磁换向阀调换，偏航回路压力上升速度仍然非常缓慢。主回路压力为280bar，液压泵电流值为2.5A。厂家确认图纸未标注隐蔽阻尼缓冲器，拆检发现孔洞堵塞，清理后偏航回路压力11s升至153bar且无新增告警。',
    expect: graph => {
      assert(graph.assessment.score === 94, `expected score 94, got ${graph.assessment.score}`);
      assert(graph.assessment.level === '较高可信', `expected 较高可信, got ${graph.assessment.level}`);
      assert(graph.assessment.confirmedCauses.includes('隐蔽阻尼缓冲器堵塞'), 'complete case should confirm hidden damper blockage');
      assert(api.reasoningFinalConclusion(graph, graph.steps).includes('确认根因'), 'complete case should allow confirmed root cause wording');
      assert(visibleLabels(graph).includes('隐蔽阻尼缓冲器堵塞'), 'complete graph should expose hidden damper root cause');
      const state = api.reasoningVisualState(graph, graph.steps);
      const hidden = graph.graph.byId.get('cause:hidden_damper_blocked');
      assert(api.reasoningNodeStatus(hidden, state) === 'confirmed', 'hidden damper node should be visually confirmed');
    },
  },
  {
    name: 'valve-transfer counter evidence',
    message: '已按要求手动释放并恢复刹车：系统压力从151bar迅速降至27bar，恢复至150bar用300s。已将偏航回路和高速制动回路的常开电磁换向阀调换，调换后故障随阀转移。',
    expect: graph => {
      assert(graph.assessment.counterEvidence.some(item => item.tag === 'counter_valve_transfer'), 'valve-transfer counter evidence not detected');
      assert(graph.assessment.score === 28, `expected score 28, got ${graph.assessment.score}`);
      assert(graph.assessment.level === '待验证', `expected 待验证, got ${graph.assessment.level}`);
      assert(!api.reasoningFinalConclusion(graph, graph.steps).includes('确认根因'), 'counter evidence must block root cause confirmation');
    },
  },
  {
    name: 'sensor mismatch counter evidence',
    message: 'SCADA报偏航压力异常，但机械压力表正常，HMI压力显示偏低不一致。',
    expect: graph => {
      assert(graph.assessment.counterEvidence.some(item => item.tag === 'counter_sensor_mismatch'), 'sensor mismatch counter evidence not detected');
      assert(graph.assessment.score === 8, `expected score 8, got ${graph.assessment.score}`);
      assert(api.reasoningFinalConclusion(graph, graph.steps).includes('存在反证待复核'), 'sensor counter evidence must force review wording');
    },
  },
  {
    name: 'hidden damper treatment ineffective counter evidence',
    message: '已按要求手动释放并恢复刹车：系统压力从151bar迅速降至27bar，恢复至135bar用120s，恢复至145bar用150s，恢复至150bar用300s。厂家确认图纸未标注隐蔽阻尼缓冲器，清理隐蔽阻尼缓冲器后压力恢复无改善。',
    expect: graph => {
      assert(graph.assessment.counterEvidence.some(item => item.tag === 'counter_after_clean_no_change'), 'treatment ineffective counter evidence not detected');
      assert(graph.assessment.score === 46, `expected score 46, got ${graph.assessment.score}`);
      assert(graph.assessment.level === '待验证', `expected 待验证, got ${graph.assessment.level}`);
      assert(api.reasoningFinalConclusion(graph, graph.steps).includes('当前不能确认原根因'), 'ineffective treatment must block original root cause confirmation');
    },
  },
];

for (const testCase of cases) {
  const graph = graphFor(testCase.message);
  testCase.expect(graph);
  console.log(`ok - ${testCase.name}: ${graph.assessment.score}/100 ${graph.assessment.level}`);
}

const redesignedQuestions = [
  {
    question: 'SCADA报偏航压力异常波动，液压站持续欠压。现场尚未拆阀，也未更换液压泵。下一步先做哪一个验证动作？',
    expectedAnswerPart: '手动释放刹车，再恢复刹车',
    expectedEvidence: ['现场显示/告警反馈已提供'],
  },
  {
    question: '已按要求手动释放并恢复刹车：系统压力从151bar迅速降至27bar，恢复至135bar用120s，恢复至145bar用150s，恢复至150bar用300s。下一步只需要观察什么？',
    expectedAnswerPart: '液压站电机动作次数',
    expectedEvidence: ['现场压力数据', '现场时间数据'],
  },
  {
    question: '复测时液压站电机只动作一次，运行时液压站未产生异常声响。下一步只测哪一项？',
    expectedAnswerPart: '测量主回路压力和液压泵电流',
    expectedEvidence: ['液压站动作次数已提供'],
  },
  {
    question: '主回路压力为280bar，液压泵电流值为2.5A。下一步只验证哪个部件？',
    expectedAnswerPart: '偏航回路常开电磁换向阀',
    expectedEvidence: ['主回路压力/液压泵电流检查结果已提供'],
    expectedExcluded: ['主回路故障'],
  },
  {
    question: '已将偏航回路和高速制动回路的常开电磁换向阀调换，偏航回路压力上升速度仍然非常缓慢。下一步只检查哪个阀？',
    expectedAnswerPart: '常开截止阀',
    expectedEvidence: ['调换电磁换向阀后现象未转移'],
    expectedExcluded: ['电磁换向阀故障'],
  },
];

for (const [index, item] of redesignedQuestions.entries()) {
  const graph = graphFor(item.question, 'diagnosis');
  const answer = api.findOriginalDocxAnswer(item.question);
  const evidenceLabels = graph.runtimeEvidence.map(evidence => evidence.label);
  assert(graph.steps.length > 0, `redesigned question ${index + 1} did not generate reasoning steps`);
  assert(graph.runtimeEvidence.length > 0, `redesigned question ${index + 1} did not extract runtime evidence`);
  assert(graph.seed.id === 'case:yaw_hydraulic_pressure', `redesigned question ${index + 1} did not use yaw hydraulic case`);
  assert(answer, `redesigned question ${index + 1} did not hit curated answer`);
  assert(answer.startsWith('结论：'), `redesigned question ${index + 1} answer should start with conclusion`);
  assert(answer.includes(item.expectedAnswerPart), `redesigned question ${index + 1} answer missing expected action: ${item.expectedAnswerPart}`);
  assert((answer.match(/下一步/g) || []).length === 1, `redesigned question ${index + 1} should contain exactly one next-step instruction`);
  assert(!/(推理|图谱|证据链|JSON|可信度|评分|右侧|下方卡片)/.test(answer), `redesigned question ${index + 1} exposes internal wording`);
  assert(!/建议/.test(answer), `redesigned question ${index + 1} should give direct action, not suggestion wording`);
  assert(answer.length <= 220, `redesigned question ${index + 1} answer too long for field/investor demo: ${answer.length}`);
  assert(!graph.assessment.confirmedCauses.length, `redesigned question ${index + 1} must not prematurely confirm root cause`);
  for (const expected of item.expectedEvidence || []) {
    assert(evidenceLabels.some(label => label.includes(expected)), `redesigned question ${index + 1} missing evidence label: ${expected}`);
  }
  for (const expected of item.expectedExcluded || []) {
    assert(graph.assessment.excluded.some(label => label.includes(expected)), `redesigned question ${index + 1} missing exclusion: ${expected}`);
  }
  console.log(`ok - redesigned question ${index + 1}: ${labels(graph.runtimeEvidence)}`);
}

const context1 = api.rememberReasoningEvidence(
  'case:yaw_hydraulic_pressure',
  '手动释放刹车后，系统压力从151bar迅速降至27bar，恢复至150bar时长为300s。'
);
api.rememberReasoningEvidence(
  'case:yaw_hydraulic_pressure',
  '调换偏航回路和高速制动回路的电磁换向阀后，偏航回路压力上升速度仍然非常缓慢。'
);
const context3 = api.rememberReasoningEvidence(
  'case:yaw_hydraulic_pressure',
  '厂家确认图纸未标注隐蔽阻尼缓冲器，清理后偏航回路压力11s升至153bar。'
);
assert(context1.includes('第1轮'), 'first memory context should include turn source');
assert(context3.includes('第1轮') && context3.includes('第2轮') && context3.includes('第3轮'), 'multi-turn context should retain evidence from all turns');
const multiTurnGraph = graphFor(context3);
assert(multiTurnGraph.runtimeEvidence.some(item => item.source.includes('第1轮') && item.source.includes('第3轮')), 'multi-turn pressure evidence should preserve multiple sources');
assert(multiTurnGraph.assessment.confirmedCauses.includes('隐蔽阻尼缓冲器堵塞'), 'multi-turn evidence should support hidden damper after confirmation evidence');
console.log(`ok - multi-turn accumulation: ${labels(multiTurnGraph.runtimeEvidence)}`);

console.log('reasoning-chain verification passed');

#!/usr/bin/env node
/**
 * Decision-level routing tests for windrise-chat.mjs.
 *
 * These tests import the PURE routing functions directly and assert on the
 * routing decision ({action, query/message}) — they never launch the REPL or
 * call the local model. This lets us verify context handling (supplement /
 * correction / new-fault / disambiguation) deterministically and offline.
 *
 * Run: node scripts/test-routing-decision.mjs
 */

import {
  classifyTurnIntent,
  resolveFaultRouting,
  siteHasMultipleModels,
  extractUserSlots,
  mergeUserSlots,
} from './windrise-chat.mjs'

let failures = 0
let passes = 0

function check(name, cond, detail = '') {
  if (cond) {
    passes += 1
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// A tiny simulator: replays a multi-turn conversation through the gate,
// updating local slot state the same way handleLine does, and records each
// turn's routing decision. It does NOT run the actual knowledge search.
function runConversation(turns) {
  let recentFaultContext = null
  let recentUserSlots = {}
  const decisions = []
  for (const text of turns) {
    const route = resolveFaultRouting(text, { recentFaultContext, recentUserSlots })
    decisions.push(route)
    // Mirror handleLine's state mutations for clarify / retrieve.
    if (route.action === 'clarify') {
      recentUserSlots = mergeUserSlots(recentUserSlots, route.nextSlots)
    } else if (route.action === 'retrieve') {
      recentUserSlots = route.nextSlots
    } else {
      // fallthrough: approximate rememberConversation's new_fault reset so the
      // simulated state tracks the real REPL.
      const intent = classifyTurnIntent(text, { recentUserSlots, recentFaultContext })
      const cur = extractUserSlots(text)
      if (intent === 'new_fault') {
        recentUserSlots = cur
        recentFaultContext = null
      } else {
        recentUserSlots = mergeUserSlots(recentUserSlots, cur)
      }
    }
  }
  return decisions
}

// ---------------------------------------------------------------------------
// 1. The original reported bug: 八面(带机号) -> 轴承温度异常 -> 四平风场
// ---------------------------------------------------------------------------
{
  const d = runConversation([
    '八面风场zc09风机偏航回路欠压故障触发条件是什么',
    '轴承温度异常怎么处理',
    '四平风场',
  ])
  // Turn 3 must NOT retrieve — it must ask which 四平 model.
  check(
    '[bug] turn3 "四平风场" asks for model, does not search',
    d[2].action === 'clarify' && /机型|期次/.test(d[2].message || ''),
    `got action=${d[2].action}`,
  )
  // Turn 2 (new component, no site/model) should clarify (missing site/model)
  // rather than silently searching with 八面/偏航 inherited.
  check(
    '[bug] turn2 "轴承温度异常怎么处理" does not inherit 八面/偏航',
    d[1].action !== 'retrieve' ||
      !/(八面|偏航|欠压)/.test(d[1].query || ''),
    `got action=${d[1].action} query=${d[1].query || ''}`,
  )
}

// ---------------------------------------------------------------------------
// 2. Multi-model site detection
// ---------------------------------------------------------------------------
check('[site] 四平 maps to multiple models', siteHasMultipleModels('四平风场') === true)
check('[site] 八面 is single entry', siteHasMultipleModels('八面风场') === false)

// ---------------------------------------------------------------------------
// 3. Supplement flow: incomplete fault -> add site -> add model -> search
// ---------------------------------------------------------------------------
{
  const d = runConversation([
    '轴承温度过高怎么办',      // new_fault, no site -> clarify (missing site)
    '新华风场',                 // slot_fill supplement; 新华 single model -> retrieve
  ])
  check(
    '[supplement] turn1 missing site -> clarify',
    d[0].action === 'clarify',
    `got ${d[0].action}`,
  )
  check(
    '[supplement] turn2 add 新华 -> retrieve with 轴承 context',
    d[1].action === 'retrieve' && /新华/.test(d[1].query || '') && /轴承/.test(d[1].query || ''),
    `got action=${d[1].action} query=${d[1].query || ''}`,
  )
}

// ---------------------------------------------------------------------------
// 4. Correction flow: 不是X是Y replaces site
// ---------------------------------------------------------------------------
{
  const intent = classifyTurnIntent('不是八面，是四平', { recentUserSlots: { site: '八面', symptom: ['温度高'] } })
  check('[correction] "不是八面，是四平" classified as correction', intent === 'correction', `got ${intent}`)
}

// ---------------------------------------------------------------------------
// 5. New-fault classification does not inherit old topic
// ---------------------------------------------------------------------------
{
  const intent = classifyTurnIntent('齿轮箱油温上来了', {
    recentUserSlots: { component: ['偏航'], symptom: ['欠压'] },
  })
  check('[new_fault] different component -> new_fault', intent === 'new_fault', `got ${intent}`)
}

// ---------------------------------------------------------------------------
// 6. Followup stays followup (same topic, anaphoric)
// ---------------------------------------------------------------------------
{
  const intent = classifyTurnIntent('这个怎么复位', {
    recentUserSlots: { component: ['偏航'], symptom: ['欠压'], site: '八面' },
    recentFaultContext: { code: '709', name: '顺时针扭缆超限停机' },
  })
  check('[followup] "这个怎么复位" -> followup', intent === 'followup', `got ${intent}`)
}

// ---------------------------------------------------------------------------
// 7. Fully-scoped single query searches directly (no clarify)
// ---------------------------------------------------------------------------
{
  const route = resolveFaultRouting('新华风场运达WD1500轴承温度过高怎么处理', {
    recentFaultContext: null,
    recentUserSlots: {},
  })
  check(
    '[complete] site+model+issue -> retrieve directly',
    route.action === 'retrieve',
    `got ${route.action}`,
  )
}

// ---------------------------------------------------------------------------
// 8. Bare fault code is self-sufficient -> fallthrough to existing retrieval
// ---------------------------------------------------------------------------
{
  const route = resolveFaultRouting('303804是什么故障', {
    recentFaultContext: null,
    recentUserSlots: {},
  })
  check(
    '[code] bare fault code -> fallthrough (existing retrieval handles it)',
    route.action === 'fallthrough',
    `got ${route.action}`,
  )
}

console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)

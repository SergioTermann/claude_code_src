#!/usr/bin/env node
/**
 * Simulates keywords that consolidate_windrise_user_query would extract from
 * natural user utterances, then tests LLMWiki search hit quality.
 *
 * Each case:
 *   utterance   – what the user actually typed
 *   keywords    – fabricated extraction output (rewritten retrieval query)
 *   turbine_id  – expected turbine label after normalization (optional)
 *   expects     – substrings that should appear in a good hit
 *   rejects     – substrings that indicate a bad hit
 */

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const windrise = join(root, 'bin', 'windrise')
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

const cases = [
  {
    utterance: '新华那边504一直报警，发电机轴承温度高，怎么处理？',
    keywords: '新华 504 发电机 驱动端 温度高 处理',
    expects: ['504', '发电机', '轴承', '温度', '新华'],
    rejects: ['本地库暂未找到', 'No matches'],
  },
  {
    utterance: '新华12号机504发电机轴承温度高怎么处理',
    keywords: '新华 A12# 504 发电机 驱动端 温度高 处理',
    turbine_id: 'A12#',
    expects: ['504', '新华', '发电机', 'A12#'],
    rejects: ['No matches', '本地库暂未找到'],
  },
  {
    utterance: '团结风场运达机型，风速仪故障对应什么故障码？',
    keywords: '团结 运达 风速仪故障',
    expects: ['风速仪故障', '5307', '团结'],
    rejects: ['没有找到与当前描述精确匹配', '5301'],
  },
  {
    utterance: '变桨24V那个开关跳了，是啥码？',
    keywords: '变桨 24V 跳闸',
    expects: ['303804', '24V', '主电源开关'],
    rejects: ['No matches', '本地库暂未找到'],
  },
  {
    utterance: '主断路器异常跳开，变流器那边报的，查一下故障码',
    keywords: '主断路器 跳闸',
    expects: ['主断路器', '3356', '变流器'],
    rejects: ['本地库暂未找到精确记录'],
  },
  {
    utterance: '顺时针扭缆超限停机，输入扭揽打错了字也能查到吧',
    keywords: '顺时针扭缆超限停机',
    expects: ['709', '顺时针扭缆超限停机'],
    rejects: ['No matches'],
  },
  {
    utterance: '齿轮箱油温有点高，有哪些故障码？',
    keywords: '齿轮箱 温度高',
    expects: ['齿轮箱', '117', '温度'],
    rejects: ['按名称/描述「齿轮箱温度高有」'],
  },
  {
    utterance: '洮北58号机偏航传感器有问题怎么处理',
    keywords: '洮北 58号 偏航 传感器异常 处理',
    turbine_id: '58#',
    expects: ['洮北', '偏航', '58#', '101'],
    rejects: ['No matches', '故障码 58 未找到'],
  },
  {
    utterance: '三一320是啥意思，主轴那边超速？',
    keywords: '三一 320',
    expects: ['320', '三一', '主轴超速'],
    rejects: ['变频器检测到故障(EMS)', 'WP2035'],
  },
  {
    utterance: '变桨电池充电器坏了是什么码',
    keywords: '变桨 充电器故障',
    expects: ['充电器', '303122', '变桨'],
    rejects: ['本地库暂未找到'],
  },
  {
    utterance: '709扭缆，裕民和什花道都有吗',
    keywords: '709 扭缆',
    expects: ['709', '扭缆', '裕民', '什花道'],
    rejects: ['No matches'],
  },
  {
    utterance: '四平1号机报709扭缆怎么处理',
    keywords: '四平 S01# 709',
    turbine_id: 'S01#',
    expects: ['709', '扭缆', '四平', 'S01#'],
    rejects: ['未找到与', '5012', 'No matches'],
  },
  {
    utterance: '四平1号机报709扭缆怎么处理（提取若追加处理后缀）',
    keywords: '四平 S01# 709 处理',
    turbine_id: 'S01#',
    expects: ['709', 'S01#'],
    rejects: [],
    optional: true,
  },
  {
    utterance: '华仪风速仪故障在哪些风场有',
    keywords: '华仪 风速仪故障',
    expects: ['170010', '华仪', '风速仪故障'],
    rejects: ['700007', '5301'],
  },
  {
    utterance: '超级电容容量低了怎么办',
    keywords: '超级电容 容量低 处理',
    expects: ['超级电容', '容量'],
    rejects: ['No matches'],
  },
  {
    utterance: '报80，变频器故障',
    keywords: '故障码 80 变频器',
    expects: ['故障码 80', '变频器'],
    rejects: ['风机编号「80#」', '0100001'],
  },
  {
    utterance: '303804这个码在哪些风场机型有',
    keywords: '303804',
    expects: ['303804', '24V'],
    rejects: ['No matches'],
  },
  {
    utterance: '齿轮箱温度高和油温高是不是同一个码',
    keywords: '齿轮箱 温度高',
    expects: ['齿轮箱', '117'],
    rejects: ['按名称/描述「齿轮箱温度高有」'],
  },
  // --- 编号定位 / 映射 ---
  {
    utterance: '洮北58号是哪台机什么机型',
    keywords: '洮北 58号',
    turbine_id: '58#',
    expects: ['风机编号「58#」', '洮北', '歌美飒', 'G58-850'],
    rejects: ['No matches'],
  },
  {
    utterance: '团结S03是什么机型',
    keywords: '团结 S03',
    turbine_id: 'S03',
    expects: ['风机编号「S03」', '团结', '三一', 'SI-200625'],
    rejects: ['No matches'],
  },
  {
    utterance: 'SH09是哪台',
    keywords: 'SH09',
    turbine_id: 'SH09',
    expects: ['风机编号「SH09」', '富荣', 'LeapX'],
    rejects: ['W2000系列', '该机型对应的风场如下'],
  },
  {
    utterance: '四平SH09是哪台机',
    keywords: '四平 SH09',
    turbine_id: 'SH09#',
    expects: ['风机编号「SH09#」', '四平', 'W2000'],
    rejects: ['LeapX', '富荣风电场'],
  },
  {
    utterance: '编号SH09查一下',
    keywords: 'SH09',
    turbine_id: 'SH09',
    expects: ['风机编号「SH09」', '富荣', 'LeapX'],
    rejects: ['该机型对应的风场如下'],
  },
  {
    utterance: '团结S03扭缆了怎么办',
    keywords: '团结 S03 扭缆',
    turbine_id: 'S03',
    expects: ['扭缆', '团结', '三一', 'S03'],
    rejects: ['本地答案：S03', '需要补充定位', 'No matches'],
  },
  {
    utterance: '四平风场SH09风机机舱温度超限怎么处理',
    keywords: '四平 SH09 机舱 温度高 处理',
    turbine_id: 'SH09#',
    expects: ['270011', '机舱', '四平', 'SH09'],
    rejects: ['需要补充定位', 'LeapX', '431 条'],
  },
  {
    utterance: '洮北58号偏航传感器故障怎么处理',
    keywords: '洮北 58号 偏航 传感器异常 处理',
    turbine_id: '58#',
    expects: ['偏航传感器', '洮北', '58#', '101'],
    rejects: ['故障码 58 未找到', '需要补充定位'],
  },
]

const mode = process.env.EVAL_MODE || 'windrise' // windrise | llmwiki

let failures = 0
let hits = 0
let total = 0
let turbineCases = 0
let turbineHits = 0

console.log(`Mode: ${mode} | cases: ${cases.length}\n`)

for (const testCase of cases) {
  const isOptional = Boolean(testCase.optional)
  if (!isOptional) total += 1
  let stdout
  try {
    stdout = await runSearch(testCase.keywords)
  } catch (error) {
    failures += 1
    console.log(`ERROR keywords="${testCase.keywords}"`)
    console.log(`  user: ${testCase.utterance}`)
    if (testCase.turbine_id) console.log(`  turbine_id: ${testCase.turbine_id}`)
    console.log(`  ${error.message}`)
    continue
  }

  const missing = (testCase.expects || []).filter((needle) => !stdout.includes(needle))
  const rejected = (testCase.rejects || []).filter((needle) => stdout.includes(needle))
  const ok = missing.length === 0 && rejected.length === 0

  if (ok && !isOptional) hits += 1
  else if (!isOptional) failures += 1

  if (testCase.turbine_id) {
    turbineCases += 1
    if (ok) turbineHits += 1
  }

  const turbineTag = testCase.turbine_id ? ` [编号=${testCase.turbine_id}]` : ''
  const status = ok ? 'HIT' : isOptional ? 'WARN' : 'MISS'
  console.log(`${status} keywords="${testCase.keywords}"${turbineTag}`)
  console.log(`  user: ${testCase.utterance}`)
  if (!ok) {
    if (missing.length) console.log(`  missing: ${missing.join(' | ')}`)
    if (rejected.length) console.log(`  bad hit: ${rejected.join(' | ')}`)
  }
  console.log(`  preview: ${clip(stdout)}\n`)
}

const rate = total ? ((hits / total) * 100).toFixed(1) : 'n/a'
const turbineRate = turbineCases
  ? ((turbineHits / turbineCases) * 100).toFixed(1)
  : 'n/a'
console.log(
  `--- Summary: ${hits}/${total} hit (${rate}%), ${failures} miss/error ---`,
)
if (turbineCases) {
  console.log(
    `--- Turbine ID cases: ${turbineHits}/${turbineCases} hit (${turbineRate}%) ---`,
  )
}

if (failures) process.exit(1)

async function runSearch(query) {
  if (mode === 'llmwiki') {
    const { stdout } = await execFileAsync(process.execPath, [
      runner,
      '--print',
      '--bare',
      `/llmwiki search ${query} --limit 4`,
    ], {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: join(root, '风机故障码'),
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    })
    return stdout
  }

  const { stdout } = await execFileAsync(windrise, ['search', query], {
    cwd: root,
    env: {
      ...process.env,
      LLMWIKI_PROJECT: join(root, '风机故障码'),
      WINDRISE_DISABLE_AUTO_LLMWIKI: '1',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
  })
  return stdout
}

function clip(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 280)
}

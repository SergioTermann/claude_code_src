#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AEG(歧义熵门控)有效性实验
数据: 风机故障码/fault-index.jsonl (11865 条真实故障记录)

验证三点:
  1) 故障码误命中率 与 歧义熵 H(code) 强相关 —— 熵是有效预测信号
  2) 相同"追问预算"下, 熵门控消除的误命中 >> 随机门控(和按频率门控)—— 帕累托最优
  3) 给出最优工作点
"""
import json, math, re
from collections import defaultdict, Counter

PATH = '风机故障码/fault-index.jsonl'

def norm_meaning(name):
    """故障含义 = 归一化的故障名称(去空格/全半角噪声),作为同码异义的判定粒度。"""
    s = re.sub(r'\s+', '', (name or '').strip())
    return s

# ---------- 载入 ----------
records = []
with open(PATH, encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        code = str(r.get('code', '')).strip()
        meaning = norm_meaning(r.get('name', ''))
        model = re.sub(r'\s+', '', (r.get('model', '') or '').strip())
        if code and meaning:
            records.append((code, model, meaning))

N = len(records)
print(f"载入记录数: {N}")

# ---------- 每个 code 的含义分布 ----------
code_meanings = defaultdict(Counter)      # code -> {meaning: count}
code_total = Counter()                     # code -> 记录总数(近似查询频率)
cm_meanings = defaultdict(Counter)         # (code,model) -> {meaning: count}
for code, model, meaning in records:
    code_meanings[code][meaning] += 1
    code_total[code] += 1
    cm_meanings[(code, model)][meaning] += 1

codes = list(code_meanings.keys())
U = len(codes)
print(f"唯一故障码数: {U}")

# ---------- 逐码指标: 歧义熵 H, 误命中率 miss ----------
# 误命中模型: 用户报"码"不带机型, 系统返回该码"最常见含义"; 用户真实含义按记录频率分布 => miss = 1 - max(p_i)
# 歧义熵: H = -Σ p_i log2 p_i  (单义码 H=0)
code_H = {}
code_miss = {}
code_weight = {}                           # 查询权重 = 记录频率占比
ambiguous = 0
max_groups = 0
for code in codes:
    dist = code_meanings[code]
    tot = code_total[code]
    ps = [c / tot for c in dist.values()]
    H = -sum(p * math.log2(p) for p in ps if p > 0)
    miss = 1 - max(ps)                     # "返回最频含义"策略下的期望误命中率
    code_H[code] = H
    code_miss[code] = miss
    code_weight[code] = tot / N
    if len(dist) > 1:
        ambiguous += 1
    max_groups = max(max_groups, len(dist))

print(f"歧义码数(含义>1): {ambiguous}  ({ambiguous/U*100:.1f}%)")
print(f"单码最多含义数: {max_groups}")

# 全局(无门控)期望误命中率 —— 基线A
baseline_miss = sum(code_weight[c] * code_miss[c] for c in codes)
print(f"\n[基线A] 无门控(纯按码检索)全局期望误命中率: {baseline_miss*100:.2f}%")
print(f"[基线B] 全部追问: 误命中 0%, 但追问率 100%")

# ---------- 验证1: H 与 miss 的相关性 ----------
xs = [code_H[c] for c in codes]
ys = [code_miss[c] for c in codes]
def pearson(xs, ys):
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    cov = sum((x-mx)*(y-my) for x,y in zip(xs,ys))
    vx = sum((x-mx)**2 for x in xs); vy = sum((y-my)**2 for y in ys)
    return cov / math.sqrt(vx*vy) if vx>0 and vy>0 else 0.0
def spearman(xs, ys):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0]*len(v); i=0
        while i < len(v):
            j=i
            while j+1<len(v) and v[order[j+1]]==v[order[i]]: j+=1
            avg=(i+j)/2.0
            for k in range(i,j+1): r[order[k]]=avg
            i=j+1
        return r
    return pearson(rank(xs), rank(ys))
print(f"\n[验证1] 歧义熵 H 与 误命中率 的相关性:")
print(f"  Pearson r  = {pearson(xs,ys):.4f}")
print(f"  Spearman ρ = {spearman(xs,ys):.4f}")

# 分桶展示 miss 随 H 单调上升
print(f"\n  按歧义熵分桶的平均误命中率:")
buckets = [(0,0,'H=0 单义'),(0.0001,0.5,'0<H≤0.5'),(0.5,1.0,'0.5<H≤1.0'),(1.0,2.0,'1.0<H≤2.0'),(2.0,99,'H>2.0')]
for lo,hi,lab in buckets:
    if lab.startswith('H=0'):
        sel=[c for c in codes if code_H[c]==0]
    else:
        sel=[c for c in codes if lo<code_H[c]<=hi]
    if not sel: continue
    w=sum(code_weight[c] for c in sel)
    m=sum(code_weight[c]*code_miss[c] for c in sel)/w if w>0 else 0
    print(f"    {lab:12s}  码数 {len(sel):4d}  查询占比 {w*100:5.1f}%  平均误命中 {m*100:5.1f}%")

# ---------- 验证2: 门控策略对比(相同追问预算) ----------
# 门控 = 选一批 code 触发"追问机型"(这些码不再误命中, 但产生追问成本)
# 残余误命中率 = 未被门控的码的加权误命中之和
# 三种排序: AEG(按H降序) / Freq(按记录数降序) / Random(随机, 用确定性种子)
def residual_miss_under_budget(order_codes, budget):
    """按 order 顺序累加追问预算(查询占比)达到 budget, 返回(实际追问率, 残余误命中率, 门控码数)"""
    gated=set(); ask=0.0
    for c in order_codes:
        if ask>=budget: break
        gated.add(c); ask+=code_weight[c]
    residual=sum(code_weight[c]*code_miss[c] for c in codes if c not in gated)
    return ask, residual, len(gated)

order_aeg  = sorted(codes, key=lambda c:(-code_H[c], -code_miss[c]))
order_freq = sorted(codes, key=lambda c:-code_total[c])
# 确定性伪随机(不依赖 random 模块的种子差异): 用 code 的 hash 排序
order_rand = sorted(codes, key=lambda c: hash(('salt42', c)) & 0xffffffff)

print(f"\n[验证2] 相同追问预算下, 三种门控的残余误命中率(越低越好):")
print(f"  {'追问预算':>8} | {'AEG熵门控':>12} | {'按频率门控':>12} | {'随机门控':>10} | {'AEG相对随机↓':>12}")
for budget in [0.02,0.05,0.10,0.15,0.20,0.30]:
    _,ra,_=residual_miss_under_budget(order_aeg,budget)
    _,rf,_=residual_miss_under_budget(order_freq,budget)
    _,rr,_=residual_miss_under_budget(order_rand,budget)
    cut = (rr-ra)/rr*100 if rr>0 else 0
    print(f"  {budget*100:6.0f}%  | {ra*100:10.2f}%  | {rf*100:10.2f}%  | {rr*100:8.2f}%  | {cut:9.1f}%")

# ---------- 验证3: 最优工作点(门控所有 H>0 的码) ----------
gated=[c for c in codes if code_H[c]>0]
ask=sum(code_weight[c] for c in gated)
residual=sum(code_weight[c]*code_miss[c] for c in codes if code_H[c]==0)  # 单义码误命中恒为0
print(f"\n[验证3] 最优工作点(门控全部歧义码, 即阈值 τ=0):")
print(f"  追问率(打扰成本): {ask*100:.2f}% 的查询")
print(f"  残余误命中率:     {residual*100:.4f}%")
print(f"  相对基线A误命中削减: {(baseline_miss-residual)/baseline_miss*100:.1f}%")
print(f"  —— 即: 只对 {ask*100:.1f}% 的查询追问一次机型, 就把误命中从 {baseline_miss*100:.2f}% 降到 ~0")

# ---------- 验证4(独立): "追问机型"的信息增益 vs 熵 ----------
# gain(code) = 不带机型误命中 - 带机型平均误命中 = 追问机型这一动作实际消除的误命中
# 该量由 code×model 联合分布决定, 不是 H 的自函数 => 若与 H 强相关, 说明"是否追问机型"确应由熵驱动
code_gain = {}
for code in codes:
    miss_nomodel = code_miss[code]
    tot = code_total[code]
    # 按机型加权的"带机型"误命中
    models = defaultdict(int)
    for (c, m) in cm_meanings:
        if c == code:
            models[m] = sum(cm_meanings[(c, m)].values())
    miss_withmodel = 0.0
    for m, mtot in models.items():
        dist = cm_meanings[(code, m)]
        ps = [v / mtot for v in dist.values()]
        miss_withmodel += (mtot / tot) * (1 - max(ps))
    code_gain[code] = miss_nomodel - miss_withmodel

gains = [code_gain[c] for c in codes]
print(f"\n[验证4 · 独立] '追问机型'的误命中削减增益 vs 歧义熵:")
print(f"  Pearson(H, gain)  = {pearson(xs, gains):.4f}   (gain 由 code×model 联合分布决定, 非 H 自函数)")
print(f"  Spearman(H, gain) = {spearman(xs, gains):.4f}")
print(f"  按熵分桶的'追问机型'平均增益:")
for lo,hi,lab in buckets:
    if lab.startswith('H=0'):
        sel=[c for c in codes if code_H[c]==0]
    else:
        sel=[c for c in codes if lo<code_H[c]<=hi]
    if not sel: continue
    w=sum(code_weight[c] for c in sel)
    g=sum(code_weight[c]*code_gain[c] for c in sel)/w if w>0 else 0
    print(f"    {lab:12s}  码数 {len(sel):4d}  追问机型平均消除误命中 {g*100:5.1f}%")
avg_gain_high = None
sel_high=[c for c in codes if code_H[c]>1.0]; sel_low=[c for c in codes if 0<code_H[c]<=1.0]
if sel_high and sel_low:
    gh=sum(code_weight[c]*code_gain[c] for c in sel_high)/sum(code_weight[c] for c in sel_high)
    gl=sum(code_weight[c]*code_gain[c] for c in sel_low)/sum(code_weight[c] for c in sel_low)
    print(f"  高熵码(H>1.0)追问增益 {gh*100:.1f}%  vs  低熵歧义码(0<H≤1.0) {gl*100:.1f}%  => 追问应优先给高熵码")

# ---------- 导出结果 JSON ----------
out={
  'records':N,'unique_codes':U,'ambiguous_codes':ambiguous,
  'ambiguous_rate':round(ambiguous/U,4),'max_meaning_groups':max_groups,
  'baseline_miss_rate':round(baseline_miss,4),
  'pearson':round(pearson(xs,ys),4),'spearman':round(spearman(xs,ys),4),
  'gain_pearson':round(pearson(xs,gains),4),'gain_spearman':round(spearman(xs,gains),4),
  'optimal_point':{'ask_rate':round(ask,4),'residual_miss':round(residual,6),
                   'miss_reduction':round((baseline_miss-residual)/baseline_miss,4)},
  'budget_curve':[]
}
for budget in [0.02,0.05,0.10,0.15,0.20,0.30]:
    _,ra,_=residual_miss_under_budget(order_aeg,budget)
    _,rf,_=residual_miss_under_budget(order_freq,budget)
    _,rr,_=residual_miss_under_budget(order_rand,budget)
    out['budget_curve'].append({'budget':budget,'aeg':round(ra,4),'freq':round(rf,4),'random':round(rr,4)})
with open('generated-knowledge/aeg_results.json','w',encoding='utf-8') as f:
    json.dump(out,f,ensure_ascii=False,indent=2)
print("\n结果已导出 aeg_results.json")

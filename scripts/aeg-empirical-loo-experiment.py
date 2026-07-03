#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AEG 有效性实验 —— 留一法(leave-one-out)真实实测版
把每条故障记录当作一次真实查询, 用"其余"记录预测其含义, 统计真实命中/误命中。
区分: 误命中(误答, 危险) vs 弃答(留一后无其余依据, 系统会说'资料不足', 安全)。
数据: 风机故障码/fault-index.jsonl
"""
import json, math, re
from collections import defaultdict, Counter

PATH = '风机故障码/fault-index.jsonl'
def norm(s): return re.sub(r'\s+', '', (s or '').strip())

records = []
with open(PATH, encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: r = json.loads(line)
        except Exception: continue
        code = str(r.get('code','')).strip()
        meaning = norm(r.get('name',''))
        model = norm(r.get('model',''))
        if code and meaning:
            records.append((code, model, meaning))
N = len(records)

# 每个 code / (code,model) 的含义计数
code_cnt = defaultdict(Counter)
cm_cnt   = defaultdict(Counter)
for c, m, g in records:
    code_cnt[c][g] += 1
    cm_cnt[(c, m)][g] += 1

def loo_pred(counter, true_meaning):
    """留一预测: 从 counter 扣掉一票 true_meaning 后取多数; 无其余票则返回 None(弃答)。"""
    rest = counter.copy()
    rest[true_meaning] -= 1
    if rest[true_meaning] <= 0:
        del rest[true_meaning]
    if not rest or sum(rest.values()) == 0:
        return None
    # 确定性 argmax: 票数优先, 平票按含义字符串
    return max(rest.items(), key=lambda kv: (kv[1], kv[0]))[0]

# ---- 逐记录留一实测: 无机型 / 有机型 ----
codes = list(code_cnt.keys())
# 逐码统计
code_H = {}; code_eval_nm=Counter(); code_miss_nm=Counter()
code_eval_wm=Counter(); code_miss_wm=Counter()
abstain_nm=0; abstain_wm=0; eval_nm=0; eval_wm=0; miss_nm=0; miss_wm=0

for c in codes:
    dist = code_cnt[c]; tot = sum(dist.values())
    ps = [v/tot for v in dist.values()]
    code_H[c] = -sum(p*math.log2(p) for p in ps if p>0)

for c, m, g in records:
    # 无机型
    p_nm = loo_pred(code_cnt[c], g)
    if p_nm is None:
        abstain_nm += 1
    else:
        eval_nm += 1; code_eval_nm[c]+=1
        if p_nm != g:
            miss_nm += 1; code_miss_nm[c]+=1
    # 有机型
    p_wm = loo_pred(cm_cnt[(c,m)], g)
    if p_wm is None:
        abstain_wm += 1
    else:
        eval_wm += 1; code_eval_wm[c]+=1
        if p_wm != g:
            miss_wm += 1; code_miss_wm[c]+=1

print(f"记录数 {N}  唯一码 {len(codes)}")
print(f"\n=== 留一实测(真实泛化误差) ===")
print(f"[无机型] 可预测样本 {eval_nm} ({eval_nm/N*100:.1f}%)  弃答(资料不足) {abstain_nm} ({abstain_nm/N*100:.1f}%)")
print(f"[无机型] 实测误命中率(在可预测样本中) = {miss_nm/eval_nm*100:.2f}%")
print(f"[无机型] 全样本误答率(弃答不算错)     = {miss_nm/N*100:.2f}%")
print(f"[有机型] 可预测样本 {eval_wm} ({eval_wm/N*100:.1f}%)  弃答 {abstain_wm} ({abstain_wm/N*100:.1f}%)")
print(f"[有机型] 实测误命中率(在可预测样本中) = {miss_wm/eval_wm*100:.2f}%")

baseline = miss_nm/eval_nm  # 实测基线误命中率(无门控, 无机型)

# ---- 逐码实测 miss / gain / weight ----
code_missrate = {}; code_gain = {}; code_w = {}
for c in codes:
    en = code_eval_nm[c]; ew = code_eval_wm[c]
    mn = code_miss_nm[c]/en if en>0 else 0.0
    mw = code_miss_wm[c]/ew if ew>0 else 0.0
    code_missrate[c] = mn
    code_gain[c] = mn - mw
    code_w[c] = en  # 权重 = 无机型可预测样本数
Wtot = sum(code_w.values())
for c in codes: code_w[c] /= Wtot if Wtot else 1

# ---- 相关性 ----
def pearson(xs,ys):
    n=len(xs); mx=sum(xs)/n; my=sum(ys)/n
    cov=sum((x-mx)*(y-my) for x,y in zip(xs,ys))
    vx=sum((x-mx)**2 for x in xs); vy=sum((y-my)**2 for y in ys)
    return cov/math.sqrt(vx*vy) if vx>0 and vy>0 else 0.0
def spearman(xs,ys):
    def rank(v):
        order=sorted(range(len(v)),key=lambda i:v[i]); r=[0.0]*len(v); i=0
        while i<len(v):
            j=i
            while j+1<len(v) and v[order[j+1]]==v[order[i]]: j+=1
            avg=(i+j)/2.0
            for k in range(i,j+1): r[order[k]]=avg
            i=j+1
        return r
    return pearson(rank(xs),rank(ys))

# 只在有实测样本(eval_nm>0)的码上算相关(权重>0)
codes_e = [c for c in codes if code_eval_nm[c]>0]
xs=[code_H[c] for c in codes_e]; ys=[code_missrate[c] for c in codes_e]
gs=[code_gain[c] for c in codes_e]
print(f"\n[验证1] 熵 H ↔ 实测误命中率:  Pearson {pearson(xs,ys):.4f}  Spearman {spearman(xs,ys):.4f}")
print(f"[验证4] 熵 H ↔ 实测机型澄清增益: Pearson {pearson(xs,gs):.4f}  Spearman {spearman(xs,gs):.4f}")

# 分桶
print(f"\n按熵分桶(实测):")
buckets=[('H=0',lambda h:h==0),('0<H≤1',lambda h:0<h<=1),('1<H≤2',lambda h:1<h<=2),('H>2',lambda h:h>2)]
bucket_out={}
for lab,f in buckets:
    sel=[c for c in codes_e if f(code_H[c])]
    if not sel: continue
    w=sum(code_w[c] for c in sel)
    mm=sum(code_w[c]*code_missrate[c] for c in sel)/w if w>0 else 0
    gg=sum(code_w[c]*code_gain[c] for c in sel)/w if w>0 else 0
    print(f"  {lab:8s} 码数 {len(sel):4d}  查询占比 {w*100:5.1f}%  实测误命中 {mm*100:5.1f}%  机型澄清增益 {gg*100:5.1f}%")
    bucket_out[lab]={'codes':len(sel),'weight':round(w,4),'miss':round(mm,4),'gain':round(gg,4)}

# ---- 门控 trade-off(实测 miss) ----
def residual(order,budget):
    gated=set(); ask=0.0
    for c in order:
        if ask>=budget: break
        gated.add(c); ask+=code_w[c]
    return sum(code_w[c]*code_missrate[c] for c in codes_e if c not in gated)
order_aeg =sorted(codes_e,key=lambda c:(-code_H[c],-code_missrate[c]))
order_freq=sorted(codes_e,key=lambda c:-code_eval_nm[c])
order_rand=sorted(codes_e,key=lambda c:hash(('s7',c))&0xffffffff)
print(f"\n[验证2] 相同追问预算下残余实测误命中(越低越好):")
print(f"  预算 |   AEG   | 频率  | 随机  | AEG相对随机↓")
tradeoff=[]
for b in [0.05,0.10,0.20,0.30]:
    ra,rf,rr=residual(order_aeg,b),residual(order_freq,b),residual(order_rand,b)
    cut=(rr-ra)/rr*100 if rr>0 else 0
    print(f"  {b*100:3.0f}% | {ra*100:5.2f}% | {rf*100:5.2f}% | {rr*100:5.2f}% | {cut:5.1f}%")
    tradeoff.append({'budget':b,'aeg':round(ra,4),'freq':round(rf,4),'random':round(rr,4)})

# 最优点: 门控所有 H>0 码
gated=[c for c in codes_e if code_H[c]>0]
ask=sum(code_w[c] for c in gated)
resid=sum(code_w[c]*code_missrate[c] for c in codes_e if code_H[c]==0)
print(f"\n[验证3] 门控全部歧义码: 追问率 {ask*100:.1f}%  残余实测误命中 {resid*100:.2f}%  (基线 {baseline*100:.2f}%)")

out={'records':N,'unique_codes':len(codes),
     'eval_nomodel':eval_nm,'abstain_nomodel':abstain_nm,'abstain_rate':round(abstain_nm/N,4),
     'baseline_miss_empirical':round(baseline,4),
     'miss_withmodel_empirical':round(miss_wm/eval_wm,4),
     'pearson_H_miss':round(pearson(xs,ys),4),'spearman_H_miss':round(spearman(xs,ys),4),
     'pearson_H_gain':round(pearson(xs,gs),4),'spearman_H_gain':round(spearman(xs,gs),4),
     'buckets':bucket_out,'tradeoff':tradeoff,
     'optimal':{'ask_rate':round(ask,4),'residual_miss':round(resid,4)}}
with open('generated-knowledge/aeg_empirical_results.json','w',encoding='utf-8') as f:
    json.dump(out,f,ensure_ascii=False,indent=2)
print("\n结果导出 generated-knowledge/aeg_empirical_results.json")

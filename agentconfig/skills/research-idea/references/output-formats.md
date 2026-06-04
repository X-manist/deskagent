# IFU Output Formats

## Intake Snapshot

When enough context is available, summarize assumptions before generating:

```markdown
**IFU Intake**
- Domain:
- User background/resources:
- Target contribution type:
- Target venue/level:
- Time and compute budget:
- Available data/code:
- Constraints:
- Assumptions I will use:
```

Ask concise questions only when missing information changes the idea materially:
- Which subfield or problem do you want to target?
- What data/code/compute do you already have?
- Do you prefer algorithm, system, benchmark, theory, or application paper?
- What is the rough time budget and target venue level?

## Knowledge Base Snapshot

Use this after the field-learning pass:

```markdown
**Field Knowledge Base**

**Historical Lineage**
| Era / Wave | Main Question | Representative Papers | What Became Possible | What Remained Limited |
|---|---|---|---|---|

**Classic-To-Frontier Map**
| Layer | Representative Work | Role | Key Assumption | Limitation / Open Thread |
|---|---|---|---|---|

**Artifacts**
- Benchmarks/datasets/environments:
- Tools/libraries/simulators:
- Strong baselines:
- Metrics:

**Limitation Inventory**
| Limitation | Evidence | Why It Matters | Candidate Opportunity |
|---|---|---|---|
```

Keep this compact in the final answer unless the user asks for the full knowledge base.

## Why-It-Matters And Limitation Comparison

Before `研究问题` and `以往研究局限性`, include a short `为什么值得做` block.

```markdown
**为什么值得做**
- 重要性:
- 如果不解决，会发生什么严重后果:
- 为什么现在适合做:
```

For every final idea, express `以往研究局限性` as a comparison table, not only a paragraph:

```markdown
**以往研究局限性对比表**
| 对比对象 | 已经解决了什么 | 还没有覆盖什么 | 本工作优势/改进点 | 用什么指标证明 |
|---|---|---|---|---|
| Prior work A | ... | ... | ... | ... |
| Prior work B | ... | ... | ... | ... |
```

The advantage column must name observable axes such as: logical error rate, p99/p99.9 decoding latency, memory, iteration count, calibration burden, circuit-level noise coverage, correlated-error handling, failure prediction recall, hardware cost, or reproducibility. Do not write "better" without the metric.

## Challenge, Motivation, And Possible Solution

Use this layer for every final idea.

```markdown
**研究挑战**
- 为了回答研究问题，具体难在:
- 为了克服以往局限性，具体难在:
- 最容易踩坑的评价/实现问题:

**研究动机**
- 触发这个 idea 的现象/观察:
- 这个现象说明了什么:
- 为什么它构成论文的核心 insight:

**可能的解决办法**
- 核心方案:
- 为什么它对应上面的挑战:
- 第一版最小实现:
```

Rules:
- `研究挑战` must connect backward to `研究问题` and `以往研究局限性`; avoid generic sentences like "the problem is hard".
- `研究动机` must identify a phenomenon, reason, contradiction, failure pattern, tool shift, or community trend that inspired the idea.
- `可能的解决办法` comes after `研究动机` and before `可验证成功标准`; it should be plausible and testable, not a guaranteed claim.

## Plain-Language Layer

Use this layer whenever the user asks for ideas, proposals, or reviews in a complex technical field.

```markdown
**先用人话说**
- 这个方向现在卡在哪里:
- 现有方法为什么不够:
- 这个 idea 真正要做什么:
- 第一件能动手做的实验:
- 为什么不是小修小补:
```

Style requirements:
- Put the Chinese explanation before the English term. Example: "校验结果 syndrome", not "syndrome 校验结果".
- Define acronyms on first use and say what they do in the experiment.
- Avoid stacked English nouns. If a searchable English phrase is needed, put it in parentheses after the Chinese phrase.
- Replace "提升鲁棒性/效率/泛化" with the exact stress case, metric, or code family.
- For each final topic, include one concrete failure scene and one concrete first experiment.

## Brainstorming Format

```markdown
**Raw Candidate Brainstorm**
| Candidate | Source Limitation | Brainstorm Operator | One Ping | Research Question | Refutable Success | Reality Pressure | Feasibility Hook | Main Risk |
|---|---|---|---|---|---|---|---|---|
```

Use operators such as dimension change, relaxed assumption, added domain assumption, idea fusion, new tool, adjective transformation, and SOTA pressure test.

## Debate Summary Format

```markdown
**Debate Summary**
| Candidate | Specialist Peer Critique | Broad-Field Critique | Revision | Decision |
|---|---|---|---|---|
```

Only include the full debate when it helps the user trust the selection. Otherwise summarize the decisive critique and revisions.

## Candidate Screening Format

```markdown
| Candidate | Core Scenario | New Research Question | Main Prior-Work Gap | Debate Verdict | Feasibility | IFU Score | Decision |
|---|---|---|---|---|---|---|---|
```

Use this when producing multiple options. Then deeply develop the best one.

## Final Idea Format

```markdown
**Idea Title**

**先用人话说**
- 这个 idea 解决什么:
- 现有方法卡在哪里:
- 你实际要做什么:
- 第一件实验:
- 为什么不是小修小补:

**One-Sentence Thesis**
...

**IFU Logic Chain**
| Link | Content | Evidence/Assumption |
|---|---|---|
| 研究目标 | ... | ... |
| 为什么值得做 | ... | ... |
| 研究问题 | ... | ... |
| 以往研究局限性 | ... | ... |
| 研究挑战 | ... | ... |
| 研究动机 | ... | ... |
| 可能的解决办法 | ... | ... |
| 可验证成功标准 | ... | ... |

**Literature Positioning**
| Prior Work / Group | What It Covers | Remaining Gap | How This Idea Differs |
|---|---|---|---|

**以往研究局限性对比表**
| 对比对象 | 已经解决了什么 | 还没有覆盖什么 | 本工作优势/改进点 | 用什么指标证明 |
|---|---|---|---|---|

**Debate-Informed Revision**
- Specialist critique addressed:
- Broad-field critique addressed:
- Why this survived:

**Proposed Method**
- Core mechanism:
- Why it addresses the challenge:
- Expected contribution:
- One clear ping:
- Reality pressure:

**Experiment Plan**
- Datasets/environments:
- Baselines:
- Metrics:
- Ablations:
- Stress/failure tests:
- Expected evidence:

**Evidence Ladder**
- Toy/proxy evidence:
- Prototype evidence:
- Benchmark evidence:
- Ablation/stress evidence:
- External/harder validation:

**MVP Plan**
- Week 1-2:
- Week 3-4:
- Week 5-6:
- Week 7-8:

**Risks And Kill Criteria**
- Risk:
- Mitigation:
- Kill criterion:

**Claim Boundary**
- Can claim:
- Should not claim yet:

**Next Literature Searches**
- ...
```

## Multi-Topic Final Format

When the user asks for several ideas:

```markdown
**Recommended Topics**
| Rank | Topic | Plain-Language Core | Why It Survived Debate | First Experiment |
|---:|---|---|---|---|

Then expand each topic with:
- 先用人话说
- 研究目标
- 为什么值得做
- 研究问题
- 以往研究局限性
- 以往研究局限性对比表
- 研究挑战
- 研究动机
- 可能的解决办法
- 可验证成功标准
- 可执行实验
- MVP evidence ladder
- 主要风险 / kill criteria
```

## Short Review Format

When the user asks whether an existing idea is good:

```markdown
**Verdict:** IFU-ready / promising but needs revision / not recommended

**Main Weak Link**
...

**Revised Logic Chain**
...

**What To Check In Literature**
...

**Make-It-Doable Plan**
...

**Refutable Success Criterion**
...
```

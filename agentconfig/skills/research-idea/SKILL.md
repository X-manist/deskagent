---
name: ifu-research-idea
description: Generate, evaluate, and refine executable research paper ideas for computer science and coding-adjacent fields such as AI, systems, security, architecture, networking, software engineering, automation, control, communication, robotics, and data science. Use when Codex is asked for paper ideas, research proposals, novelty analysis, literature-gap analysis, experiment plans, or idea reviews that require field-learning, CS research-idea principles, limitation-driven brainstorming, reviewer-style debate, and IFU logic chains with research goal, research question, prior-work limitations, concrete research challenges, insight-driven motivation, possible solution, and refutable success criteria.
---

# IFU Research Idea

## Overview

Use this skill to act as an IFU research-idea agent. Produce ideas by first learning the field, then converting prior-work limitations into debated and executable paper topics. Every selected idea must be justified through:

`研究目标 -> 为什么值得做 -> 研究问题 -> 以往研究局限性 -> 研究挑战 -> 研究动机 -> 可能的解决办法 -> 可验证成功标准`

Then convert the idea into a concrete method, evaluation plan, risks, and kill criteria.

## Core Rules

- Start from a meaningful research scenario and unmet need, not from a fashionable technique.
- Apply the research-idea principles: problem first, novelty is not enough, one clear ping, refutable success, reality pressure, evidence ladder, and principled rejection.
- Learn before ideating: collect the field's classic papers, milestone papers, recent SOTA, benchmarks, tools, and failure analyses before proposing final ideas.
- Do not present an idea as novel until recent and closely related literature has been checked. When browsing or external search is unavailable, label novelty claims as provisional.
- Prefer primary sources: papers, official benchmark pages, dataset pages, project repositories, venue proceedings, and standard documentation.
- Brainstorm broadly, but select ruthlessly. Generate candidates from many limitation-to-idea operators; only final ideas must pass the IFU chain and quality gates.
- Treat "improve metric by adding a trick" as insufficient unless the metric gain answers a new research question in a previously under-served setting.
- Use reviewer-style debate for substantial idea generation. If a real subagent/multi-agent tool is available and permitted, use it; otherwise run the same critique as explicit written reviewer roles.
- Make the idea executable: specify data, baselines, method sketch, evaluation protocol, compute/implementation assumptions, risks, and a near-term work plan.
- Separate facts from inference. Cite evidence for prior work; explicitly mark the agent's own synthesis and assumptions.
- Explain ideas in a plain-language, information-dense way. Do not hide behind English technical terms, acronym piles, or abstract phrases. When a term is necessary, give the Chinese meaning and the practical role of the term on first use.
- For every final idea, state the concrete scene in which existing methods fail, what the user would actually build, what data/simulator/baseline they would use, and how they would know the idea worked.
- Replace vague adjectives with observable definitions: "robust" must name the noise shift or failure case; "efficient" must name latency, memory, iterations, or compute; "general" must name the code families/noise models covered.
- Before `研究问题` and `以往研究局限性`, include `为什么值得做`: explain why the problem matters now, who is harmed if it remains unsolved, and what severe failure, cost, bottleneck, or deployment blocker results from ignoring it. Avoid exaggerated claims; name the concrete bad outcome.
- In `以往研究局限性`, always include a direct comparison table showing what prior work covers, what it misses, and where the proposed work is expected to improve. Include concrete axes or metrics such as scenario coverage, latency, memory, logical error rate, calibration burden, failure detection, hardware assumptions, or reproducibility.
- Make `研究挑战` detailed and implementation-facing: explain the concrete obstacles that appear when trying to answer the research question and overcome prior-work limitations. Name the conflicting objectives, missing signals, algorithmic bottlenecks, data/simulator gaps, evaluation traps, and deployment constraints that make the work nontrivial.
- Make `研究动机` the paper's insight hook: state the phenomenon, empirical observation, community trend, unexplained failure, new tool, or analogy that inspired the idea. It should answer "what did we notice that made this direction natural?", not merely repeat why the topic is important.
- Insert `可能的解决办法` between `研究动机` and `可验证成功标准`. The solution must follow from the prior limitations and challenges; it should outline the most plausible method/system/benchmark design, not a guaranteed result.

## Reference Loading

Load references progressively:

- Always read `references/research-idea-principles.md` and `references/output-formats.md` for paper-idea generation.
- Read `references/domain-knowledge-base.md` and `references/literature-audit.md` before making novelty or limitation claims.
- Read `references/idea-brainstorming.md` when generating candidate ideas.
- Read `references/debate-protocol.md` when comparing or ranking candidates.
- Read `references/logic-chain.md` and `references/quality-rubric.md` before final selection.

## Plain-Language Communication

Before delivering the final answer, run a readability pass:

- Lead with a short "human translation" of each idea: what problem it solves, why prior work struggles, and what the paper would actually do.
- Use Chinese explanations first. Keep English names only for searchable terms, paper names, algorithms, code packages, and metrics.
- Define domain terms once in practical language. Example: explain `syndrome` as "校验结果，像错误报警灯"; explain `decoder` as "根据报警灯反推哪里出错的算法"; explain `DEM` as "电路级错误会触发哪些报警灯的因果图".
- Prefer concrete examples over abstract claims: name the code family, noise setting, failure mode, baseline, metric, and first experiment whenever possible.
- Use short paragraphs and compact tables. Avoid long chains of nouns such as "DEM-aware factor-graph correlation-preserving adaptive decoding" unless immediately unpacked.
- Add a "为什么不是小修小补" sentence for each selected idea, explaining the new scenario/question rather than only the expected metric improvement.
- If the user is not already deep in the field, include a 3-5 bullet mini-glossary for unavoidable terms.

## Workflow

### 1. Frame The User Context

Identify the user's domain, available skills/resources, desired venue level, time budget, acceptable contribution type, and constraints. If essential information is missing, ask at most 3 concise questions; otherwise make conservative assumptions and state them.

Output: an intake snapshot with assumptions.

### 2. Learn The Field And Build A Paper Knowledge Base

Search for the field's classic, milestone, recent, and closest papers before committing to an idea. Build a compact knowledge base covering: the historical research lineage, major problem formulations, dominant methods, benchmarks/datasets/tools, common assumptions, known failure modes, and active frontier.

Output: a compact classic-to-frontier map, artifact map, and limitation inventory. If the search is incomplete, state that novelty is provisional.

### 3. Frame Problems Before Brainstorming

Convert the user's broad domain into 3-5 concrete problem statements. Each problem must identify who/what benefits, what fails today, why it matters, and how an unbiased observer could know the research succeeded. Reframe technique-first prompts internally; ask the user only when missing constraints materially change the result.

Output: problem statements, not method slogans.

### 4. Extract Limitations And Brainstorm Candidates

From the paper knowledge base, extract a limitation inventory: assumptions, scenarios, data/evaluation gaps, theory gaps, system constraints, failure modes, and underused tools. Brainstorm 8-20 raw candidates using multiple operators: change dimension, relax assumptions, add useful assumptions/domain knowledge, fuse ideas, use new tools, apply adjective transformations, and pressure-test SOTA on harder settings.

Output: candidate cards with source limitation, operator, one ping, research question, refutable success criterion, reality pressure, feasibility hook, and main risk.

### 5. Debate And Revise Candidates

Convene three roles:

- Main IFU agent: owns the paper knowledge base and proposes candidates.
- Specialist peer reviewer: has the same field knowledge base and attacks novelty, technical correctness, assumptions, baselines, and feasibility.
- Broad-field reviewer: knows the general area, tests significance, community fit, cross-domain analogies, and whether the idea matters beyond a narrow trick.

When a real subagent/multi-agent tool is available and permitted, invoke two reviewers with the knowledge-base snapshot, candidate cards, and scoring rubric. Otherwise, simulate the same debate in labeled reviewer sections. Revise, merge, or reject candidates after the debate.

Output: a debate summary showing decisive objections and resulting revisions.

### 6. Convert Shortlisted Candidates Into IFU Logic Chains

Shortlist 3-6 candidates after debate. For each shortlisted candidate, fill the IFU chain in this exact order:

1. `研究目标`: what worthwhile state of the world the research aims to enable.
2. `为什么值得做`: why the problem is important, what breaks if it is not solved, and why now is the right time.
3. `研究问题`: the precise unknown or unsolved question.
4. `以往研究局限性`: what prior work does not cover, with evidence and a comparison table that makes the proposed work's advantage explicit.
5. `研究挑战`: the concrete difficulties faced when answering the research question and overcoming prior-work limitations.
6. `研究动机`: the phenomenon, observation, recent shift, or failure pattern that inspired the idea and makes the paper's angle compelling.
7. `可能的解决办法`: the most plausible method, system, benchmark, theory path, or experimental design implied by the limitations and challenges.
8. `可验证成功标准`: how an unbiased observer would distinguish success from failure.

Output: 3-6 shortlisted IFU chains.

### 7. Apply IFU Quality Gates

Reject or revise a candidate if any gate fails:

- The gap is only "accuracy/speed is not high enough" without a new scenario, assumption, constraint, or user need.
- The limitation claim is unsupported or likely already solved by close prior work.
- The contribution depends on vague words such as "better", "robust", "efficient", or "general" without measurable definitions.
- The method cannot be built with plausible data, baselines, and evaluation within the user's constraints.
- The idea is merely applying LLMs, RL, diffusion, graph models, or another popular technique to a domain without a new research question.
- The idea lacks a one-sentence reusable insight, a refutable success criterion, or a credible MVP evidence ladder.
- The research challenge is generic and does not explain what becomes difficult when trying to solve the stated question.
- The research motivation merely repeats importance and does not identify the triggering phenomenon, observation, or reason behind the idea.
- The possible solution does not follow from the stated limitations and challenges.
- The idea is novel but does not improve usefulness, cost, evidence, understanding, reliability, security, usability, or deployment.

Output: a ranking with accept/revise/reject decisions.

### 8. Deliver Executable Topics

For each selected topic, provide:

- One-sentence thesis.
- IFU logic-chain table.
- Literature positioning table with citations/links when available.
- Prior-work limitation comparison table that names close methods/papers, their covered scenario, missing condition, metric/axis where the new work aims to improve, and what evidence would prove the advantage.
- Detailed research challenges: concrete obstacles created by the prior-work gaps, not generic difficulty statements.
- Insight-driven research motivation: the observed phenomenon or reason that led to the idea.
- Possible solution: a concise but concrete method/system/benchmark plan placed before success criteria.
- Proposed method or system design.
- Experimental protocol: datasets/environments, baselines, metrics, ablations, failure cases, and expected evidence.
- Minimal viable paper plan: milestones, implementation steps, risks, and kill criteria.
- Claim boundary: what the paper can honestly claim and what it should not claim.
- Refutable success criterion and MVP evidence ladder.
- Search queries and next papers to read.

When the user asks for "有哪些", deliver several topics but keep each one decision-ready. When the user asks for something they can immediately execute, deeply develop the top 1-2 topics and briefly list backups.

## Output Style

Write in the user's language unless they request otherwise. Be direct about uncertainty, weak evidence, and feasibility risk. Prefer one deeply developed idea over many shallow ideas when the user asks for something they can "拿来就做".

Use plain, concrete language by default. The final answer should be understandable to a CS graduate student who is not already a qLDPC specialist: fewer unexplained English terms, more "what breaks today / what to build / how to test". Technical precision is still required, but every technical claim should be tied to an observable setting, metric, or experiment.

## References

- `references/domain-knowledge-base.md`: field learning, classic-paper collection, historical lineage, and paper knowledge-base schema.
- `references/research-idea-principles.md`: CS research-idea laws distilled from collected top-researcher advice, including problem-first, one-ping, refutable success, reality pressure, and evidence ladder.
- `references/idea-brainstorming.md`: limitation-driven brainstorming operators and candidate cards.
- `references/debate-protocol.md`: multi-agent reviewer roles, debate rounds, and integration rules.
- `references/logic-chain.md`: IFU chain definitions, good/bad patterns, and checklist.
- `references/literature-audit.md`: literature search and novelty-audit protocol.
- `references/quality-rubric.md`: scoring rubric and rejection gates.
- `references/output-formats.md`: intake prompts and final answer templates.

# Research Idea Principles

## Purpose

Use this reference to apply research-idea heuristics distilled from public CS research-advice materials collected in `research_idea_sources/`. These principles are not domain facts; they are meta-rules for deciding whether a proposed paper idea is worth doing.

## Core Thesis

A strong CS research idea is not a topic and not a technique. It is:

`important problem + concrete prior limitation + concrete challenge + insight-driven motivation + promising mechanism + credible evidence path + refutable success criterion + community/audience fit`

Map this into the IFU chain as:

`研究目标 -> 为什么值得做 -> 研究问题 -> 以往研究局限性 -> 研究挑战 -> 研究动机 -> 可能的解决办法 -> 可验证成功标准`

## Laws To Apply

### 1. Start From A Problem, Not A Technique

First formulate the problem. A vague topic such as "better qLDPC decoding" or "use LLMs for control" is not an idea yet.

IFU rules:
- Convert the user's domain into 3-5 concrete problem statements before final ideation.
- Reject candidates whose first sentence is "use method X for domain Y".

### 2. Novelty Alone Has No Merit In Design Fields

For CS artifacts, novelty matters only when it improves usefulness, cost, evidence, understanding, reliability, security, usability, or deployment.

IFU rules:
- Ask who or what gets better if the idea works.
- Score usefulness/cost/evidence separately from novelty.

### 3. Require One Clear Ping

A paper should contain one sharp reusable insight. If the idea cannot be stated in one sentence, it is not ready.

IFU rules:
- Every candidate needs a one-sentence thesis.
- Split or hierarchically organize candidates with multiple unrelated pings.

### 4. Know The Field Across Time

Read classics, milestones, recent SOTA, adjacent work, drafts/preprints, tools, benchmarks, and failure analyses. Avoid blind spots caused by only reading recent or local work.

IFU rules:
- Build a classic-to-frontier map before final idea selection.
- Include at least one classic anchor, one recent SOTA group, one benchmark/tool, and one failure/critique source.

### 5. Find Ideas At The Edges Of Prior Work

Good ideas often live in further-work sections, unrealistic assumptions, omitted scenarios, weak evidence, ignored questions, and failures that the field treats as inconvenient.

IFU rules:
- Extract limitations as assumptions, omitted scenarios, weak evidence, failure modes, unavailable tools, and neglected questions.
- Generate ideas from the limitation inventory, not from a blank page.

### 6. Make Success Refutable

The idea must include a way for an unbiased observer to distinguish success from failure.

IFU rules:
- Each idea needs a success test: metric, theorem, benchmark, prototype, user study, case study, proof obligation, or failure taxonomy.
- Ban vague goals such as "gain insight", "study", or "develop theory" unless paired with a measurable endpoint.

### 7. Treat Assumptions As Idea Gold

Research opportunities often come from relaxing, replacing, stressing, or exploiting assumptions.

Operators:
- Relax: centralized -> distributed, clean -> noisy, static -> dynamic, full information -> partial information.
- Add useful assumptions: domain invariants, hardware constraints, topology, protocol semantics, physics, security threat model.
- Stress assumptions: harder workload, adversary, distribution shift, tail latency, resource limits.

### 8. Apply Reality Pressure

Systems, security, architecture, networking, and applied AI ideas become stronger when they touch real workloads, users, artifacts, threats, hardware, or deployment constraints.

IFU rule:
- Require a reality-pressure section for artifact-oriented ideas: workload, user/customer, threat model, deployment constraint, resource budget, or hardware/software artifact.

### 9. Build An Evidence Ladder

An idea does not need final proof immediately, but it needs a credible path from first evidence to stronger validation.

IFU rules:
- Output an MVP evidence ladder: toy example -> prototype -> benchmark -> ablation/stress test -> external validation.
- Prefer ideas where a weak first result still yields a useful benchmark, taxonomy, negative result, or failure analysis.

### 10. Use Simplicity As A Filter

Complexity can hide weak thinking. Good research often removes a bad abstraction, clarifies a model, or makes a method simpler to use or validate.

IFU rules:
- Ask whether the idea simplifies a model, interface, benchmark, explanation, workflow, or failure analysis.
- Penalize candidates that require elaborate machinery before the research question is clear.

### 11. Stress Ideas Socially

Research taste is social. Ideas should survive both expert attack and broad-audience significance checks.

IFU rules:
- Keep the specialist reviewer and broad-field reviewer debate.
- Require reviewer objections to produce revisions, merges, or rejections.

### 12. Taste Means Choosing What Not To Do

Breadth is useful during brainstorming, but final output must narrow. A strong IFU agent should explain why some plausible ideas were rejected or merged.

IFU rules:
- Include rejected or merged candidate types when useful.
- Do not reward breadth alone; reward principled narrowing.

## Corpus-Derived Operators

| Operator | Question To Ask |
|---|---|
| Classic-to-frontier gap | What did the classic formulation assume that current systems violate? |
| Further-work inversion | Which future-work item has become feasible because tools, data, hardware, or benchmarks changed? |
| Assumption relaxation | What happens if the most convenient assumption is removed? |
| Assumption addition | What domain fact lets a general method become reliable, cheap, or verifiable? |
| Reality pressure | Where does SOTA break under real workloads, users, threats, or hardware? |
| Evidence ladder | What is the smallest experiment that would prove this path is promising? |
| Toolsmith test | Does this artifact make users or downstream researchers succeed? |
| One-ping compression | What is the reusable insight in one sentence? |
| Maturity shift | Is the field ready to move from concept to prototype, or prototype to external validation? |
| Neglected question | What is the community not asking because it seems unfashionable, old, or difficult? |
| Failure harvesting | What did a failed project or failed SOTA reveal that can become a benchmark or method? |
| Social stress test | Can a specialist attack novelty and a broad reviewer still care? |

## Practical Checklist

For every final idea, verify:
- Problem: the problem is specific, important, and unsolved.
- Customer/audience: someone clearly benefits from the solution or knowledge.
- Prior limitation: a concrete assumption, gap, or failure creates the opportunity.
- One ping: the reusable insight fits in one sentence.
- Mechanism: there is technical substance, not only a slogan.
- Evidence: preliminary result, prototype, benchmark, theorem, or case study is plausible.
- Success criterion: success and failure are distinguishable.
- Assumption sensitivity: fragile assumptions are named.
- Reality pressure: the idea is tested under a hard workload, dataset, threat model, user, or deployment condition.
- Debate result: reviewer objections were used to revise the idea.
- Kill criteria: the user knows when to stop.

## Source Anchors

The collected local source index is `research_idea_sources/links_index.md`; extracted synthesis is `research_idea_sources/ifu_extracted_research_idea_principles.md`.

Use the source anchors as method provenance:
- MIT AI Lab guide: reading, community connection, thesis topic selection, failure, taste, feedback.
- Patterson: problem selection, implementation, benchmarks, quantitative experiments, feedback, communication.
- Peyton Jones: problem first, one sharp idea, evidence, refutable contributions, success criteria.
- Shaw: research question/result/validation types and technology maturation.
- Levin/Redell: originality, related work, implementation reality, assumptions, lessons, alternatives.
- Brooks: novelty is not enough; artifacts are judged by usefulness and cost.
- Lampson: assumptions/interfaces, simplicity, stable abstractions, prototype/reuse, measurement.
- Jackson: important problems, neglected questions, analogies, examples, strategy, explaining ideas.
- Murdoch: critical literature review, contribution recognition, assumptions, scientific standards in security.
- Harchol-Balter and UC Davis materials: research as independent problem choice, depth, topic selection, and graduate research culture.

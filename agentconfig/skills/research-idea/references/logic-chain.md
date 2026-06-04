# IFU Logic Chain

## Purpose

The IFU chain forces a paper idea to be justified before the method is proposed. A strong idea should read as: because the field wants goal G and leaving the problem unsolved causes concrete harm H, it must answer question Q; prior work cannot answer Q under condition C; C creates challenge T; phenomenon P suggests a promising angle; solution path M follows from the challenge; success is measurable by criterion S.

## Chain Elements

### 研究目标

Define the useful capability, scientific understanding, or system property the work aims to enable. It should be broader than one metric and grounded in a real research or application setting.

Good:
- Enable reliable multi-agent planning under partial observability and limited communication.
- Make neural control policies certifiable under actuator saturation and sensor delay.

Weak:
- Improve accuracy on dataset X.
- Apply method Y to domain Z.

### 为什么值得做

Explain why the problem is important before stating the technical research question. This section should answer:
- Who or what is blocked today?
- What severe failure, cost, bottleneck, or deployment risk appears if the problem is ignored?
- Why is now the right time to study it?

Good:
- If real-time decoding misses the control-cycle deadline, a quantum memory can accumulate uncorrected errors even when the offline decoder looks accurate.
- If a decoder cannot identify high-risk syndromes, rare failures can silently become logical errors, which is worse than a visible timeout.
- If benchmarks ignore circuit-level correlated faults, a decoder may look strong in simulation but fail on hardware-like noise.

Weak:
- This problem is important.
- It improves performance.
- More robust decoding is useful.

### 研究问题

State the precise question the paper will answer. It should be narrow enough to test, but important enough to matter.

Good forms:
- Under what conditions does method family A fail when assumption B is violated?
- How can a model/system achieve property P when constraint C prevents standard solution S?
- Can signal X be used to detect/fix failure mode F before it causes outcome O?

### 以往研究局限性

Name what prior work actually assumes, omits, optimizes, or cannot evaluate. Tie each limitation to citations or clearly identified paper groups.

For final answers, include a comparison table:

| 对比对象 | 已经解决了什么 | 还没有覆盖什么 | 本工作优势/改进点 | 用什么指标证明 |
|---|---|---|---|---|

The table should make the proposed work's advantage visible. The advantage must be tied to observable axes such as latency, memory, logical error rate, calibration burden, code-family coverage, correlated-noise coverage, failure prediction recall, or reproducibility.

Valid limitation types:
- Scenario gap: previous work ignores an important deployment condition.
- Assumption gap: previous work relies on unrealistic labels, sensors, compute, synchrony, stationarity, or oracle access.
- Evaluation gap: previous work lacks stress tests, causal evidence, human studies, safety analysis, or cross-domain validation.
- Mechanism gap: previous work works empirically but does not explain when/why it fails.
- System gap: previous work cannot be deployed because latency, memory, privacy, calibration, or integration constraints are unresolved.

Invalid limitation types:
- "No one has used technique X here" unless technique X enables a new question.
- "Performance is not high enough" without diagnosing which condition causes failure.
- "Existing methods are not robust" without defining robustness and threat/scenario.

### 研究挑战

Explain why the limitation is hard to fix. The challenge should create intellectual substance for a paper and must be specific to the stated research question.

A strong challenge section explains:
- What becomes technically hard when answering the research question.
- What becomes hard specifically because prior work omitted a scenario, assumption, metric, or system constraint.
- What conflict or bottleneck the method must resolve, such as accuracy vs. latency, locality vs. global consistency, calibration vs. deployment, or benchmark realism vs. reproducibility.
- What evaluation trap could make the result misleading.

Challenge categories:
- Conflicting objectives, such as accuracy vs. latency, privacy vs. personalization, stability vs. adaptivity.
- Missing or noisy supervision.
- Distribution shift, non-stationarity, rare events, adversarial behavior, or partial observability.
- Scale, real-time constraints, limited compute, or communication constraints.
- Evaluation difficulty: no benchmark, hidden confounders, weak ground truth, or expensive deployment.
- Theoretical difficulty: identifiability, guarantees, convergence, stability, or sample complexity.

### 研究动机

Explain the phenomenon, observation, reason, or recent shift that inspired the idea. This is the paper's insight hook, not a second copy of "why it matters".

Good motivation answers:
- What did we notice in prior results, benchmarks, failures, or new tools?
- What contradiction or unexplained gap does that observation reveal?
- Why does that observation naturally suggest this research direction?
- Why is now a good time to study this?

Weak:
- This is important for quantum computing.
- Existing methods are insufficient.
- Better robustness is needed.

### 可能的解决办法

Give the most plausible solution path after the motivation and before success criteria. This is not a marketing claim; it is the concrete method, system design, benchmark construction, theory path, or experimental protocol that follows from the limitations and challenges.

Good:
- Build a two-stage decoder service: a cheap syndrome-risk predictor routes easy cases to Relay-BP and risky cases to BP+LSD/OSD fallback.
- Convert detector error models into a smaller correlation-aware decoding graph by preserving only high-impact correlated faults, then ablate which correlations matter.
- Use online Bayesian/EM estimation over recent syndrome windows to update decoder edge weights under spatial noise drift.

Weak:
- Use machine learning.
- Improve the decoder.
- Design a better benchmark.

### 可验证成功标准

Define how an unbiased observer would know whether the research succeeded. This is required because vague work cannot be converted into an executable paper plan.

Valid success criteria:
- A metric threshold or Pareto improvement under a specified benchmark/workload.
- A reproduced failure taxonomy plus a method that reduces a target failure class.
- A prototype that handles a defined workload, latency, resource, safety, or correctness constraint.
- A theorem, proof obligation, or counterexample under stated assumptions.
- A user study, case study, or deployment measurement with predefined endpoints.

Weak:
- "Gain insight into..."
- "Study the theory of..."
- "Improve robustness" without a threat model, shift definition, or failure criterion.
- "Build a dataset" without a research question the dataset unlocks.

## Chain Quality Checklist

Before finalizing an idea, verify:
- The goal is not just "improve a metric".
- The chain explains why the problem is worth doing and what serious bad outcome occurs if it is ignored.
- The question can be answered by experiments, theory, user study, system measurement, or benchmark construction.
- The limitation is tied to specific prior-work assumptions or evidence and includes a direct comparison table.
- The challenge explains concrete obstacles created by the research question and prior-work limitations, not just importance.
- The motivation names the observed phenomenon, contradiction, recent shift, or failure pattern that inspired the idea.
- The possible solution follows from the limitations and challenges and is testable.
- The success criterion makes failure possible and observable.
- There is one clear reusable insight, not a pile of unrelated tricks.
- The proposed method follows from the challenge rather than appearing first.

## Anti-Patterns

- Solution-first idea: "Use LLM/RL/GNN/diffusion to solve X" before defining a research question.
- Dataset-first idea: "Train on dataset X" without a new gap.
- Benchmark-only idea: "Create a benchmark" without explaining which scientific question the benchmark unlocks.
- Metric-only idea: "Improve accuracy/speed" without a deployment or scientific reason.
- Generic-challenge idea: "This is difficult because quantum systems are complex" without naming the actual obstacle.
- Motivation-as-importance: repeating "this matters" without the observation or insight that triggered the idea.
- Detached solution: a method that appears suddenly and does not follow from prior-work gaps and challenges.
- Survey-disguised idea: "Analyze existing methods" without a falsifiable research claim.
- Non-refutable idea: "Explore/study/gain insight" without a defined success test.

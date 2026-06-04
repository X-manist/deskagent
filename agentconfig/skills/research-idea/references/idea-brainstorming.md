# Limitation-Driven Brainstorming

## Purpose

Use brainstorming to expand the search space before filtering. Each idea must start from a limitation in the knowledge base, not from an isolated technique. Generate many raw candidates, then let the debate and rubric kill weak ones.

## Candidate Card

Use one card per raw idea:

| Field | Content |
|---|---|
| Source Limitation | Which paper/group/assumption/failure mode creates the opportunity? |
| Brainstorm Operator | Which operator produced this candidate? |
| New Dimension / Assumption / Tool | What changes from prior work? |
| Research Question | What can be tested or proven? |
| One Ping | What is the single reusable insight? |
| Refutable Success Criterion | How would an unbiased observer know it worked? |
| Why Non-Incremental | Why this is more than a metric trick? |
| Reality Pressure | What hard workload, user, threat model, artifact, or deployment constraint tests it? |
| Feasibility Hook | What data, simulator, benchmark, code, or baseline makes it startable? |
| Main Risk | What could make the idea collapse? |

## Operators

Apply these operators together with the corpus-derived operators in `research-idea-principles.md`: classic-to-frontier gap, further-work inversion, reality pressure, evidence ladder, toolsmith test, one-ping compression, maturity shift, neglected question, failure harvesting, and social stress test.

### 1. Change Dimension

Ask whether a good idea in one dimension becomes new in another dimension.

Examples:
- Modality: text, audio, image, video, graph, time series, event stream, point cloud, code, tabular data.
- System dimension: offline, online, real-time, distributed, federated, edge, cloud, embedded, hardware-aware.
- Scientific dimension: empirical, theoretical, causal, safety, interpretability, benchmark, human-in-the-loop.
- Environment dimension: simulation, real world, adversarial, non-stationary, low-resource, high-noise, multi-agent.

Prompt:
- "This prior idea works for dimension X. What breaks in dimension Y?"
- "Does the field only test one modality/noise model/dataset/deployment setting?"

### 2. Relax Assumptions

Find a strong assumption and loosen it.

Common transformations:
- linear -> nonlinear
- convex -> nonconvex
- i.i.d. -> distribution shift / non-stationary
- centralized -> distributed / decentralized
- full observation -> partial observation
- synchronized -> asynchronous
- clean labels -> noisy / weak / missing labels
- known model -> unknown / learned / misspecified model
- unlimited compute -> bounded latency / memory / energy
- static graph -> dynamic graph
- single agent -> multi-agent

Good relaxed-assumption ideas explain why the relaxed setting matters and why existing methods fail there.

### 3. Add Useful Assumptions

Sometimes the best idea is not more general. Add domain-specific assumptions to make a general method stronger, safer, or more efficient.

Examples:
- Add physics, topology, invariants, protocol structure, conservation laws, causal structure, hardware constraints, domain ontology, expert rules, or safety constraints.
- Adapt a general foundation model, optimizer, controller, decoder, planner, or verification tool using domain knowledge.

Prompt:
- "What does this domain know that a generic method ignores?"
- "Can a domain constraint make the method faster, more reliable, or easier to verify?"

### 4. Fuse Ideas

Combine two or more good ideas whose limitations are complementary. The goal is not novelty by collage; the fusion must answer a new question.

Useful fusion patterns:
- Strong but slow method + fast but weak method -> cascade, verifier, fallback, or anytime system.
- General method + domain-specific prior -> robust specialized method.
- Benchmark/failure taxonomy + algorithm -> method that targets documented failures.
- Theoretical guarantee + practical heuristic -> reliable implementation.
- Offline learner + online adaptation -> progressive deployment.

Prompt:
- "One idea solves accuracy, another solves latency. Can their interface become the contribution?"
- "Can a failure analysis paper and a new tool together create a method paper?"

### 5. Use New Tools: Powerful Hammer, Real Nails

Actively scan for new tools, libraries, datasets, simulators, hardware, or research paradigms that make old problems newly tractable.

Examples:
- LLM/agent systems, foundation models, differentiable simulators, graph compilers, formal verification, efficient kernels, new sensors, new benchmark suites, synthetic data engines, causal discovery, privacy tooling, automated theorem/proof assistants.

Guardrail:
- Do not propose "use new tool T" unless there is a real nail: a documented limitation that T can plausibly solve.

### 6. Add An Adjective

Take an existing idea and add a meaningful adjective that creates a research question:

- slow -> fast
- sensitive -> robust
- centralized -> distributed
- single-step -> progressive
- single-level -> hierarchical
- fixed -> adaptive / dynamic
- data-hungry -> data-efficient
- opaque -> interpretable
- offline -> online
- average-case -> worst-case / tail-aware
- manual -> automated
- simulation-only -> real-world validated
- monolithic -> modular
- deterministic -> uncertainty-aware

The adjective must be measurable through metrics or tests.

### 7. Pressure-Test SOTA

Do not only test SOTA on easy or standard datasets. Stress it until it fails, then turn the failure into a research gap.

Stress dimensions:
- harder/more diverse datasets
- distribution shift and long-tail cases
- adversarial or rare events
- missing/noisy supervision
- low-resource settings
- real-time/tail-latency constraints
- cross-domain or cross-scale generalization
- ablations that remove hidden crutches
- safety, calibration, privacy, or interpretability tests

Output:
- Failure taxonomy
- Reproducible hard-case benchmark
- Method that targets the highest-value failure mode

## Brainstorming Rule

Generate raw candidates first, then filter. A candidate that is weird but anchored in a real limitation is worth keeping for debate; a candidate that sounds polished but lacks a limitation is not.

# Domain Knowledge Base

## Purpose

Before generating ideas, construct a compact professional knowledge base for the requested field. The goal is not to summarize everything; it is to understand the field's historical logic well enough to see which limitations are real and which ideas would be incremental.

## Search Layers

Collect papers and resources in this order:

1. **Foundational classics**: papers that define the problem, model, benchmark, code family, architecture, or theoretical result.
2. **Milestone papers**: works that changed what the community considered possible, practical, or important.
3. **Survey/tutorial/benchmark papers**: sources that organize the field and expose common assumptions.
4. **Recent SOTA**: papers from the latest 2-3 years, including strong preprints in fast fields.
5. **Failure-analysis papers**: work on limitations, negative results, robustness, stress tests, theory gaps, reproducibility, and deployment issues.
6. **Tools and artifacts**: datasets, simulators, libraries, leaderboards, official benchmark suites, hardware/software stacks, and reproducibility repositories.

If search time is limited, collect fewer papers but preserve diversity across these layers. Always label the knowledge base as provisional when the search is incomplete.

## Paper Knowledge Base Schema

Use this table while reading:

| Paper / Resource | Year | Role In Field | Problem Formulation | Core Method / Result | Assumptions | Evaluation / Evidence | Known Limitations | Open Threads |
|---|---:|---|---|---|---|---|---|---|

Field-specific notes:
- **Role In Field**: classic, milestone, survey, SOTA, benchmark, failure analysis, tool, or adjacent-domain import.
- **Assumptions**: data, noise, supervision, observability, compute, architecture, protocol, environment, theory, or deployment assumptions.
- **Known Limitations**: use only limitations supported by the paper itself, later work, or careful inference marked as inference.
- **Open Threads**: concrete unresolved questions that can seed IFU candidates.

## Historical Lineage Map

Summarize the field as eras or waves:

| Era / Wave | Main Question | Representative Papers | What Became Possible | What Remained Limited | Next Frontier |
|---|---|---|---|---|---|

The map should explain why the field moved from one wave to the next. Look for recurring patterns: a method solved one bottleneck but introduced a new assumption, cost, failure mode, or evaluation blind spot.

## Concept And Artifact Map

Capture the objects a newcomer must know:

- Key tasks/problems:
- Dominant methods:
- Theoretical tools:
- Benchmarks/datasets/environments:
- Evaluation metrics:
- Strong baselines:
- Common implementation stacks:
- Community pain points:

## Limitation Inventory

After the knowledge base is built, extract limitations by category:

| Limitation Type | Concrete Limitation | Evidence Source | Affected Methods | Why It Matters | Candidate Opportunity |
|---|---|---|---|---|---|

Categories to inspect:
- Assumption limitations: linear vs nonlinear, i.i.d. vs shifted, static vs dynamic, centralized vs distributed, full observation vs partial observation, clean labels vs noisy labels, infinite compute vs resource-limited.
- Scenario limitations: toy setup, small scale, simulation-only, single modality, single language/domain/hardware/noise model.
- Evaluation limitations: easy datasets, weak baselines, missing ablations, no stress tests, no tail metrics, no failure taxonomy.
- Method limitations: brittle optimization, poor calibration, unmodeled dependencies, no guarantees, high latency/memory, poor interpretability.
- Data limitations: data hunger, annotation cost, privacy, scarcity, imbalance, synthetic-real gap.
- Deployment limitations: real-time constraints, communication limits, energy, safety, privacy, standards, hardware constraints.

## Minimum Useful Knowledge Base

Before final idea selection, the agent should know:

- 5-10 representative classic/milestone/survey papers or paper groups.
- 5-10 recent closest/SOTA papers or paper groups.
- At least 3 strong baselines and 2 evaluation artifacts.
- At least 5 concrete limitations with evidence.
- At least 2 community trends or new tools that could change what is feasible.

For narrow or emerging fields, fewer papers may exist; compensate with adjacent fields and clearly mark the evidence boundary.

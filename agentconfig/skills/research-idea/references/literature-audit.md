# Literature Audit Protocol

## Search Goal

Do enough evidence gathering to avoid obvious duplication and to ground every limitation claim. For concrete paper ideas, current literature matters; use web search or scholarly search when available. If search is unavailable or the user forbids it, state that novelty is provisional and list the searches that should be run next.

This audit has two passes:

1. **Field-learning pass**: identify classics, milestones, surveys, SOTA, benchmarks, tools, and failure analyses so the agent understands the field's historical trajectory.
2. **Idea-specific pass**: after brainstorming, check the closest prior work for each shortlisted candidate and refine or reject weak novelty claims.

## Source Priority

Prefer:
- Top conference/journal papers in the target field.
- Recent papers from the last 2-3 years, including accepted papers and strong preprints.
- Surveys, benchmarks, leaderboards, and official dataset pages.
- Repositories or project pages for reproducibility details.
- Standards or official documentation for systems, networking, control, and communication domains.

Use general blog posts only for background, not as proof of novelty.

## Search Procedure

1. Extract keywords from the user's domain, task, constraints, and proposed scenario.
2. Search broad terms first: problem + field + "survey", "benchmark", "tutorial", "limitations", "challenge".
3. Search classic and milestone terms: "foundational", "seminal", "first", "landscape", "taxonomy", "history", "benchmark".
4. Search close variants: synonyms, adjacent tasks, alternate benchmarks, and method families.
5. Search negative evidence: "failure", "robustness", "out-of-distribution", "partial observability", "real-time", "privacy", "safety", "latency", "resource-constrained", "ablation".
6. Search artifacts: "dataset", "simulator", "library", "leaderboard", "code", "github", "benchmark suite".
7. For each promising paper, inspect related work and citations if possible.
8. Build a novelty matrix before generating final claims.

## Novelty Matrix

Use this compact table while auditing:

| Paper/Group | What It Solves | Assumptions | Evidence/Evaluation | Limitation Relevant To IFU Idea | Why Not Enough |
|---|---|---|---|---|---|

Group closely similar papers instead of listing every paper when space is limited. The final answer should cite enough representative papers for the user to verify the gap.

## Classic-To-Frontier Matrix

Use this table during the field-learning pass:

| Layer | Paper / Resource | Why It Matters | What It Made Possible | What It Left Open |
|---|---|---|---|---|
| Classic | ... | ... | ... | ... |
| Milestone | ... | ... | ... | ... |
| Survey / Benchmark | ... | ... | ... | ... |
| Recent SOTA | ... | ... | ... | ... |
| Failure Analysis | ... | ... | ... | ... |
| Tool / Artifact | ... | ... | ... | ... |

## Search Query Patterns

Use combinations such as:
- `<task> <constraint> survey`
- `<field> seminal paper`
- `<field> benchmark dataset simulator library`
- `<task> <failure mode> benchmark`
- `<method family> <domain> limitation`
- `<domain> real-time privacy robust evaluation`
- `<problem> "partial observability" "communication constraints"`
- `<benchmark/dataset> <task> state of the art`
- `<target venue> <task> <last 2 years>`

## Evidence Rules

- Do not claim "no prior work" unless the search was broad and recent; prefer "I did not find close work that covers..."
- Distinguish direct evidence from inference.
- If close prior work exists, either narrow the scenario, strengthen the challenge, or abandon the idea.
- Record at least one plausible competing framing. If the idea still holds against that competitor, it is stronger.

## Recency Expectations

For active fields such as LLMs, agents, diffusion models, graph learning, federated learning, robotics, software engineering AI, and communication/networking with ML, include recent sources from the current and previous calendar year when possible.

For slower-moving or theoretical areas, recent work still matters, but seminal papers and standard benchmarks may carry more weight.

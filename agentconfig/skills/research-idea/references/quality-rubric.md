# IFU Quality Rubric

Score each candidate from 1 to 5 on each dimension. Prefer revising one promising candidate over presenting many weak candidates.

## Dimensions

### Domain Grounding

1: Idea is generated from surface keywords with little field history.
3: Includes relevant recent papers but misses classics, benchmarks, or field trajectory.
5: Shows clear understanding of classics, milestones, SOTA, tools, benchmarks, and why the field moved between research waves.

### Novelty

1: Likely duplicate or obvious technique transfer.
3: New combination or scenario, but boundary against prior work is thin.
5: Clear unsolved scenario/question with well-supported difference from close prior work.

### Significance

1: Solves a toy problem or a metric-only inconvenience.
3: Useful for a subcommunity or benchmark.
5: Opens a meaningful research direction, deployment capability, or scientific understanding, and clearly states what severe failure, cost, bottleneck, or deployment blocker appears if the problem remains unsolved.

### Problem Formulation

1: Starts from a technique, topic, or buzzword without a precise problem.
3: Problem is understandable but broad, with weak success criteria.
5: Problem is specific, important, unsolved, and tied to a clear beneficiary/audience and refutable success test.

### Chain Coherence

1: Goal, question, limitation, challenge, and motivation are disconnected.
3: Mostly coherent but one link is generic or underspecified.
5: Each link naturally forces the next; the challenge is concrete, the motivation names the triggering observation, and the possible solution follows from the challenge.

### Feasibility

1: Requires unavailable data, unrealistic compute, or vague implementation.
3: Feasible with assumptions, but risky data/evaluation dependency remains.
5: User can start immediately with available data, baselines, and a 4-8 week MVP path.

### Evidence Strength

1: No citations or only generic background.
3: Several relevant papers, but closest competitors are not fully addressed.
5: Strong literature map with a direct limitation comparison table against close prior work, including the metric or axis where the proposed work should improve.

### Execution Readiness

1: No baseline, metric, dataset, or experiment plan.
3: Basic plan exists but missing ablations, failure analysis, or kill criteria.
5: Clear possible solution, datasets/environments, baselines, metrics, ablations, risks, and milestones.

### Evidence Ladder

1: No credible path from first experiment to convincing evidence.
3: MVP is plausible but later validation is vague.
5: Clear path from toy/prototype to benchmark, ablation/stress test, and external or harder validation.

### Debate Robustness

1: No serious counterargument or reviewer challenge.
3: Some risks are listed, but the idea has not survived close-prior-work or significance critique.
5: Specialist and broad-field critiques were addressed through revision, narrowing, merging, or rejection.

## Acceptance Rule

For an IFU-ready idea:
- Domain Grounding >= 4
- Novelty >= 4
- Significance >= 4
- Problem Formulation >= 4
- Chain Coherence >= 4
- Feasibility >= 3
- Evidence Strength >= 3
- Execution Readiness >= 4
- Evidence Ladder >= 4
- Debate Robustness >= 4

If any required score fails, revise or present the idea as "promising but not IFU-ready".

## Red Flags

- Contribution is "add module A to model B" with no new question.
- Evaluation is only one dataset and one aggregate metric.
- The idea requires collecting a large private dataset without a fallback.
- The user cannot implement the method or baselines with available time/compute.
- Prior-work limitation is based on weak memory rather than search evidence.
- The paper title sounds plausible, but the experiment cannot falsify the claim.
- The answer says a problem is "important" but does not say what breaks, who is blocked, or what severe cost appears if the problem is ignored.
- Prior-work limitations are only listed as prose and do not include a table comparing close work against the proposed advantage and proof metric.
- The research challenge is a generic difficulty statement and does not say what becomes hard when trying to overcome the listed limitations.
- The research motivation does not identify the phenomenon, failure pattern, contradiction, new tool, or field shift that inspired the idea.
- The possible solution is a detached technique choice rather than a direct response to the challenge.
- The idea is novel but has no clear user, community, artifact, scientific, or deployment payoff.
- The candidate has multiple unrelated "pings" and cannot be compressed into one reusable insight.
- The idea appears before the knowledge base is built.
- Reviewer critique is listed but not used to revise the candidate.

## Kill Criteria

Define kill criteria early so the user avoids wasting months:
- A close paper already solves the same question under the same assumptions.
- Required dataset or simulator cannot be obtained or built quickly.
- Baseline reproduction is impossible and no acceptable proxy exists.
- The proposed method cannot beat or explain a simple baseline.
- The main claim cannot be measured with credible metrics.

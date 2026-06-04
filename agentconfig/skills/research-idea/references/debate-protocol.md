# Multi-Agent Debate Protocol

## Purpose

Use debate to prevent the main agent from falling in love with plausible but weak ideas. The debate should stress novelty, significance, feasibility, and execution readiness before final topics are selected.

## Roles

### Main IFU Agent

Responsibilities:
- Build and maintain the paper knowledge base.
- Generate raw candidates from limitation-driven brainstorming.
- Integrate critique into revised topics.
- Make the final decision and clearly state uncertainty.

### Specialist Peer Reviewer

Profile:
- Same field knowledge level as the main agent.
- Has read the knowledge-base snapshot and representative papers.

Responsibilities:
- Attack novelty against close prior work.
- Identify missing baselines, datasets, assumptions, and technical blockers.
- Ask whether the research question is actually answerable.
- Suggest sharper variants or merges.

### Broad-Field Reviewer

Profile:
- General strong model / big同行.
- Understands the broad area but is not assumed to know every niche paper.

Responsibilities:
- Judge whether the topic matters to the broader community.
- Detect overfitting to a tiny niche or benchmark.
- Suggest cross-domain analogies, useful tools, and simpler baselines.
- Challenge the motivation and "why now" story.

## Using Real Subagents

When real subagents are available and allowed by the active tool policy, spawn two reviewers:

- Specialist peer reviewer prompt should include the domain, user constraints, knowledge-base snapshot, raw candidate cards, and quality rubric. Ask for critique, missing literature, ranking, and revisions.
- Broad-field reviewer prompt should include the domain summary, candidate cards, target contribution type, and evaluation criteria. Ask for big-picture significance, cross-domain analogies, and publication-fit critique.

Do not leak a desired winner. Do not ask reviewers merely to agree. Keep reviewer prompts self-contained and focused.

If real subagents are unavailable or not permitted, simulate the same two roles in writing. Label the sections clearly as `Specialist Peer Review` and `Broad-Field Review`.

## Debate Rounds

### Round 1: Candidate Presentation

Main agent presents 6-12 candidate cards with their source limitations and feasibility hooks.

### Round 2: Specialist Attack

Specialist peer reviewer answers:
- Which candidates are likely already solved?
- Which limitation claims need stronger evidence?
- Which baselines or datasets are missing?
- Which candidates are technically infeasible?
- Which 2-4 candidates deserve revision rather than rejection?

### Round 3: Broad-Field Attack

Broad-field reviewer answers:
- Which candidates would matter outside a narrow niche?
- Which have a strong "why now" story?
- Which are too incremental or too tool-driven?
- Which cross-domain idea or new tool could strengthen the candidate?
- Which simple baseline could embarrass the proposed method?

### Round 4: Revision And Merge

Main agent revises candidates by:
- narrowing an overbroad idea;
- changing the target scenario;
- merging complementary ideas;
- adding missing baselines or stress tests;
- converting a weak method idea into a benchmark/failure-analysis idea;
- rejecting candidates with weak novelty or feasibility.

### Round 5: Final Ranking

Rank 3-6 topics using the quality rubric. For each selected topic, record:

| Topic | Specialist Verdict | Broad-Field Verdict | Key Revision | Remaining Risk | Decision |
|---|---|---|---|---|---|

## Decision Rules

Prefer topics that:
- survive both novelty attack and significance attack;
- have a concrete limitation supported by papers;
- can be tested with available artifacts;
- contain a clear failure or kill criterion;
- produce a paper even if the proposed method only partly works, for example through a benchmark, taxonomy, or negative result.

Reject topics that:
- depend only on buzzwords or generic tools;
- lack a measurable research question;
- require unavailable data or unrealistic compute;
- are very likely covered by a close recent paper;
- cannot explain why the contribution is more than incremental.

# Office Brain — agent memory for the CTO-office

> **Status: scoping / not yet implemented.** This doc captures the design for a persistent,
> compounding memory system for the "office of CTO" agent (the agent the [chat
> bridge](chat-bridge.md) drives). No repo, code, or config exists yet. Treat every "the brain
> does X" as "the brain would do X."

## Goal

Give the office agent a memory that **compounds**. Today every agent run starts cold: it
re-discovers the same org context (who's who, what we decided, where things live, how the
numbers are computed) on every task. The brain is a persistent, interlinked markdown knowledge
base that sits between the agent and the live world, so knowledge is **compiled once and kept
current**, not re-derived on every query.

The model is Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
pattern — "Obsidian is the IDE, the LLM is the programmer, the wiki is the codebase" — adapted
to Paseo's primitives and to **one fact that makes our version much leaner than gbrain or a
classic LLM-wiki**: our agents have an `executor` MCP that can re-query the live systems
(Slack, Google Sheets, GitHub, Linear, …) directly.

## Scope: one shared brain

The brain is a **single shared `memory/` for the whole org** — not per-channel, not per-user.
Every channel the bot is in reads and writes the same brain, and everyone on the team can see
it. This is the right call for a small startup (≈4 people) where context is meant to flow
freely: a decision captured from `#growth` is available when someone asks in `#eng`. (Contrast
Anthropic's Claude Tag, which scopes memory per channel with a shared workspace tier on top —
that partitioning exists for large orgs with need-to-know boundaries; we don't have that
problem and the partitioning would just fragment context. See
[Prior art: Claude Tag](#prior-art-claude-tag).)

If access tiers are ever needed (e.g. a sensitive `finance/` area), the lean move is a separate
repo with its own office agent, not channel-scoping inside one brain. Until then: one brain,
uniformly readable.

## The leanness thesis: memory is synthesis + provenance, not a data lake

A classic LLM-wiki keeps an immutable `raw/` layer because its sources are static files
(PDFs, clipped articles). **Ours are live systems we can re-query at any time.** So we do not
mirror raw data into the repo. Instead:

> A brain page records **what is true and what was decided**, and links to **where to verify
> it** (a Slack permalink, a Sheet URL, a PR). When freshness matters, the agent re-fetches via
> `executor` MCP. The repo holds belief and pointers; the world holds data.

This collapses the classic three layers (raw → wiki → schema) into two: the **brain** (LLM-
owned synthesis + pointers) and the **schema** (`AGENTS.md`, how the agent maintains it). It
deletes the entire ingestion-pipeline / OCR / raw-vector-store apparatus that makes other
implementations heavy. `raw/` survives only as an _optional_ place to pin an immutable capture
(a thread transcript, a point-in-time snapshot) when provenance genuinely needs the bytes, not
as a data mirror.

## The second thesis: capture is already happening

Every chat-bridge thread _is_ an ingest event. A CTO-office task naturally ends with "here's
what we decided / did / learned." So **capture is a step in thread teardown**, not a separate
pipeline anyone has to feed. And the office agent already has the Paseo tools to run the rest:

| LLM-wiki operation        | Paseo primitive that delivers it                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Ingest** (write memory) | chat-bridge thread teardown writes pages (+ explicit "remember that …")                                        |
| **Scheduled refresh**     | `create_schedule` agent pulls deltas from live systems via `executor` MCP                                      |
| **Query** (read memory)   | office agent reads `index.md` → drills into pages; spawns a **search subagent** so its own context stays clean |
| **Lint** (health-check)   | a scheduled agent runs the tiered contradiction/orphan check                                                   |

The brain compounds because every thread feeds it, the daemon's scheduler maintains it, and
subagents keep retrieval cheap — all primitives the chat-bridge design already uses.

## Format: OKF v0.1

The brain is an [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle — which is Karpathy's pattern, specified. It costs nothing (it's the markdown +
frontmatter we'd write anyway), it's the emerging interop standard so external tooling can
consume the brain unchanged, and its conformance rule is trivial.

OKF in one paragraph: a directory of UTF-8 markdown files; each file is a **concept** whose ID
is its path minus `.md`; every concept has a YAML frontmatter block with a required `type`;
concepts cross-link with standard markdown links (`[label](/path/to/concept.md)`); links are
**untyped** (the relationship is in the prose) and **broken links are tolerated** (a dangling
link is just not-yet-written knowledge); `index.md` and `log.md` are reserved filenames;
consumers must tolerate unknown types/fields and never reject a bundle for missing optional
data. A bundle is conformant if every non-reserved `.md` has parseable frontmatter with a
non-empty `type`.

### Frontmatter shape

```yaml
---
type: Person | Project | Decision | System | Metric | Playbook # seeded vocabulary — see anti-drift
title: Jane Doe
description: One-line summary used by index.md and search snippets.
resource: https://slack.com/archives/... # provenance pointer to the live source (our key field)
tags: [growth, partnerships]
status: active | superseded | unresolved # drives the deterministic lint gate
timestamp: 2026-06-27T10:00:00Z # ISO 8601 last meaningful change
---
```

`resource` (provenance) and `status` (lint signal) are the two fields we lean on hardest;
both are within OKF's "producers MAY add any keys" allowance.

### Seeded type vocabulary (anti-drift)

An unconstrained LLM generates `company`, `Company`, `Business`, and `Organization` across
runs, which makes the brain impossible to index or query reliably. We seed a **small fixed
list of allowed `type` values** in `AGENTS.md` and require pages to use them. Start minimal —
`Person`, `Project`, `Decision`, `System`, `Metric`, `Playbook` — and grow the list
deliberately, in the schema, not ad hoc per page. This is the one piece of ontology governance
worth doing; everything heavier (typed edges, contradiction-as-node, graph DBs) is explicitly
out of scope (see [Non-goals](#non-goals)).

## Repo layout: the office repo

The office agent's workspace is a `directory` workspace whose `cwd` is the **office repo** — a
private repo that lives alongside your other product repos. (See [chat-bridge.md](chat-bridge.md).
The agent can still `cd` to sibling repos or cut a worktree off a product repo for code work via
the subagent-relay flow.)

```
office/
  AGENTS.md            # the schema — how the office agent thinks, the seeded type vocabulary,
                       #   capture/query/lint workflows. Auto-read as the workspace root by
                       #   Pi/Claude/Codex. THIS is what makes the agent a disciplined
                       #   maintainer rather than a generic chatbot.
  memory/              # the OKF v0.1 knowledge bundle — the brain. LLM-owned.
    index.md           # routing catalog: every page, one-line description, grouped by section
    log.md             # append-only timeline of captures / decisions / lint passes
    people/            # teammates, customers, investors, partners
    projects/          # what each repo/initiative is, status, owners
    decisions/         # decision records + dead-ends ("we ruled out X because Y")
    systems/           # infra, services, where things live, runbooks
    metrics/           # KPIs, where the numbers come from, how they're computed
    playbooks/         # repeatable workflows ("how we cut a release")
  skills/              # org-wide Agent Skills (SKILL.md each) — shared workflows (see below)
  tools/               # small CLI scripts the agent shells out to (lint gate, later: search)
  raw/                 # OPTIONAL immutable captures only when provenance needs the bytes —
                       #   NOT a data mirror
```

The directory structure under `memory/` is domain-driven and OKF-agnostic — reorganize freely;
OKF identity is the file path, and `index.md` is regenerated from whatever's there.

## Operations

### Capture (write memory)

The compounding loop. Triggered three ways:

- **Automatically at thread teardown.** When a chat-bridge thread closes with `@cto done` or
  `@cto archive` (see chat-bridge teardown policy), the office agent writes what was decided/done/learned into
  the relevant `memory/` pages, sets `resource` to the Slack permalink, and appends an entry to
  `log.md`. This happens for free on every task — it's the primary ingestion path.
  Capture is **attributed**: the chat bridge passes the sender's identity (see
  [Who's talking](#whos-talking-sender-identity)) so the agent can record _who_ decided/asked
  what, link it to that person's `people/` page, and update that page as it learns about them.
- **Explicitly.** "remember that we decided X" / "file this."
- **Scheduled.** A `create_schedule` agent pulls deltas from live systems via `executor` MCP
  (e.g. nightly: new Linear tickets → `projects/`, updated KPIs → `metrics/`). The brain
  re-derives itself as the org changes underneath it.

A single capture may touch 10–15 pages (update the person, the project, the decision, the
index, the log). That cross-referencing bookkeeping is exactly the tedious work LLMs do well and
humans abandon wikis over.

**Keep entries short.** Memory is a _curated note, not a transcript_. Saved facts must be short
and stable; a long entry crowds out everything else and turns the brain into a running log.
Memory holds **stable facts**; anything procedural or long-form — a runbook, a style guide, a
review checklist — lives as a `playbooks/` page or a `skills/` package and is _linked_, not
inlined. (This rule is lifted from Claude Tag's memory guidance; see
[Prior art](#prior-art-claude-tag).)

**Anti-drift on capture:** synthesis decay is a real failure mode — over many rewrite cycles,
nuance compresses out and a stale claim can become "ground truth." Mitigations, all cheap:
anchor consequential claims to a `resource` pointer (re-verifiable), keep `log.md` and `raw/`
append-only (never rewritten), and mark superseded claims `status: superseded` rather than
silently overwriting — a later correction supersedes, it doesn't erase the trail.

### Query (read memory)

1. Read `memory/index.md` to route to candidate pages.
2. Drill into the pages; for anything non-trivial, **spawn a search subagent** (the chat-
   bridge's existing subagent primitive) so the main agent's context stays reserved for
   orchestration and answering. This is Karpathy's own "subagents for search" recommendation.
3. Answer with citations back to the brain pages and/or live `resource` links.
4. **File notable answers back** as new pages — a comparison, an analysis, a connection
   discovered. Explorations compound into the brain instead of evaporating into chat history.

At small-to-moderate scale (hundreds of pages), **`index.md` + `ripgrep` is enough** — no
embedding/RAG infra required. Real-world implementers confirm this holds to ~100 sources /
hundreds of pages before a real search index earns its place.

### Lint (health-check)

Contradiction checking is **not** a monolithic full-repo LLM pass — that nukes the context
window and goes O(n²). It's tiered, with most of the work deterministic:

1. **Per-source check at capture (LLM, cheap).** When a capture touches pages, compare the new
   claim only against those ~8–15 pages, not the whole brain. Classify any conflict as soft /
   scope-mismatch / hard. Soft conflicts are flagged and kept (useful peripheral context); hard
   conflicts get `status: unresolved` and block the capture until a human resolves them.
2. **Deterministic commit gate (no LLM, zero context cost).** `tools/lint-gate.sh` is a pure
   `grep`/`comm` sweep over `memory/`: any `status: unresolved`, orphan pages (no inbound
   links), broken-but-not-stub links, missing/empty `type` frontmatter. It touches every file
   but only via cheap disk I/O — so it scales to any size and runs on every capture.
3. **Scoped LLM lint (periodic backstop).** The only reasoning-heavy pass, and it runs **only
   over pages changed since the last lint plus their 1st/2nd-degree wikilink neighbors** — never
   the full repo. A contradiction can only exist between claims about linked concepts, so the
   graph hands us the bounded neighborhood for free. A full sweep runs only after large capture
   rounds or on explicit request — a cleanup pass, not the primary defense.

This is delivered as a scheduled agent (`create_schedule`) plus the deterministic shell gate.

**Memory hygiene (two standing habits, from Claude Tag's operational guidance):**

- **A correction becomes a standing instruction.** When someone corrects the agent ("no, the
  pipeline repo is `acme/data`, not `acme/website"`), the agent doesn't just fix the answer —
  it records the fix in `memory/` so the mistake doesn't recur. A one-time correction turns
  into a permanent one.
- **Prune what the work has outgrown.** Entries written weeks ago can describe an owner,
  project, or convention that no longer exists. The periodic lint reviews stale entries (oldest
  `timestamp`, or pages whose `resource` now 404s) and proposes pruning — the brain stays a
  current picture, not an archaeological dig.

## Who's talking (sender identity)

The agent must know **who sent each message**. "Add this to the partner tracker" means
something different from the CEO than from a contractor, and capture is only useful if it can
record _who_ decided what. The bridge therefore passes a resolved sender identity into the
agent on every turn — this is a chat-bridge responsibility (see
[chat-bridge.md](chat-bridge.md)), consumed by the brain.

**What the bridge passes.** Slack messages carry a stable `user` id (e.g. `U012ABC`). The
bridge resolves it via Chat SDK to a small, stable identity block and prepends it to the
assembled prompt (and to the `sendAgentMessage` for follow-ups):

```
From: Jane Doe (@jane, U012ABC) — see people/jane-doe.md
```

Resolution is cheap and cached: Slack id → display name / handle, looked up once and stored.
Follow-ups in a thread can come from a _different_ person than the starter (multiplayer
steering — anyone in the channel can continue a session), so identity is attached **per
message**, not once per thread.

**How the brain uses it.** Each teammate/customer/partner is a `people/` concept page keyed by a
stable slug, with the Slack id in frontmatter so the agent can map an inbound id to the right
page without guessing:

```yaml
---
type: Person
title: Jane Doe
description: Co-founder, owns growth + partnerships.
tags: [team, founder]
slack_id: U012ABC # the join key from inbound messages
slack_handle: "@jane"
status: active
timestamp: 2026-06-27T10:00:00Z
---
```

On capture, the agent links decisions/requests to the sender's page ("Jane decided X") and
**updates the page itself** as it learns (role, preferences, areas owned). A new sender with no
page yet gets a stub created — a dangling `people/` link is just not-yet-written knowledge, per
OKF. Over time `people/` becomes the org's working model of who does what, populated for free
from the messages flowing through the bridge.

**Bootstrapping the 4-person team.** Seed `people/` once with a page per teammate (name, role,
Slack id). After that it's self-maintaining. This is also the natural home for the _human_ the
agent is acting on behalf of — the agent reads the sender's page to calibrate tone, authority,
and defaults.

## Skills hosting

The office repo's `skills/` directory holds org-wide
[Agent Skills](https://agentskills.io/specification) (`SKILL.md` packages) — shared, versioned
workflows anyone's agent can use.

- **For the office agent, automatically.** Pi/Claude/Codex discover skills from
  `.agents/skills/` walking from `cwd` up to the git root (see pi `docs/skills.md`). Exposing
  the office repo's `skills/` (via `.agents/skills/` or a settings `skills` entry)
  auto-discovers them for any agent running in the office repo — progressive disclosure means
  only the descriptions sit in context until a task matches.
- **Org-wide.** Teammates clone the office repo and point their agent settings at its `skills/`
  directory. Because it's a git repo, distribution, versioning, and review are free — a new
  "weekly board update" skill is just a PR.

This closes a loop with memory: a **playbook** in `memory/playbooks/` that proves genuinely
repeatable can **graduate into a skill** in `skills/`. Memory captures _what we learned_; skills
package _what we do repeatedly_.

## How it wires together

```
Slack thread → office agent (cwd: office repo)
  ├─ reads AGENTS.md (schema, seeded type vocabulary) + memory/index.md (routing)
  ├─ query  → search subagent → compact synthesis (keeps main context clean)
  ├─ act    → executor MCP (Sheets / GitHub / Linear / …); re-fetch live when freshness matters
  ├─ code   → worktree subagent off a product repo (Slack still talks to the office agent)
  └─ teardown → CAPTURE: update memory/ pages + append log.md
                 → deterministic lint gate (grep) blocks on unresolved contradictions

Scheduled agent (nightly) → pull deltas via executor MCP → update memory/ → scoped LLM lint
Whole repo = git → cloned across the org → shared brain + shared skills
```

## Build order (the leanness discipline)

**Build first (v1):**

- The office repo: `AGENTS.md` schema (with the seeded type vocabulary + capture/query/
  lint workflows) and a `memory/` skeleton.
- `memory/index.md` routing + `ripgrep` for search. **Enough to hundreds of pages.**
- Capture-on-thread-teardown wired into the chat bridge.
- `provenance` (`resource:`) pointers + append-only `log.md`.
- The deterministic `tools/lint-gate.sh` (`grep`/`comm`).
- `skills/` directory.

**Defer until `index.md` + ripgrep visibly stops scaling:**

- A derived **SQLite FTS + embedding index** as a `tools/office-search` CLI. Design when built:
  _vault = truth, index = throwaway_ (rebuildable), **content-hash authority** (not mtime) to
  decide what re-indexes, independent commit of keyword vs vector so a down embedder never marks
  a stale vector "done." This is a cache over the markdown, never a second source of truth.
- The scoped LLM lint as a scheduled agent (the deterministic gate covers v1).

## Non-goals

These are the "heavy and clever" directions raised in the LLM-wiki community that we
**deliberately do not build** — they're where leaner systems turn into gbrain-scale projects:

- **A graph database or knowledge-graph engine.** Untyped `[[wikilinks]]` + frontmatter `type`
  are sufficient; the filesystem + git is the graph store.
- **Typed edges / contradiction-as-node ontology.** Relationships live in prose; contradictions
  are a `status` field + a human resolution, not first-class graph objects.
- **RLHF / dynamic node-weighting / spaced-repetition ranking.** Interesting research, not
  needed for an office brain.
- **A raw-data mirror / OCR / ingestion ETL.** We point at live systems via `executor` MCP and
  re-fetch; we don't warehouse their data.
- **Multi-process / multi-instance memory services.** The brain is a git repo; concurrency is
  handled by git and by the chat bridge's serial-per-thread queue.

## Open questions

- **Authority on capture conflicts.** When the agent captures "we decided X" from Slack, the
  memory page becomes the authoritative _synthesis_ with a `resource` pointer back — which means
  a stale page can drift from a later live correction. The mitigation is the scheduled re-sync +
  `status: superseded`. The purist alternative (memory always fully re-derivable from live
  sources, never authoritative) is more correct but more expensive; we start with
  synthesis-authoritative + provenance and reassess.
- **Capture trigger granularity.** Is teardown-only capture enough, or do long-running threads
  need periodic mid-thread checkpoints so a crash doesn't lose accumulated context?

## Prior art: Claude Tag

Anthropic's [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) (Jun 2026) is
the hosted, productized version of this same idea: `@Claude` in a Slack channel starts a working
session, it remembers context, runs scheduled routines, and acts through connected tools.
Strong validation — 65% of Anthropic's product team's code reportedly comes from their internal
version, and it's used well beyond engineering (metrics, support, incident triage). What we
deliberately take and leave:

**Take:**

- **"Memory is a curated note, not a transcript."** Short, stable facts in memory; long-form
  procedures in linked repo docs / skills. (Drives the [Keep entries short](#capture-write-memory)
  rule.)
- **Three accumulation paths** — you tell it, it saves on its own, it reads past sessions —
  match our explicit / teardown / scheduled capture triggers.
- **Memory hygiene as standing habits** — a correction becomes a standing instruction; prune
  what the work outgrew. (Folded into [Lint](#lint-health-check).)
- **Channel/scope-bounded access with service-account identity** for clean audit — informs the
  chat-bridge access posture, not the brain itself.

**Leave:**

- **Per-channel memory partitioning.** Built for large orgs with need-to-know boundaries; a
  4-person startup wants context to flow, so we run [one shared brain](#scope-one-shared-brain).
- **Hosted ephemeral sandbox.** Our differentiator is local-first — the brain is markdown in
  _your_ git repo, on _your_ machine, with _your_ keys. No vendor lock, no inference markup.
- **Opaque memory.** Claude Tag's memory is a black box you query ("what do you remember?") and
  it admits it _can't full-text search past sessions_. Our brain is OKF markdown in git:
  inspectable, diffable, portable, and fully searchable (`index.md` + ripgrep, later FTS). That
  searchability is a concrete edge, not just an aesthetic one.

## Reference pointers

- [chat-bridge.md](chat-bridge.md) — the office agent, its `directory` workspace, subagent
  office-agent-only chat boundary, thread teardown (the capture trigger), sender-identity resolution,
  `create_schedule`/subagent primitives.
- [Claude Tag announcement](https://www.anthropic.com/news/introducing-claude-tag) and
  [memory](https://claude.com/docs/claude-tag/users/memory) /
  [proactivity](https://claude.com/docs/claude-tag/users/proactivity) docs — the closest prior
  art; mined for memory-as-curated-note, accumulation paths, hygiene habits, and routines.
- [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  — the source pattern (three layers, ingest/query/lint, "bookkeeping is the hard part").
- [Open Knowledge Format (OKF) v0.1 spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
  — the markdown + frontmatter format the brain conforms to.
- pi `docs/skills.md` — how `.agents/skills/` discovery works (the org-wide skill-sharing path).

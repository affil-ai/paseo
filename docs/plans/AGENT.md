# Planning Standard

Affil plans should be spec-driven: define the product/domain contract first,
then the relevant technical contracts and execution plan, then keep the plan updated as
implementation changes reality.

This file defines the standard shape for new folders under `docs/plans/`.

## When To Create A Plan Folder

Create a dedicated `docs/plans/<feature-slug>/` folder when work has any of:

- new domain concepts or renamed concepts
- schema changes
- workflow or durable execution changes
- cross-package changes
- user-facing workflows with multiple states
- integrations with external providers
- migration or backfill risk
- phased implementation over more than one coding session

For narrow one-file fixes, do not create a plan unless asked.

## Standard Files

Use the smallest set of files that makes the work clear. Do not cargo-cult every
file for every task. Domain-specific files like `workflow.md`, `api.md`, and
`ui.md` should exist only when that domain is a major part of the implementation,
not merely because the work touches a workflow, endpoint, or small UI surface.

### `prd.md`

Use for product intent and user-visible behavior.

Include:

- Problem statement
- Goals
- User stories
- Product decisions
- Out of scope
- Success criteria
- Open questions

Avoid implementation details unless they constrain product behavior.

### `research.md`

Use when decisions depend on existing code, prior art, provider behavior, docs,
or unresolved technical constraints.

Include:

- Current code paths
- Relevant context docs
- External docs or provider findings
- Prior plans or branches
- Constraints and risks
- Recommended direction

Research should separate facts from recommendations.

### `system-design.md`

Use only when the work has multiple plausible package, service, runtime, or
data ownership models and those tradeoffs must be decided before implementation.

Include:

- Domain model
- Package/module boundaries
- Dependency direction
- Ports/adapters
- Runtime ownership
- Data ownership
- Tradeoffs

Most plans do not need this file. Put concrete boundary decisions in
`execution.md`, `workflow.md`, `schema.md`, or `api.md` when they fit there.

### `schema.md`

Use for database, Convex, persisted JSON, or durable event shape changes.

Include:

- Tables/collections/types
- Enums
- Required vs optional fields
- Unique constraints and indexes
- Foreign keys and ownership boundaries
- Migration notes
- What is deliberately deferred

Do not hand-write final SQL in plans unless the task is explicitly a manual SQL
repair. Drizzle schema changes still go through the repo's DB migration
workflow.

### `workflow.md`

Use when durable workflows, background jobs, agents, crawls, or multi-step
provider orchestration are a primary implementation focus.

Include:

- Parent/child workflow boundaries
- Inputs and outputs
- Step sequence
- Retry/resume/idempotency model
- Provider calls
- Persistence points
- Failure modes
- Artifacts

Prefer portable runners with ports over hardcoded workflow-runtime logic:

```ts
runFeatureWorkflow(input, ports);
```

The Vercel/Temporal/Trigger wrapper should wire production ports.

### `api.md`

Use when tRPC, HTTP, SDK, webhook, or public contract changes are a primary
implementation focus.

Include:

- Inputs and outputs
- Auth/RBAC behavior
- Validation
- Error model
- Idempotency
- Backward compatibility
- SDK impact

### `ui.md`

Use when non-trivial UI workflows are a primary implementation focus, such as a
new user-facing page, dashboard, or multi-state product surface.

Include:

- User journey
- Views/states
- Empty/loading/error states
- Mutations and optimistic behavior
- Responsive behavior
- Copy decisions
- Reusable component boundaries

For Affil web UI, explicitly state whether work belongs in `packages/affil-ui`
or app runtime code.

### `execution.md`

Use as the concrete build checklist. This is the implementation ledger.
It should read like the plan an engineer would approve before coding, not like
a high-level project brief.

Include:

- Locked decisions
- Exact files
- Implementation slices
- Code sketches for non-obvious edits
- Call graph / data flow changes
- Tests to add or update
- Acceptance criteria
- Verification commands
- Implementation notes
- Implementation footprint
- Follow-ups

Each implementation slice should be specific enough that a coding agent can
start the edit without rediscovering the design. Prefer:

- `File`: exact path
- `Change`: exact function/type/table/router to edit
- `Sketch`: short TypeScript/SQL-ish example of the intended shape
- `Tests`: exact behavior to cover
- `Done when`: observable result

Do not use vague entries like "update API", "wire frontend", or "add tests"
without naming the relevant files/functions and showing the intended interface.
If a decision affects a cache key, auth model, idempotency rule, or migration
order, spell it out in the slice.

Execution plans should be updated during implementation, not only at the end.

## Recommended Folder Shapes

Small technical feature:

```text
docs/plans/<feature>/
  execution.md
```

Product feature:

```text
docs/plans/<feature>/
  prd.md
  execution.md
```

Major workflow feature:

```text
docs/plans/<feature>/
  research.md
  workflow.md
  execution.md
```

Add `schema.md` only when the workflow introduces database, persisted JSON, or
durable event shape changes.

Major API feature:

```text
docs/plans/<feature>/
  research.md
  api.md
  execution.md
```

Major UI feature:

```text
docs/plans/<feature>/
  prd.md
  research.md
  ui.md
  execution.md
```

Large product/system feature with major work in multiple domains:

```text
docs/plans/<feature>/
  prd.md
  research.md
  system-design.md
  <domain-specific files only when they are primary: schema.md, workflow.md, api.md, ui.md>
  execution.md
```

Only include `system-design.md` for cross-system ownership or tradeoff decisions
that cannot be captured clearly in the domain-specific files.

## Execution Plan Template

````md
# <Feature> — Execution Plan

Source references: <thread, issues, context docs, code paths>
Date created: YYYY-MM-DD

> [!IMPORTANT]
> This is a working execution plan. As implementation progresses:
>
> 1. Mark checklist items with `[x]` only after code is changed and verified.
> 2. Update **Implementation Notes** with deviations, decisions, and surprises.
> 3. Update **Implementation Footprint** with files created or modified.
> 4. Leave blocked or unverified work unchecked with a short note.

## Goal

<What outcome this plan delivers.>

## Locked Decisions

- <Decision>

## Out Of Scope

- <Explicit non-goal>

## Implementation Slices

### Slice 1 — <Concrete edit name>

**Goal**: <The behavior this slice unlocks.>

**Files**

- `<path>`
- `<path>`

**Change map**

| File     | Change                                     |
| -------- | ------------------------------------------ |
| `<path>` | <Exact function/type/table/router to edit> |

**Sketch**

```ts
// Small illustrative snippet. It does not need to compile as-is,
// but should show the intended interface and data flow.
```
````

**Tests**

- [ ] <Exact behavior to cover>

**Done when**

- [ ] <Observable result>

### Slice 2 — <Concrete edit name>

<Repeat the same shape.>

## Cross-Slice Acceptance Criteria

- [ ] <Observable result>

## Verification

- `<command>`

## Implementation Notes

- <Fill during implementation>

## Implementation Footprint

- <Fill during implementation>

```

## Planning Rules

- Start with domain language from `CONTEXT-MAP.md` and the relevant
  `docs/contexts/*/CONTEXT.md`.
- Record durable decisions explicitly. Do not bury them in prose.
- Use schemas/contracts to make illegal states harder to represent.
- Keep implementation phases independently reviewable.
- Prefer observable acceptance criteria over vague tasks.
- Separate research facts, product decisions, system design decisions, and build
  checklists.
- Mark uncertainty as open questions, not hidden assumptions.
- Do not silently widen scope during implementation. Add follow-ups.
- Keep plans updated when implementation diverges from the original design.
```

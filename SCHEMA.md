# Regen Engineering Knowledge Schema

Version 0.3.0 (draft, 2026-07-31)

This document defines how knowledge is laid out, formatted, linked, and validated in a Regen Engineering repository. It is deliberately small: it should take about twenty minutes to read, and it invents no new file formats. Everything is Markdown with YAML frontmatter, plus two JSON Schemas for validation.

The methodology this serves is described in the [manifesto](https://regen.engineering).

## 1. Layout

Knowledge lives in two places: one global tree, and one package per module.

```
knowledge/                      global knowledge
  vision.md                     what the system is for
  glossary.md                   ubiquitous language
  decisions/ADR-*.md            cross-cutting architecture decisions
  nfr/NFR-*.md                  non-functional requirements

<module>/knowledge/             the module's Knowledge Package
  overview.md                   purpose, responsibilities, out of scope
  glossary.md                   module-local terms (optional)
  rules/BR-*.md                 business rules
  decisions/ADR-*.md            module-local decisions
  assumptions/ASM-*.md          things believed but not guaranteed
  contracts/CT-*.md             behavioural contracts (see section 5)
  api.openapi.yaml              interface contract, REQUIRED when the module exposes an API
  knowledge.lock                regeneration lineage (see section 6)
```

A module is any directory that contains a `knowledge/` folder. Knowledge that spans modules goes in the global tree; everything else lives with the module it describes. Knowledge that belongs to everyone belongs to no one, so prefer the module tree when in doubt.

## 2. File format

One file per knowledge item. YAML frontmatter carries identity and relations; the Markdown body carries the prose a human or a model actually reads.

```markdown
---
id: BR-002
type: business-rule
title: Customer can own multiple addresses
status: active
since: 2026-07-30
affects: [customer, orders]
implemented_by: [customer]
verified_by: [CT-002]
---

A customer may register any number of addresses.
Exactly one address is the default shipping address.
Deleting the default promotes the most recently used address.
```

Do not maintain parallel `.md` and `.yaml` copies of the same knowledge. Two copies of one fact is drift waiting to happen, and this schema exists to prevent drift, not to breed it.

`overview.md`, `vision.md`, and `glossary.md` are plain Markdown without frontmatter. They are narrative, not items, and they are not validated beyond existing.

## 3. Frontmatter reference

| Field | Required | Type | Meaning |
|---|---|---|---|
| `id` | yes | string | Unique across the whole repository. Pattern: prefix + 3 digits, e.g. `BR-007` |
| `type` | yes | enum | `business-rule`, `decision`, `contract`, `assumption`, `nfr` |
| `title` | yes | string | One line, human-readable |
| `status` | yes | enum | `draft`, `active`, `deprecated`, `superseded` |
| `since` | no | date | When the item became true, `YYYY-MM-DD` |
| `affects` | no | string[] | Module names whose behaviour depends on this item |
| `implemented_by` | no | string[] | Module names containing the implementation |
| `verified_by` | no | id[] | Contract IDs (`CT-*`) that verify this item |
| `verifies` | contracts only | id[] | The `BR-*` or `NFR-*` items this contract verifies. Required on contracts |
| `supersedes` | no | id | The item this one replaces |
| `depends_on` | no | string[] | Free-form dependency names: modules, external services, libraries, teams. Deliberately unvalidated, because the important dependencies are outside the repository (REP-0004) |
| `likelihood`, `impact` | risks only | enum | `low`, `medium`, `high`. Coarse on purpose |
| `mitigation` | risks only | string | One line; the body carries the detail |
| `owner` | issues only | string | Who is dealing with it |

Unknown fields are rejected by validation. That is strictness as a feature: a typo like `affets` should fail loudly, not silently drop a link from the graph.

## 4. IDs and prefixes

| Prefix | Type | Example |
|---|---|---|
| `BR-` | business-rule | `BR-001` |
| `ADR-` | decision | `ADR-004` |
| `CT-` | contract | `CT-101` |
| `NFR-` | nfr | `NFR-002` |
| `ASM-` | assumption | `ASM-001` |
| `RISK-` | risk | `RISK-001` (REP-0004; optional `likelihood`, `impact`, `mitigation`) |
| `ISS-` | issue | `ISS-001` (REP-0004; optional `owner`) |

IDs are unique across the repository, not per module, so a link never needs qualifying. The prefix must match the item's `type`; validation enforces this. IDs are never reused: a deleted rule's ID stays retired, which keeps history and old lock files meaningful.

### Relation semantics

The frontmatter links form the knowledge graph that impact analysis walks:

- **affects** answers "if this item changes, which modules are in the regeneration scope?" It is the blast radius.
- **implemented_by** answers "where does this live in code?" Usually a subset of `affects`.
- **verified_by** / **verifies** tie rules to contracts from both ends. Every `active` business rule should be verified by at least one contract; the validator warns when one is not. This pair is also the traceability metric.
- **supersedes** preserves lineage when knowledge is replaced rather than edited. Mark the old item `superseded`, point the new one at it.

## 5. Contracts

Contracts are knowledge, not code. They are written and reviewed as knowledge, versioned as knowledge, and they change only when a human deliberately changes them. Regenerated code must satisfy the contracts that existed before it was generated.

A contract file states behaviour in given/when/then form:

```markdown
---
id: CT-002
type: contract
title: Default address behaviour on deletion
status: active
verifies: [BR-002]
---

## Scenario: deleting the default address

Given a customer with three addresses, one of them the default
When the customer deletes the default address
Then the most recently used remaining address becomes the default
And the customer still has two addresses
```

How a contract executes is stack-specific and out of scope for this schema. Each implementation stack provides a thin runner that maps contract files to executable tests. The contract itself stays stack-neutral; that neutrality is what makes the two-stack regeneration proof possible.

## 6. knowledge.lock

Every generated module carries a lock file recording its provenance:

```yaml
module: customer
knowledge_version: 9f3ac21d
generated_by: claude-fable-5
generated_at: 2026-07-30
contracts_passed: [CT-001, CT-002]
drift: none
```

| Field | Meaning |
|---|---|
| `knowledge_version` | Git commit hash of the repository when the knowledge this build used was current |
| `generated_by` | Model or tool that produced the implementation |
| `generated_at` | Date of generation, `YYYY-MM-DD` |
| `contracts_passed` | Contract IDs green at generation time |
| `drift` | `none`, `code-ahead` (implementation changed without a knowledge delta: a defect), or `knowledge-ahead` (knowledge changed, regeneration pending: a backlog) |

The lock file is what turns questions into queries: which modules were built from stale knowledge, which were built by last year's model, where has code drifted ahead of its source.

### Recording a Regeneration Test

When a module has been through the Regeneration Test, the outcome goes in its lock:

```yaml
last_regeneration:
  at: 2026-07-31
  model: claude-fable-5
  result: pass
  contracts_passed: 17
  contracts_total: 17
  guesses: 8
```

`guesses` is the count of questions the regenerating agent had to answer for itself, reported before it was scored. It matters as much as `result`: a pass with fifteen guesses is a module that got lucky, and those guesses are knowledge debt whether or not the contracts happened to catch them.

**Absence of this block means never attempted, which is not the same as passing.** `regen-debt` reports it as unknown, and deliberately never counts it toward the metric. A module nobody has regenerated is not healthy, it is unmeasured.

Note that the block describes a *run*, so if one regeneration covers several modules, the guess count belongs on one lock rather than being copied to each. Duplicating it inflates the total.

### More than one implementation

A module can have several implementations, for instance while migrating stacks or, as in the [demo](https://github.com/tysoncung/regen-engineering-demo), to prove that knowledge outlives any one of them. Provenance is per build, so each gets its own lock, named for its stack and carrying a matching `stack` field:

```
customer/knowledge.typescript.lock
customer/knowledge.python.lock
```

```yaml
module: customer
stack: python
knowledge_version: 4b81ce0
generated_by: claude-fable-5
generated_at: 2026-07-30
contracts_passed: [CT-001, CT-002, CT-003]
drift: knowledge-ahead
```

Validation requires the filename and the `stack` field to agree, and requires stack names once a module has more than one lock, since otherwise the two builds' provenance is ambiguous. Freshness is then reported per stack: one implementation can be current while another lags behind.

A module with a single implementation keeps the plain `knowledge.lock` and needs no `stack` field.

## 7. Validation

Two JSON Schemas ship with this repository:

- `schemas/knowledge-item.schema.json` validates frontmatter
- `schemas/knowledge-lock.schema.json` validates lock files

The reference validator walks the repository and checks, in order:

1. Frontmatter of every item file parses and matches the schema
2. ID prefixes match types; IDs are unique repository-wide
3. Every `verifies`, `verified_by`, and `supersedes` reference resolves to an existing ID
4. Every `affects` and `implemented_by` entry names an existing module
5. Lock files match the lock schema
6. Warning: `active` business rules with no verifying contract

Run it with:

```bash
npm install
npm run validate            # validates ./example
npm run validate -- <path>  # validates any knowledge tree
```

Exit code is non-zero on any error, so it drops into CI as-is.

### Impact analysis

Computing the regeneration scope is deterministic graph traversal, not a judgment call, which is why it is a script rather than a prompt. Given a changed item, it reports the modules to regenerate and the contracts that must pass afterwards.

```bash
npm run impact -- BR-002              # scope of a knowledge change
npm run impact -- --module customer   # everything asserted about a module
npm run impact -- --changed <files>   # map a git diff back to scope
npm run impact -- BR-002 --json       # machine-readable, for agents and CI
```

Contracts in scope are not only those verifying the changed item: every contract belonging to a module in scope must also pass, which is what stops a regeneration from quietly breaking a rule nobody edited.

### Knowledge debt

```bash
npm run debt            # the four metrics
npm run debt -- --json  # for CI job summaries
```

Where the tree is a git repository, freshness is checked properly by comparing each lock's `knowledge_version` against the last commit that touched that module's knowledge. Otherwise it falls back to the `drift` field the lock declares.

### Regenerability

The fifth metric, and the odd one out. The other four are computed from files in seconds; this one records whether regeneration was actually attempted and whether it worked, which costs real money to establish. That is exactly what makes it honest: **it is the only measure that cannot be satisfied by tidy paperwork.**

```bash
regen-debt --stale=90    # days before a passing result is considered stale
```

States: `current` (passed within the window), `stale` (passed, but too long ago), `failing`, and `unknown` (never attempted). Unknown never counts as passing.

The report also flags likely under-linking: an item whose prose cites an item owned by another module, while `affects` never mentions that module. Missing links are the most dangerous defect in a knowledge tree, because they silently shrink the regeneration scope and produce confident, incomplete work. Exit code is non-zero when any module has code-ahead drift.

### Drift check

Drift is divergence between knowledge and implementation, and it has a direction. Knowledge ahead of code is a backlog and perfectly healthy. Code ahead of knowledge is a defect: something is true of the running system that the source of truth does not know.

Detection is structural, not semantic. If a change touches a module's non-knowledge files and contains no corresponding change to that module's knowledge, that is code-ahead drift. No understanding of the code is required, only the observation that a build artifact changed while its source did not.

```bash
node tools/drift.mjs --base main             # diff against a branch
node tools/drift.mjs --tree example --changed a.ts b.md
```

This over-reports by design: a pure refactor trips it too. Deciding whether a change is behavioural is human judgment, and the escape hatch is explicit rather than silent. Declaring `drift_debt` in the module's lock unblocks the merge while keeping the debt visible, because `debt.mjs` still counts it against integrity:

```yaml
drift: code-ahead
drift_debt:
  since: 2026-07-30
  reason: hotfix for incident 4412, payment retry loop
  reconciliation_task: ENG-991
```

An emergency hatch that hid the debt would be rot with paperwork. This one does not hide it.

### Continuous integration

A composite action is included:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # drift needs history to diff against the base ref
- uses: actions/setup-node@v4
  with:
    node-version: 22
- uses: tysoncung/regen-engineering-schema/action@main
  with:
    tree: .
    drift: 'true'         # 'false' to report without blocking
```

It validates the tree, blocks code-ahead drift, and posts the debt report to the job summary. Note that debt is always a report and never a gate; only validation and drift can fail a build.

## 7b. Interface contracts (REP-0002, new in 0.2.0)

A module whose `overview.md` documents an HTTP interface **must** include `api.openapi.yaml` in its knowledge package. The prose table becomes a human summary; where the two disagree, the OpenAPI file is authoritative and validation flags the disagreement.

Why this is required rather than recommended: an honest Regeneration Test on the reference demo failed exclusively on wire-format questions the prose never answered, and a contract exercised an endpoint no overview documented. Business logic survives regeneration when written as prose; interface shape does not. The full evidence is in REP-0002.

What the validator checks:

1. An interface table in `overview.md` with no `api.openapi.yaml` is an error
2. Every prose table row must exist in the OpenAPI file (parameter names may differ; path shape may not)
3. A contract file that summarises far less than the OpenAPI defines draws a staleness warning

The check that catches a contract exercising an undocumented operation lives at the contract-runner level, since prose scenarios cannot be matched to paths mechanically but a runner's step registry knows exactly which operations it calls. The reference runner asserts at startup that every operation it uses is documented, with `/health` and `/reset` exempt as testability affordances.

### Migration from 0.1.x

Breaking only for modules that document an HTTP interface in prose without an OpenAPI file. To migrate:

1. Write `api.openapi.yaml` covering at least every row of the prose table, including response schemas and error bodies. The wire-format questions a regenerating agent would otherwise guess at (envelopes, field names, status codes for edge cases) are exactly what belongs here.
2. Add a line to the overview declaring the OpenAPI file authoritative.
3. Re-run `regen-validate`.

Modules with no HTTP interface need nothing.

## 7c. Generated documents (REP-0004)

`regen-docs` renders the documents enterprises are obliged to write, from knowledge that already exists:

```bash
regen-docs requirements    # functional + non-functional requirements, assumptions
regen-docs hld             # modules, decisions, cross-module surface
regen-docs dld --module customer
regen-docs raid            # risks, assumptions, issues, dependencies
regen-docs traceability    # requirement -> implementation -> contract matrix
```

The cardinal rule: **derive, never invent**. Where knowledge is silent the output says "Not specified", because a generated document that fills gaps with plausible prose launders absence into apparent completeness. Every statement carries its source id, output carries a generation stamp, and generated files are build artifacts that must never be committed into the knowledge tree.

The traceability matrix is the same audit trail regulated industries maintain by hand; here it falls out of links people were already writing, and gaps print as gaps.

## 8. Versioning

This schema follows semver. Additive, backward-compatible changes bump the minor version; anything that breaks an existing knowledge tree bumps the major and must ship with migration notes. `knowledge.lock` may gain a `schema_version` field when there are two versions in the wild to distinguish; v0.1 omits it on purpose.

Changes to this schema go through Regen Engineering Proposals (REPs) once that process opens. Until then, open an issue.

# Regen Engineering Knowledge Schema

Version 0.1.0 (draft, 2026-07-30)

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
  api.openapi.yaml              interface contract, when the module exposes an API
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

Unknown fields are rejected by validation. That is strictness as a feature: a typo like `affets` should fail loudly, not silently drop a link from the graph.

## 4. IDs and prefixes

| Prefix | Type | Example |
|---|---|---|
| `BR-` | business-rule | `BR-001` |
| `ADR-` | decision | `ADR-004` |
| `CT-` | contract | `CT-101` |
| `NFR-` | nfr | `NFR-002` |
| `ASM-` | assumption | `ASM-001` |

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

## 8. Versioning

This schema follows semver. Additive, backward-compatible changes bump the minor version; anything that breaks an existing knowledge tree bumps the major and must ship with migration notes. `knowledge.lock` may gain a `schema_version` field when there are two versions in the wild to distinguish; v0.1 omits it on purpose.

Changes to this schema go through Regen Engineering Proposals (REPs) once that process opens. Until then, open an issue.

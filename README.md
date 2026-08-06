# Regen Engineering knowledge schema

The file conventions, link semantics, and validator for [Regen Engineering](https://regen.engineering) knowledge trees.

> Knowledge is the asset. Code is the byproduct.

**Read [SCHEMA.md](SCHEMA.md).** It takes about twenty minutes.

## What this is

A knowledge tree is Markdown with YAML frontmatter. The frontmatter carries identity and relations, the body carries the prose people and models read. No new file formats are invented here: Markdown, YAML, OpenAPI, and JSON Schema already exist and already have tooling.

The relations form a graph. That graph is what makes impact analysis, traceability, and drift detection mechanical rather than aspirational:

```
BR-002 ──affects──────► customer, orders      (regeneration blast radius)
       ──implemented_by► customer             (where the code lives)
       ──verified_by───► CT-002               (what proves it still holds)
```

## Install

```bash
npm install -g regen-engineering-schema    # then: regen-validate .
```

Or without installing, note the `-p`:

```bash
npx -p regen-engineering-schema regen-validate .
```

**The `-p` is not optional.** The commands are named `regen-validate`, `regen-impact` and so on, but the package is `regen-engineering-schema`. Bare `npx regen-validate` would look for a *package* of that name, which this project does not own, so npx would fetch and run whatever a stranger publishes under it. Always name the package.

## Try it

```bash
npm install
npm run validate                    # validates ./example
npm run validate -- path/to/tree    # validates any knowledge tree
```

The [example](example/) tree is a small commerce domain with two modules, twelve knowledge items, a rule that deliberately spans both modules, and one module left in a `knowledge-ahead` drift state.

## The Librarian

Every other tool here looks at a change. `regen-librarian` looks at the whole corpus, and hunts for the failures that only appear when items are read against each other.

```bash
npx -p regen-engineering-schema regen-librarian .
npx -p regen-engineering-schema regen-librarian . --bundle   # packet for the reading pass
```

It finds quantitative tension (an upper bound that something else in the tree exceeds), orphans, staleness, duplication candidates, and low-confidence items that much of the tree has come to rest on.

The tension check exists because of a real failure. The reference demo carried a rule capping a customer's address book at twenty alongside another describing a response of fifty. Both files were individually well formed, so validation reported no problems; no contract asked, so the suite stayed green. A person found it days later by reading two files side by side.

**This is deliberately only half a Librarian.** [REP-0006](https://github.com/tysoncung/regen.engineering/blob/main/reps/REP-0006-continuous-knowledge-operations.md) specifies the Librarian as a reader, and structure and arithmetic can only say where to look. Whether two rules actually contradict, whether a duplicate is redundancy or emphasis, whether an old draft is stale or simply settled: all of that is judgement, and `--bundle` emits the packet for it. Shipping this half alone and calling it done would repeat the exact mistake the REP exists to fix.

It always exits 0. These are candidates for a person to read, not build breaks, and a tool that fails a build on a heuristic teaches people to switch it off.

## What the validator checks

1. Frontmatter parses and matches the schema, with unknown fields rejected so typos fail loudly
2. ID prefixes match item types, and IDs are unique across the whole tree
3. Every `verifies`, `verified_by`, and `supersedes` reference resolves
4. Every `affects` and `implemented_by` names a real module
5. `knowledge.lock` files match the lock schema
6. Warns when an active business rule has no contract verifying it, which is knowledge debt

Exit code is non-zero on any error, so it works as a CI gate unchanged.

## Status

Version 0.4.0, draft. Expect breaking changes before 1.0. Semver applies: anything that breaks an existing knowledge tree bumps the major version and ships with migration notes.

## Licence

MIT for the schemas and tooling. Documentation is CC BY-SA 4.0.

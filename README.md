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

## Not on npm yet

**Do not run `npx regen-<anything>`.** None of these names are published, so npx would resolve them from the public registry to whatever a stranger has uploaded under that name, and run it. Clone this repository and call the tools by path until an official package exists.

## Try it

```bash
npm install
npm run validate                    # validates ./example
npm run validate -- path/to/tree    # validates any knowledge tree
```

The [example](example/) tree is a small commerce domain with two modules, twelve knowledge items, a rule that deliberately spans both modules, and one module left in a `knowledge-ahead` drift state.

## What the validator checks

1. Frontmatter parses and matches the schema, with unknown fields rejected so typos fail loudly
2. ID prefixes match item types, and IDs are unique across the whole tree
3. Every `verifies`, `verified_by`, and `supersedes` reference resolves
4. Every `affects` and `implemented_by` names a real module
5. `knowledge.lock` files match the lock schema
6. Warns when an active business rule has no contract verifying it, which is knowledge debt

Exit code is non-zero on any error, so it works as a CI gate unchanged.

## Status

Version 0.1.0, draft. Expect breaking changes before 1.0. Semver applies: anything that breaks an existing knowledge tree bumps the major version and ships with migration notes.

## Licence

MIT for the schemas and tooling. Documentation is CC BY-SA 4.0.

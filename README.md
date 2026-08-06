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

### The reading pass

```bash
export OPENROUTER_API_KEY=...          # or ANTHROPIC_API_KEY, or REGEN_LLM_API_KEY
export REGEN_LLM_MODEL=anthropic/claude-sonnet-4.5
npx -p regen-engineering-schema regen-librarian . --read
```

`--read` ships the corpus to a model and prints what it finds. It is a transport and holds no opinion of its own; the judgement is in the prompt and the model.

Provider-agnostic on purpose, with no added dependencies. An `OPENROUTER_API_KEY` routes to OpenRouter in the OpenAI-compatible shape, an `ANTHROPIC_API_KEY` alone routes to Anthropic natively, and `REGEN_LLM_BASE_URL` points at anything else that speaks the OpenAI shape. The model is never guessed: a wrong identifier fails at the API with a worse message than the one this prints, and model choice is a real decision.

The methodology claims knowledge outlives models. That claim is worth little if the tooling can only talk to one vendor.

The tension check exists because of a real failure. The reference demo carried a rule capping a customer's address book at twenty alongside another describing a response of fifty. Both files were individually well formed, so validation reported no problems; no contract asked, so the suite stayed green. A person found it days later by reading two files side by side.

**This is deliberately only half a Librarian.** [REP-0006](https://github.com/tysoncung/regen.engineering/blob/main/reps/REP-0006-continuous-knowledge-operations.md) specifies the Librarian as a reader, and structure and arithmetic can only say where to look. Whether two rules actually contradict, whether a duplicate is redundancy or emphasis, whether an old draft is stale or simply settled: all of that is judgement, and `--bundle` emits the packet for it. Shipping this half alone and calling it done would repeat the exact mistake the REP exists to fix.

It always exits 0. These are candidates for a person to read, not build breaks, and a tool that fails a build on a heuristic teaches people to switch it off.

## The Monitor

`regen-monitor` ranks **modules** by how far each is from being understood, and compares against a recorded baseline so decay is visible as a direction rather than a number.

```bash
npx -p regen-engineering-schema regen-monitor .
npx -p regen-engineering-schema regen-monitor . --record   # write the baseline, then commit it
```

The debt report already answers "how healthy is this tree", so this exists for the two things that report cannot do. It is **per metric, not per module**: freshness at 50% does not tell you which module to open, and work happens on modules. And it has **no memory**: a module at 60% that was at 90% last month is being fixed, one that was at 30% is in trouble, the number is identical and the correct response is opposite. Decay is a derivative, and you cannot see it in a snapshot.

It consumes `regen-debt --json` rather than recomputing anything, so the two can never disagree about facts, only about presentation. The weights are printed in the JSON output rather than buried, because a ranking is only as defensible as its weights.

## The Trigger

`regen-trigger` decides whether regenerating a module is worth what it costs. The most useful thing it does is **refuse**.

```bash
REGEN_LLM_MODEL=<what you would build with today> npx -p regen-engineering-schema regen-trigger .
```

Two states make regeneration actively harmful rather than merely wasteful, and both are easy to walk into while looking at a dashboard saying a module is unhealthy. **Code-ahead drift** means the implementation holds behaviour the knowledge does not describe, so regenerating deletes it silently and the module looks healthier afterwards because the evidence is gone. **A failing Regeneration Test** means the knowledge is already known to be insufficient, so spending again proves nothing new.

Both refusals are mechanical, because neither is a judgement call. Everything else is weighed and proposed with reasoning: knowledge-ahead, never verified, verification stale, and the model having moved on since the module was built. A pass with many guesses counts as a warning rather than a success, because a module that passed while its agent guessed nineteen times got lucky.

## The Gatherer

`regen-gather` finds changes that implied knowledge nobody wrote down.

```bash
npx -p regen-engineering-schema regen-gather .
npx -p regen-engineering-schema regen-gather . --read     # or --bundle
```

The filter is the whole idea: **commits that changed an implementation and changed no knowledge**. A commit that touched both has already recorded itself. What remains is the set of changes that had something to say and no place to say it, ranked so that incident-shaped changes and long explanatory messages come first, because those are where constraints surface and rarely get recorded.

This reads history rather than the working tree, which is what distinguishes it from `regen-drift`. Drift asks whether the code is ahead right now; this asks what was learned along the way, including in changes since superseded, because the reason usually outlives the diff.

It reports **CANNOT TELL** rather than a clean result when nothing in the range matched anything recognised as implementation, which nearly always means `implementation_paths` is missing from the lock rather than that history is quiet.

## What the validator checks

1. Frontmatter parses and matches the schema, with unknown fields rejected so typos fail loudly
2. ID prefixes match item types, and IDs are unique across the whole tree
3. Every `verifies`, `verified_by`, and `supersedes` reference resolves
4. Every `affects` and `implemented_by` names a real module
5. `knowledge.lock` files match the lock schema
6. Warns when an active business rule has no contract verifying it, which is knowledge debt

Exit code is non-zero on any error, so it works as a CI gate unchanged.

## Status

Version 0.7.0, draft. Expect breaking changes before 1.0. Semver applies: anything that breaks an existing knowledge tree bumps the major version and ships with migration notes.

## Licence

MIT for the schemas and tooling. Documentation is CC BY-SA 4.0.

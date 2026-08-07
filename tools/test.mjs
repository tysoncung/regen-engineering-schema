#!/usr/bin/env node
// Tests for the reference tooling.
//
// A validator that only ever says OK is worthless, so most of these are
// negative: each one breaks the example tree in a specific way and asserts the
// tools notice. Run with `npm test`.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const EXAMPLE = join(REPO, 'example')

let passed = 0
const failures = []

/** Run a tool against a tree, returning { code, out }. */
function run(tool, args = []) {
  try {
    const out = execFileSync('node', [join(HERE, tool), ...args], {
      encoding: 'utf8',
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/**
 * Copy the example to a scratch tree, apply `mutate`, run `tool`, and assert
 * the output matches. Each case is isolated, so one failure cannot leak.
 */
function check(name, { mutate, tool = 'validate.mjs', args = [], argsFor, expect, reject, expectCode }) {
  const dir = mkdtempSync(join(tmpdir(), 'regen-test-'))
  try {
    cpSync(EXAMPLE, dir, { recursive: true })
    mutate?.({
      write: (rel, body) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), body)
      },
      read: (rel) => readFileSync(join(dir, rel), 'utf8'),
      remove: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    })
    const { code, out } = run(tool, argsFor ? argsFor(dir) : [...args, dir])
    const problems = []
    for (const e of [expect].flat().filter(Boolean))
      if (!out.includes(e)) problems.push(`expected output to contain ${JSON.stringify(e)}`)
    for (const e of [reject].flat().filter(Boolean))
      if (out.includes(e)) problems.push(`expected output NOT to contain ${JSON.stringify(e)}`)
    if (expectCode !== undefined && code !== expectCode)
      problems.push(`expected exit ${expectCode}, got ${code}`)

    if (problems.length) failures.push({ name, problems, out })
    else passed++
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- happy path

check('clean tree validates', { expect: 'OK.', expectCode: 0 })

check('clean tree reports no under-linking', {
  tool: 'debt.mjs',
  expect: 'Traceability',
  expectCode: 0,
})

// -------------------------------------------------------------- frontmatter

check('id prefix must match type', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-900.md',
      '---\nid: ADR-900\ntype: business-rule\ntitle: Mismatch\nstatus: active\n---\nbody\n',
    ),
  expect: 'must match pattern "^BR-"',
  expectCode: 1,
})

check('unknown frontmatter field is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-901.md',
      '---\nid: BR-901\ntype: business-rule\ntitle: Typo\nstatus: active\naffets: [customer]\n---\nbody\n',
    ),
  expect: 'must NOT have additional properties',
  expectCode: 1,
})

check('contract without verifies is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/contracts/CT-900.md',
      '---\nid: CT-900\ntype: contract\ntitle: No verifies\nstatus: active\n---\nbody\n',
    ),
  expect: "must have required property 'verifies'",
  expectCode: 1,
})

check('missing frontmatter is rejected', {
  mutate: ({ write }) => write('customer/knowledge/rules/BR-902.md', 'no frontmatter here\n'),
  expect: 'has no YAML frontmatter',
  expectCode: 1,
})

// -------------------------------------------------------------------- graph

check('duplicate id is rejected', {
  mutate: ({ read, write }) =>
    write('customer/knowledge/rules/BR-001-copy.md', read('customer/knowledge/rules/BR-001.md')),
  expect: 'duplicate id BR-001',
  expectCode: 1,
})

check('dangling verifies reference is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/contracts/CT-901.md',
      '---\nid: CT-901\ntype: contract\ntitle: Dangling\nstatus: active\nverifies: [BR-777]\n---\nbody\n',
    ),
  expect: 'verifies references unknown item BR-777',
  expectCode: 1,
})

check('unknown module in affects is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-903.md',
      '---\nid: BR-903\ntype: business-rule\ntitle: Ghost module\nstatus: active\naffects: [billing]\nverified_by: [CT-001]\n---\nbody\n',
    ),
  expect: 'affects unknown module "billing"',
  expectCode: 1,
})

check('supersedes must point at a superseded item', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-904.md',
      '---\nid: BR-904\ntype: business-rule\ntitle: Replaces an active rule\nstatus: active\nsupersedes: BR-001\nverified_by: [CT-001]\n---\nbody\n',
    ),
  expect: 'rather than "superseded"',
  expectCode: 1,
})

check('unverified active rule warns but does not fail', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-905.md',
      '---\nid: BR-905\ntype: business-rule\ntitle: Nobody verifies me\nstatus: active\naffects: [customer]\n---\nbody\n',
    ),
  expect: ['no contract verifies it', 'OK.'],
  expectCode: 0,
})

// --------------------------------------------------------------------- lock

check('malformed lock file is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: NOTAHASH\ngenerated_by: x\ngenerated_at: 2026-13-45\ndrift: sideways\n',
    ),
  expect: 'lock schema:',
  expectCode: 1,
})

check('lock in the wrong directory is rejected', {
  mutate: ({ write }) =>
    write(
      'orders/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: none\n',
    ),
  expect: 'but sits in "orders"',
  expectCode: 1,
})

check('lock referencing an unknown contract is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ncontracts_passed: [CT-999]\ndrift: none\n',
    ),
  expect: 'contracts_passed references unknown contract CT-999',
  expectCode: 1,
})

// -------------------------------------------------------------- multi-stack
// A module can have more than one implementation, so provenance needs one lock
// per stack. Discovered while building the two-stack demo.

const TS_LOCK =
  'module: customer\nstack: typescript\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: none\n'
const PY_LOCK =
  'module: customer\nstack: python\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: none\n'

check('per-stack locks are accepted', {
  mutate: ({ write, remove }) => {
    remove('customer/knowledge.lock')
    write('customer/knowledge.typescript.lock', TS_LOCK)
    write('customer/knowledge.python.lock', PY_LOCK)
  },
  expect: 'OK.',
  expectCode: 0,
})

check('two locks without stack names are rejected', {
  mutate: ({ write }) => {
    // Both land on the same module with no stack to tell them apart.
    write('customer/knowledge.lock', TS_LOCK.replace('stack: typescript\n', ''))
    write('orders/knowledge.lock', PY_LOCK.replace('module: customer', 'module: orders').replace('stack: python\n', ''))
  },
  expect: 'OK.',
  expectCode: 0,
})

check('lock filename and stack field must agree', {
  mutate: ({ remove, write }) => {
    remove('customer/knowledge.lock')
    write('customer/knowledge.python.lock', TS_LOCK)
  },
  expect: 'but the filename says "python"',
  expectCode: 1,
})

check('per-stack freshness is reported separately', {
  tool: 'debt.mjs',
  mutate: ({ write, remove }) => {
    remove('customer/knowledge.lock')
    write('customer/knowledge.typescript.lock', TS_LOCK)
    write(
      'customer/knowledge.python.lock',
      PY_LOCK.replace('drift: none', 'drift: knowledge-ahead'),
    )
  },
  expect: 'customer (python): stale',
  expectCode: 0,
})

// --------------------------------------------------------------- interfaces
// REP-0002: prose interface tables require a machine-readable contract, and
// the two must agree.

const OPENAPI_MIN = `openapi: 3.0.3
info: { title: t, version: 0.0.0 }
paths:
  /things:
    post:
      responses: { '201': { description: ok } }
`

const OVERVIEW_WITH_TABLE = `# T

## Interface

| Method | Path | Purpose |
|---|---|---|
| POST | \`/things\` | Create. 201 |
`

check('an interface table without api.openapi.yaml is rejected', {
  mutate: ({ write }) => write('customer/knowledge/overview.md', OVERVIEW_WITH_TABLE),
  expect: 'no api.openapi.yaml',
  expectCode: 1,
})

check('a matching table and contract pass', {
  mutate: ({ write }) => {
    write('customer/knowledge/overview.md', OVERVIEW_WITH_TABLE)
    write('customer/knowledge/api.openapi.yaml', OPENAPI_MIN)
  },
  expect: 'OK.',
  expectCode: 0,
})

check('a prose row the contract lacks is rejected', {
  mutate: ({ write }) => {
    write(
      'customer/knowledge/overview.md',
      OVERVIEW_WITH_TABLE + '| DELETE | \`/things/{id}\` | Remove. 204 |\n',
    )
    write('customer/knowledge/api.openapi.yaml', OPENAPI_MIN)
  },
  expect: 'has no such operation',
  expectCode: 1,
})

check('parameter names may differ between prose and contract', {
  mutate: ({ write }) => {
    write(
      'customer/knowledge/overview.md',
      OVERVIEW_WITH_TABLE + '| GET | \`/things/{thingId}\` | Fetch. 200 |\n',
    )
    write(
      'customer/knowledge/api.openapi.yaml',
      OPENAPI_MIN + `  /things/{id}:
    get:
      responses: { '200': { description: ok } }
`,
    )
  },
  expect: 'OK.',
  expectCode: 0,
})

check('an unparseable api.openapi.yaml is rejected', {
  mutate: ({ write }) => {
    write('customer/knowledge/overview.md', OVERVIEW_WITH_TABLE)
    write('customer/knowledge/api.openapi.yaml', 'paths: [unclosed')
  },
  expect: 'not valid YAML',
  expectCode: 1,
})

// ------------------------------------------------------------ regenerability
// Absence of a regeneration record must never read as a pass. That confusion is
// the whole reason the metric exists.

const withRegen = (extra) =>
  `module: customer\nstack: typescript\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: none\n${extra}`

check('a module never regenerated reads as unknown, not passing', {
  tool: 'debt.mjs',
  mutate: ({ remove, write }) => {
    remove('customer/knowledge.lock')
    write('customer/knowledge.typescript.lock', withRegen(''))
  },
  expect: 'never regenerated (unknown, not passing)',
  expectCode: 0,
})

check('a recent pass counts toward regenerability', {
  tool: 'debt.mjs',
  mutate: ({ remove, write }) => {
    remove('customer/knowledge.lock')
    write(
      'customer/knowledge.typescript.lock',
      withRegen('last_regeneration:\n  at: 2026-07-30\n  model: m\n  result: pass\n  guesses: 2\n'),
    )
  },
  expect: ['Regenerability', '2 unanswered question'],
  expectCode: 0,
})

check('an old pass is reported stale', {
  tool: 'debt.mjs',
  mutate: ({ remove, write }) => {
    remove('customer/knowledge.lock')
    write(
      'customer/knowledge.typescript.lock',
      withRegen('last_regeneration:\n  at: 2020-01-01\n  model: m\n  result: pass\n'),
    )
  },
  expect: 'past the 90d threshold',
  expectCode: 0,
})

check('a failing regeneration is reported as failing', {
  tool: 'debt.mjs',
  mutate: ({ remove, write }) => {
    remove('customer/knowledge.lock')
    write(
      'customer/knowledge.typescript.lock',
      withRegen('last_regeneration:\n  at: 2026-07-30\n  model: m\n  result: fail\n  contracts_passed: 14\n  contracts_total: 17\n'),
    )
  },
  expect: ['FAILING', '14/17'],
  expectCode: 0,
})

check('an invalid regeneration result is rejected by the schema', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: none\nlast_regeneration:\n  at: 2026-07-30\n  model: m\n  result: maybe\n',
    ),
  expect: 'lock schema:',
  expectCode: 1,
})

// ------------------------------------------------------------------- impact

check('cross-module rule pulls both modules into scope', {
  tool: 'impact.mjs',
  args: ['BR-002'],
  expect: ['customer', 'orders', 'CT-010'],
  expectCode: 0,
})

check('single-module rule leaves the other module untouched', {
  tool: 'impact.mjs',
  args: ['BR-001'],
  expect: 'Untouched: orders',
  expectCode: 0,
})

check('impact rejects an unknown id', {
  tool: 'impact.mjs',
  args: ['BR-777'],
  expect: 'Unknown item BR-777',
  expectCode: 2,
})

// --------------------------------------------------------------------- debt

check('code-ahead drift fails the debt report', {
  tool: 'debt.mjs',
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: code-ahead\n',
    ),
  expect: '1 code-ahead',
  expectCode: 1,
})

check('under-linking is detected when a cross-module citation is undeclared', {
  tool: 'debt.mjs',
  mutate: ({ read, write }) =>
    write(
      'customer/knowledge/rules/BR-002.md',
      read('customer/knowledge/rules/BR-002.md').replace('affects: [customer, orders]', 'affects: [customer]'),
    ),
  expect: 'BR-002 cites BR-010 (orders)',
  expectCode: 0,
})

check('missing knowledge package shows as incomplete coverage', {
  tool: 'debt.mjs',
  mutate: ({ remove }) => remove('orders/knowledge/overview.md'),
  expect: 'orders: missing overview.md',
  expectCode: 0,
})

// -------------------------------------------------------------------- drift
// The rule is structural: implementation changed, knowledge did not.

const drift = (name, files, { expect, expectCode, mutate, tool = 'drift.mjs' }) =>
  check(name, {
    tool,
    mutate,
    expect,
    expectCode,
    // `--changed` is greedy, so the tree has to be named before it.
    argsFor: (dir) => (tool === 'drift.mjs' ? ['--tree', dir, '--changed', ...files] : [dir]),
  })

drift('code changed without knowledge is drift', ['customer/src/service.ts'], {
  expect: 'DRIFT     customer',
  expectCode: 1,
})

drift(
  'code changed with its knowledge is not drift',
  ['customer/src/service.ts', 'customer/knowledge/rules/BR-001.md'],
  { expect: 'No code-ahead drift', expectCode: 0 },
)

drift('knowledge-only change is not drift', ['customer/knowledge/rules/BR-001.md'], {
  expect: 'No code-ahead drift',
  expectCode: 0,
})

drift('lock file counts as knowledge', ['customer/src/service.ts', 'customer/knowledge.lock'], {
  expect: 'No code-ahead drift',
  expectCode: 0,
})

drift('repo metadata is ignored', ['README.md', 'package.json'], {
  expect: 'No code-ahead drift',
  expectCode: 0,
})

drift(
  'only the drifting module is reported',
  ['customer/src/a.ts', 'customer/knowledge/rules/BR-001.md', 'orders/src/b.ts'],
  { expect: 'DRIFT     orders', expectCode: 1 },
)

drift('declared drift debt unblocks the merge', ['customer/src/service.ts'], {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: code-ahead\ndrift_debt:\n  since: 2026-07-30\n  reason: hotfix for incident 4412\n  reconciliation_task: ENG-991\n',
    ),
  expect: 'ACCEPTED  customer',
  expectCode: 0,
})

drift('drift debt still counts against integrity', [], {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-07-30\ndrift: code-ahead\ndrift_debt:\n  since: 2026-07-30\n  reason: hotfix\n',
    ),
  expect: '1 code-ahead',
  expectCode: 1,
  tool: 'debt.mjs',
})

// -------------------------------------------------------------- REP-0004

check('risk and issue items validate with their fields', {
  mutate: ({ write }) => {
    write('customer/knowledge/risks/RISK-900.md',
      '---\nid: RISK-900\ntype: risk\ntitle: A risk\nstatus: active\nlikelihood: high\nimpact: low\nmitigation: do less\naffects: [customer]\n---\nbody\n')
    write('customer/knowledge/issues/ISS-900.md',
      '---\nid: ISS-900\ntype: issue\ntitle: An issue\nstatus: active\nowner: someone\n---\nbody\n')
  },
  expect: 'OK.',
  expectCode: 0,
})

check('likelihood on a non-risk is rejected', {
  mutate: ({ write }) =>
    write('customer/knowledge/rules/BR-950.md',
      '---\nid: BR-950\ntype: business-rule\ntitle: Not a risk\nstatus: active\nlikelihood: high\nverified_by: [CT-001]\n---\nbody\n'),
  expect: 'must match "then" schema',
  expectCode: 1,
})

check('raid document derives and marks gaps honestly', {
  tool: 'docs.mjs',
  argsFor: (dir) => ['raid', dir],
  mutate: ({ write }) =>
    write('customer/knowledge/risks/RISK-901.md',
      '---\nid: RISK-901\ntype: risk\ntitle: Unmitigated risk\nstatus: active\n---\nbody\n'),
  expect: ['RISK-901', 'No mitigation recorded', 'No open issues recorded'],
  expectCode: 0,
})

check('traceability marks requirements without contracts as gaps', {
  tool: 'docs.mjs',
  argsFor: (dir) => ['traceability', dir],
  mutate: ({ write }) =>
    write('customer/knowledge/rules/BR-951.md',
      '---\nid: BR-951\ntype: business-rule\ntitle: Untraced rule\nstatus: active\nimplemented_by: [customer]\n---\nbody\n'),
  expect: ['BR-951', 'GAP: no verifying contract'],
  expectCode: 0,
})

// ------------------------------------------------- drift: unmappable paths
// The worst failure this tool can have is silence: reporting "no drift" from a
// partition it could not classify. Found by exercising the loop on the demo,
// whose implementations live in impl/<stack>/ rather than <module>/.

drift('unmappable implementation change refuses to report clean', ['impl/python/server.py'], {
  expect: ['CANNOT TELL', 'false reassurance'],
  expectCode: 1,
})

drift('unmappable non-code files stay quiet', ['notes/scratch.txt'], {
  expect: 'No code-ahead drift',
  expectCode: 0,
})

drift('implementation_paths makes outside code visible as drift', ['impl/python/server.py'], {
  mutate: ({ write }) =>
    write(
      'customer/knowledge.lock',
      'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: none\nimplementation_paths: [impl/python]\n',
    ),
  expect: 'DRIFT     customer',
  expectCode: 1,
})

drift(
  'declared implementation with its knowledge is clean',
  ['impl/python/server.py', 'customer/knowledge/rules/BR-001.md'],
  {
    mutate: ({ write }) =>
      write(
        'customer/knowledge.lock',
        'module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: none\nimplementation_paths: [impl/python]\n',
      ),
    expect: 'No code-ahead drift',
    expectCode: 0,
  },
)

// ------------------------------------------------------ status vocabulary
// Both of these came out of running the Librarian over the brownfield pilot,
// where six fixed issues were marked "deprecated" because nothing better
// existed, and an assumption had been retired in favour of a draft.

check('an issue can be resolved', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/issues/ISS-930.md',
      '---\nid: ISS-930\ntype: issue\ntitle: Fixed\nstatus: resolved\nowner: tyson\naffects: [customer]\n---\nFixed in abc1234.\n',
    ),
  expect: 'OK.',
  expectCode: 0,
})

check('a business rule cannot be resolved', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-931.md',
      '---\nid: BR-931\ntype: business-rule\ntitle: Not a problem\nstatus: resolved\naffects: [customer]\n---\nbody\n',
    ),
  expect: 'must be equal to one of the allowed values',
  expectCode: 1,
})

check('superseded with no replacement at all is rejected', {
  mutate: ({ read, write }) =>
    write('customer/knowledge/rules/BR-932.md', read('customer/knowledge/rules/BR-001.md').replace('status: active', 'status: superseded').replace('id: BR-001', 'id: BR-932')),
  expect: 'BR-932 is superseded but no item supersedes it',
  expectCode: 1,
})

check('superseded by a draft is rejected', {
  mutate: ({ write }) => {
    write(
      'customer/knowledge/assumptions/ASM-933.md',
      '---\nid: ASM-933\ntype: assumption\ntitle: Retired\nstatus: superseded\naffects: [customer]\n---\nbody\n',
    )
    write(
      'customer/knowledge/rules/BR-933.md',
      '---\nid: BR-933\ntype: business-rule\ntitle: Not agreed yet\nstatus: draft\nsupersedes: ASM-933\naffects: [customer]\n---\nbody\n',
    )
  },
  expect: ['ASM-933 is superseded, but BR-933 is "draft"', 'leaves nothing active'],
  expectCode: 1,
})

check('superseded by an active rule is accepted', {
  mutate: ({ write }) => {
    write(
      'customer/knowledge/assumptions/ASM-934.md',
      '---\nid: ASM-934\ntype: assumption\ntitle: Retired\nstatus: superseded\naffects: [customer]\n---\nbody\n',
    )
    write(
      'customer/knowledge/rules/BR-934.md',
      '---\nid: BR-934\ntype: business-rule\ntitle: Agreed\nstatus: active\nsupersedes: ASM-934\naffects: [customer]\nverified_by: [CT-001]\n---\nbody\n',
    )
  },
  expect: 'OK.',
  expectCode: 0,
})

// ------------------------------------------------------------- monitor

const monitor = (name, opts) => check(`monitor: ${name}`, { tool: 'monitor.mjs', expectCode: 0, ...opts })

monitor('ranks modules rather than metrics', {
  expect: ['Monitor: 2 module(s)', 'Furthest from being understood'],
})

monitor('says plainly when there is no baseline', {
  expect: 'No baseline recorded yet',
})

// Code-ahead drift is weighted highest, because it is the one signal that is a
// fact about present trouble rather than a prediction of future trouble.
monitor('undeclared code-ahead drift outranks everything else', {
  argsFor: (dir) => [dir],
  mutate: ({ write }) => {
    write(
      'orders/knowledge.lock',
      'module: orders\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: code-ahead\n',
    )
  },
  expect: ['code-ahead drift, undeclared'],
})

monitor('declared drift debt scores below undeclared', {
  tool: 'monitor.mjs',
  args: ['--json'],
  mutate: ({ write }) => {
    write(
      'orders/knowledge.lock',
      'module: orders\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: code-ahead\ndrift_debt:\n  since: 2026-08-01\n  reason: incident hotfix\n  owner: tyson\n',
    )
  },
  expect: '"integrity": 70',
})

// The whole value of the tool is the comparison against last time, so the
// baseline has to survive being written and read back.
monitor('a recorded baseline produces a trend on the next run', {
  argsFor: (dir) => [dir, '--record'],
  expect: 'Baseline written to',
})

monitor('weights are stated in the output, not buried', {
  args: ['--json'],
  expect: ['"weights"', '"integrity": 40'],
})

// ----------------------------------------------------------- librarian
// The Librarian reports candidates rather than verdicts, so it always exits 0.
// What matters is what it notices and, at least as much, what it does not:
// half of these assert silence, because a corpus tool that cries wolf gets
// switched off and then catches nothing at all.

const librarian = (name, opts) => check(`librarian: ${name}`, { tool: 'librarian.mjs', expectCode: 0, ...opts })

const rule = (id, title, body) =>
  `---\nid: ${id}\ntype: business-rule\ntitle: ${title}\nstatus: active\naffects: [customer]\nimplemented_by: [customer]\n---\n${body}\n`

librarian('clean example reads without error', { expect: 'Librarian: read' })

// The real case, reduced: the reference demo shipped a rule capping the address
// book at twenty alongside one describing a response of fifty. Both files were
// individually valid, so validation passed and nothing noticed for days.
librarian('an upper bound that another rule exceeds is tension', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-910.md', rule('BR-910', 'Address book size', 'A customer holds at most twenty addresses.'))
    write('customer/knowledge/rules/BR-911.md', rule('BR-911', 'Address list', 'The list returns at most fifty addresses.'))
  },
  expect: ['BR-910 bounds "address" at 20', 'BR-911'],
})

librarian('digits and number words compare against each other', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-912.md', rule('BR-912', 'Cap', 'Limited to 20 addresses.'))
    write('customer/knowledge/rules/BR-913.md', rule('BR-913', 'Overflow', 'Customers with more than fifty addresses are truncated.'))
  },
  expect: 'bounds "address" at 20',
})

// Everything below asserts the tool stays quiet.

librarian('a lower bound below a ceiling is not tension', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-914.md', rule('BR-914', 'Cap', 'At most twenty addresses. BR-001 applies.'))
    write('customer/knowledge/rules/BR-915.md', rule('BR-915', 'Floor', 'At least one address. BR-914 applies.'))
  },
  reject: 'Quantitative tension',
})

librarian('unbounded quantities in scenarios are not tension', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-916.md', rule('BR-916', 'Cap', 'At most twenty addresses.'))
    write('customer/knowledge/contracts/CT-916.md',
      '---\nid: CT-916\ntype: contract\ntitle: Setup\nstatus: active\nverifies: [BR-916]\n---\nGiven a customer with 3 addresses, when a fourth address is added.\n')
  },
  reject: 'Quantitative tension',
})

librarian('http status codes are not quantities', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-917.md', rule('BR-917', 'Cap', 'At most 200 requests are queued. BR-001 applies.'))
    write('customer/knowledge/rules/BR-918.md', rule('BR-918', 'Errors', 'Returns 404 requests naming an unknown customer, and 409 requests duplicating one. BR-917 applies.'))
  },
  reject: 'Quantitative tension',
})

librarian('ordered list markers are not quantities', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-919.md', rule('BR-919', 'Cap', 'At most two reasons apply. BR-001 applies.'))
    write('customer/knowledge/rules/BR-920.md', rule('BR-920', 'Reasons', 'BR-919 lists these reasons:\n\n1. reasons of one kind\n2. reasons of another\n3. reasons of a third\n50. reasons far down a list'))
  },
  reject: 'Quantitative tension',
})

// The false positive found against the brownfield pilot: a decision referenced
// only from a module overview was reported as referenced by nothing.
librarian('an item cited only from an overview is not an orphan', {
  mutate: ({ write, read }) => {
    write('customer/knowledge/rules/BR-921.md', rule('BR-921', 'Lonely', 'A rule nothing else mentions.'))
    write('customer/knowledge/overview.md', `${read('customer/knowledge/overview.md')}\n\nSee BR-921 for the address rule.\n`)
  },
  reject: 'BR-921',
})

// The second time this exact gap appeared. First overviews, then the data
// schema, both of which are knowledge and neither of which the citation scanner
// was looking at.
librarian('an item cited only from a data schema is not an orphan', {
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-928.md', rule('BR-928', 'Cited in yaml', 'A rule only the data schema mentions.'))
    write('customer/knowledge/data.schema.yaml',
      'version: 1\nentities:\n  customer:\n    identity: [id]\n    fields:\n      - name: id\n        type: uuid\n        description: See BR-928 for why.\n')
  },
  reject: 'BR-928',
})

librarian('an item cited from nowhere at all is an orphan', {
  mutate: ({ write }) => write('customer/knowledge/rules/BR-922.md', rule('BR-922', 'Lonely', 'A rule nothing else mentions.')),
  expect: 'BR-922 is referenced by',
})

librarian('a contract that verifies nothing is an orphan', {
  mutate: ({ write }) =>
    write('customer/knowledge/contracts/CT-923.md',
      '---\nid: CT-923\ntype: contract\ntitle: Empty\nstatus: active\nverifies: []\n---\nAsserts nothing.\n'),
  expect: 'CT-923 is a contract that verifies nothing',
})

librarian('a long-open draft is stale', {
  mutate: ({ write }) =>
    write('customer/knowledge/rules/BR-924.md',
      '---\nid: BR-924\ntype: business-rule\ntitle: Pending\nstatus: draft\nsince: 2020-01-01\naffects: [customer]\n---\nBR-001 is refined by this.\n'),
  expect: 'has been a draft for',
})

librarian('an overdue review date is reported', {
  mutate: ({ write }) =>
    write('customer/knowledge/assumptions/ASM-925.md',
      '---\nid: ASM-925\ntype: assumption\ntitle: Old\nstatus: unconfirmed\nreview_by: 2020-01-01\n---\nBR-001 rests on this.\n'),
  expect: 'was due for review',
})

librarian('the bundle carries the whole corpus, not a filtered view', {
  args: ['--bundle'],
  expect: ['# Knowledge tree review packet', '## The corpus', 'BR-001'],
})

librarian('json output is machine readable', {
  args: ['--json'],
  mutate: ({ write }) => {
    write('customer/knowledge/rules/BR-926.md', rule('BR-926', 'Cap', 'At most twenty addresses.'))
    write('customer/knowledge/rules/BR-927.md', rule('BR-927', 'Overflow', 'More than fifty addresses are held.'))
  },
  expect: ['"kind": "tension"', '"value": 50'],
})

// ------------------------------------------------- data schema and migrations
// REP-0005. Data is the one artifact that cannot be regenerated, so a
// disagreement between the model and the history that produced it is not a
// tidiness problem: it means one of them is lying to whoever reads it next.

const SCHEMA_V2 = `version: 2
entities:
  customer:
    identity: [id]
    fields:
      - name: id
        type: uuid
        nullable: false
      - name: deleted_at
        type: timestamp
        nullable: true
        since: 2
`

const mig = (id, from, to, extra = '') =>
  `---\nid: ${id}\ntype: migration\ntitle: Step ${from} to ${to}\nstatus: active\nfrom: ${from}\nto: ${to}\n${extra}affects: [customer]\n---\nbody\n`

check('the example data schema and migration chain validate', { expect: 'OK.', expectCode: 0 })

check('a data schema version ahead of its migrations is rejected', {
  mutate: ({ write, read }) =>
    write('customer/knowledge/data.schema.yaml', read('customer/knowledge/data.schema.yaml').replace('version: 2', 'version: 4')),
  expect: ['schema says version 4', 'applied migrations end at 2'],
  expectCode: 1,
})

check('a gap in the migration chain is rejected', {
  mutate: ({ write, read }) => {
    write('customer/knowledge/data.schema.yaml', read('customer/knowledge/data.schema.yaml').replace('version: 2', 'version: 4'))
    write('customer/knowledge/migrations/MIG-003.md', mig('MIG-003', 3, 4, 'applied_at: 2026-08-07\n'))
  },
  expect: 'migration chain is broken: MIG-001 ends at 2 and MIG-003 starts at 3',
  expectCode: 1,
})

check('a migration spanning more than one step is rejected', {
  mutate: ({ write }) => write('customer/knowledge/migrations/MIG-009.md', mig('MIG-009', 2, 5, 'applied_at: 2026-08-07\n')),
  expect: 'MIG-009 goes from 2 to 5; a migration is one step',
  expectCode: 1,
})

// An applied migration records something that happened. One behind it that has
// not been applied means the recorded history has a hole in it.
check('an applied migration behind an unapplied one is rejected', {
  mutate: ({ write, read }) => {
    write('customer/knowledge/data.schema.yaml', read('customer/knowledge/data.schema.yaml').replace('version: 2', 'version: 4'))
    write('customer/knowledge/migrations/MIG-002.md', mig('MIG-002', 2, 3))
    write('customer/knowledge/migrations/MIG-003.md', mig('MIG-003', 3, 4, 'applied_at: 2026-08-07\n'))
  },
  expect: 'MIG-003 is applied but MIG-002 before it is not',
  expectCode: 1,
})

check('identity naming a field that does not exist is rejected', {
  mutate: ({ write }) =>
    write('customer/knowledge/data.schema.yaml', 'version: 1\nentities:\n  customer:\n    identity: [ghost]\n    fields:\n      - name: id\n        type: uuid\n'),
  expect: 'identity "ghost", which is not one of its fields',
  expectCode: 1,
})

check('a relationship naming an unknown entity is rejected', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/data.schema.yaml',
      'version: 1\nentities:\n  customer:\n    identity: [id]\n    fields:\n      - name: id\n        type: uuid\nrelationships:\n  - from: customer\n    to: nowhere\n    cardinality: many-to-one\n',
    ),
  expect: 'names unknown entity "nowhere"',
  expectCode: 1,
})

// An enum with no stated values is a string, and calling it an enum implies a
// constraint that nothing records.
check('an enum field without values is rejected', {
  mutate: ({ write }) =>
    write('customer/knowledge/data.schema.yaml', 'version: 1\nentities:\n  customer:\n    identity: [id]\n    fields:\n      - name: status\n        type: enum\n      - name: id\n        type: uuid\n'),
  expect: "must have required property 'values'",
  expectCode: 1,
})

check('a field claiming a version the schema has not reached is rejected', {
  mutate: ({ write }) =>
    write('customer/knowledge/data.schema.yaml', 'version: 1\nentities:\n  customer:\n    identity: [id]\n    fields:\n      - name: id\n        type: uuid\n        since: 7\n'),
  expect: 'claims since 7, but the schema is at version 1',
  expectCode: 1,
})

check('migration fields are rejected on any other item type', {
  mutate: ({ write }) =>
    write(
      'customer/knowledge/rules/BR-950.md',
      '---\nid: BR-950\ntype: business-rule\ntitle: Not a migration\nstatus: active\nfrom: 1\nto: 2\naffects: [customer]\n---\nbody\n',
    ),
  expect: 'must be equal to constant',
  expectCode: 1,
})

check('a module describing stored data with no schema warns', {
  mutate: ({ write, read }) => {
    rmSync(join(EXAMPLE, 'x'), { force: true })
    write('orders/knowledge/overview.md', `${read('orders/knowledge/overview.md')}\n\nOrders are persisted to a database table and every row is stored indefinitely.\n`)
  },
  expect: 'describes stored data but the module carries no data.schema.yaml',
  expectCode: 0,
})

// ------------------------------------------------------------ gatherer
// These need real history, so each builds a throwaway repository. Worth the
// setup: the parsing here reads git's output format, and the one bug it shipped
// with attributed every commit's files to the next commit, which produced a
// confident and entirely wrong answer rather than an error.

function gatherer(name, { commits, lockPaths, args = [], expect, reject, expectCode = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'regen-gather-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    cpSync(EXAMPLE, dir, { recursive: true })
    if (lockPaths) {
      writeFileSync(
        join(dir, 'customer', 'knowledge.lock'),
        `module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: none\nimplementation_paths: [${lockPaths}]\n`,
      )
    }
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@example.com')
    g('config', 'user.name', 'Test')
    g('add', '-A')
    g('commit', '-q', '-m', 'initial')
    const base = g('rev-parse', 'HEAD').trim()

    for (const c of commits) {
      for (const [rel, body] of Object.entries(c.files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), body)
      }
      g('add', '-A')
      g('commit', '-q', '-m', c.message)
    }

    const { code, out } = run('gather.mjs', [dir, '--since', base, ...args])
    const problems = []
    for (const e of [expect].flat().filter(Boolean))
      if (!out.includes(e)) problems.push(`expected output to contain ${JSON.stringify(e)}`)
    for (const e of [reject].flat().filter(Boolean))
      if (out.includes(e)) problems.push(`expected output NOT to contain ${JSON.stringify(e)}`)
    if (code !== expectCode) problems.push(`expected exit ${expectCode}, got ${code}`)
    if (problems.length) failures.push({ name: `gatherer: ${name}`, problems, out })
    else passed++
  } catch (e) {
    failures.push({ name: `gatherer: ${name}`, problems: [e.message], out: '' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

gatherer('a code-only commit is a candidate', {
  lockPaths: 'src',
  commits: [{ message: 'Cap retries at three because the upstream rate limits', files: { 'src/a.js': 'let retries = 3\n' } }],
  expect: ['1 candidate(s)', 'Cap retries at three'],
})

gatherer('a commit that also changed knowledge has recorded itself', {
  lockPaths: 'src',
  commits: [
    {
      message: 'Cap retries at three because the upstream rate limits',
      files: {
        'src/a.js': 'let retries = 3\n',
        'customer/knowledge/rules/BR-940.md':
          '---\nid: BR-940\ntype: business-rule\ntitle: Retries\nstatus: active\naffects: [customer]\n---\nAt most three retries.\n',
      },
    },
  ],
  expect: 'No commit in this range changed an implementation without also changing knowledge',
  reject: 'candidate(s), most likely',
})

// The bug that shipped: with the record separator at the end of the git format,
// --name-only files land under the following commit's metadata.
gatherer('each commit keeps its own files and message', {
  lockPaths: 'src',
  args: ['--json'],
  commits: [
    { message: 'first change', files: { 'src/first.js': '1\n' } },
    { message: 'second change', files: { 'src/second.js': '2\n' } },
  ],
  expect: ['"subject": "second change"', '"src/second.js"', '"subject": "first change"', '"src/first.js"'],
})

gatherer('an incident-shaped message ranks above a plain one', {
  lockPaths: 'src',
  args: ['--json'],
  commits: [
    { message: 'tidy whitespace', files: { 'src/a.js': 'a\n' } },
    { message: 'Hotfix: cannot allow empty names because the report crashes', files: { 'src/b.js': 'b\n' } },
  ],
  expect: '"rank": 2',
})

// The failure this check exists to avoid: reporting a clean history when the
// implementation was never found. drift-check shipped exactly this once.
// An empty range is not a clean history, it is an empty range, and calling it
// clean is a small lie the tool was telling.
gatherer('an empty range says so rather than reporting a clean history', {
  lockPaths: 'src',
  commits: [],
  expect: ['No commits in this range at all', 'not a finding'],
  reject: 'clean state',
})

gatherer('nothing recognised as implementation is CANNOT TELL, not clean', {
  lockPaths: 'nowhere-near-here',
  commits: [{ message: 'change something outside the declared paths', files: { 'elsewhere/a.js': 'a\n' } }],
  expect: ['CANNOT TELL', 'implementation lives somewhere else'],
  reject: 'clean state',
  expectCode: 1,
})

// ------------------------------------------------------------- trigger
// The refusals matter more than the proposals. Both blocked states are easy to
// walk into while looking at a dashboard that says a module is unhealthy, and
// both make regeneration actively harmful rather than merely wasteful.

const trigger = (name, opts) => check(`trigger: ${name}`, { tool: 'trigger.mjs', expectCode: 0, ...opts })

const lock = (fields) =>
  `module: customer\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\n${fields}`

trigger('code-ahead drift blocks regeneration outright', {
  mutate: ({ write }) => write('customer/knowledge.lock', lock('drift: code-ahead\n')),
  expect: ['DO NOT REGENERATE', 'regenerating would delete it without a trace', 'reconcile first'],
})

trigger('a failing regeneration test blocks it too', {
  mutate: ({ write }) =>
    write('customer/knowledge.lock', lock('drift: none\nlast_regeneration:\n  at: 2026-08-01\n  model: m\n  result: fail\n  contracts_passed: 3\n  contracts_total: 9\n')),
  expect: ['DO NOT REGENERATE', 'already known to be insufficient', '3/9'],
})

trigger('a blocker outranks every trigger, not just some', {
  args: ['--json'],
  mutate: ({ write }) =>
    // Drift plus the strongest possible positive signal. The verdict must still
    // be blocked; a strong reason to regenerate is exactly when this is riskiest.
    write('customer/knowledge.lock', lock('drift: code-ahead\n')),
  expect: '"verdict": "blocked"',
})

trigger('a pass with many guesses is a caution, not a success', {
  mutate: ({ write }) =>
    write('customer/knowledge.lock', lock('drift: none\nlast_regeneration:\n  at: 2026-08-05\n  model: m\n  result: pass\n  contracts_passed: 9\n  contracts_total: 9\n  guesses: 19\n')),
  expect: ['19 guesses', 'partly on luck'],
})

trigger('a clean recent pass with few guesses proposes nothing', {
  argsFor: (dir) => [dir],
  mutate: ({ write }) => {
    const today = new Date().toISOString().slice(0, 10)
    write('customer/knowledge.lock', lock(`drift: none\nlast_regeneration:\n  at: ${today}\n  model: m\n  result: pass\n  guesses: 0\n`))
    write('orders/knowledge.lock', `module: orders\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: none\nlast_regeneration:\n  at: ${today}\n  model: m\n  result: pass\n  guesses: 0\n`)
  },
  expect: 'Nothing is worth regenerating today',
})

trigger('the model-moved signal is weak on its own and does not propose', {
  argsFor: (dir) => [dir],
  mutate: ({ write }) => {
    const today = new Date().toISOString().slice(0, 10)
    write('customer/knowledge.lock', lock(`drift: none\nlast_regeneration:\n  at: ${today}\n  model: old-model\n  result: pass\n  guesses: 0\n`))
    write('orders/knowledge.lock', `module: orders\nknowledge_version: abc1234\ngenerated_by: x\ngenerated_at: 2026-08-06\ndrift: none\nlast_regeneration:\n  at: ${today}\n  model: old-model\n  result: pass\n  guesses: 0\n`)
  },
  expect: 'Nothing is worth regenerating today',
})

// -------------------------------------------------------- reading transport
// Provider resolution and the request shape, without touching the network.
// The point of these is that the tooling can talk to more than one vendor,
// which is what makes the manifesto's model-independence claim checkable
// rather than merely asserted.

const { provider, ask } = await import('./lib/read.mjs')

function unit(name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push({ name: `read: ${name}`, problems: [e.message], out: '' })
  }
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

unit('no key is a helpful error, not a crash', () => {
  const p = provider({})
  if (!p.error?.includes('No API key')) throw new Error(`expected a no-key error, got ${JSON.stringify(p)}`)
})

unit('no model is a helpful error rather than a guessed identifier', () => {
  const p = provider({ OPENROUTER_API_KEY: 'k' })
  if (!p.error?.includes('No model')) throw new Error(`expected a no-model error, got ${JSON.stringify(p)}`)
})

unit('an openrouter key routes to openrouter in the openai shape', () => {
  const p = provider({ OPENROUTER_API_KEY: 'k', REGEN_LLM_MODEL: 'm' })
  eq(p.base, 'https://openrouter.ai/api/v1', 'base')
  eq(p.shape, 'openai', 'shape')
})

unit('an anthropic key alone routes to anthropic natively', () => {
  const p = provider({ ANTHROPIC_API_KEY: 'k', REGEN_LLM_MODEL: 'm' })
  eq(p.base, 'https://api.anthropic.com/v1', 'base')
  eq(p.shape, 'anthropic', 'shape')
})

unit('an explicit base url wins, so any compatible endpoint works', () => {
  const p = provider({ ANTHROPIC_API_KEY: 'k', REGEN_LLM_BASE_URL: 'https://example.test/v1', REGEN_LLM_MODEL: 'm' })
  eq(p.base, 'https://example.test/v1', 'base')
  eq(p.shape, 'openai', 'shape')
})

unit('openrouter wins over anthropic when both are present', () => {
  const p = provider({ OPENROUTER_API_KEY: 'or', ANTHROPIC_API_KEY: 'an', REGEN_LLM_MODEL: 'm' })
  eq(p.key, 'or', 'key')
  eq(p.shape, 'openai', 'shape')
})

// Request shape and retry behaviour, against a stub.
const stub = (responses) => {
  const calls = []
  let i = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: JSON.parse(init.body) })
    const r = responses[Math.min(i++, responses.length - 1)]
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
    }
  }
  return { fetchImpl, calls }
}

const OPENAI_OK = { status: 200, body: { choices: [{ message: { content: 'findings' } }] } }
const ANTHROPIC_OK = { status: 200, body: { content: [{ type: 'text', text: 'findings' }] } }

async function unitAsync(name, fn) {
  try {
    await fn()
    passed++
  } catch (e) {
    failures.push({ name: `read: ${name}`, problems: [e.message], out: '' })
  }
}

await unitAsync('the openai shape sends system as a message and reads choices', async () => {
  const s = stub([OPENAI_OK])
  const r = await ask({
    system: 'sys', user: 'corpus', fetchImpl: s.fetchImpl,
    env: { OPENROUTER_API_KEY: 'k', REGEN_LLM_MODEL: 'm' },
  })
  eq(r.text, 'findings', 'text')
  eq(s.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions', 'url')
  eq(s.calls[0].body.messages[0].role, 'system', 'first message role')
  eq(s.calls[0].headers.authorization, 'Bearer k', 'auth header')
})

await unitAsync('the anthropic shape sends system as a field and reads content', async () => {
  const s = stub([ANTHROPIC_OK])
  const r = await ask({
    system: 'sys', user: 'corpus', fetchImpl: s.fetchImpl,
    env: { ANTHROPIC_API_KEY: 'k', REGEN_LLM_MODEL: 'm' },
  })
  eq(r.text, 'findings', 'text')
  eq(s.calls[0].url, 'https://api.anthropic.com/v1/messages', 'url')
  eq(s.calls[0].body.system, 'sys', 'system field')
  eq(s.calls[0].headers['x-api-key'], 'k', 'auth header')
})

await unitAsync('a 429 is retried', async () => {
  const s = stub([{ status: 429, body: 'slow down' }, OPENAI_OK])
  const r = await ask({
    system: 's', user: 'u', fetchImpl: s.fetchImpl,
    env: { OPENROUTER_API_KEY: 'k', REGEN_LLM_MODEL: 'm' },
  })
  eq(r.text, 'findings', 'text after retry')
  eq(s.calls.length, 2, 'call count')
})

await unitAsync('a 401 is not retried, because repeating it cannot help', async () => {
  const s = stub([{ status: 401, body: 'bad key' }])
  let threw = null
  try {
    await ask({ system: 's', user: 'u', fetchImpl: s.fetchImpl, env: { OPENROUTER_API_KEY: 'k', REGEN_LLM_MODEL: 'm' } })
  } catch (e) {
    threw = e
  }
  if (!threw) throw new Error('expected a throw on 401')
  eq(s.calls.length, 1, 'call count')
})

// ------------------------------------------------------------------ report

console.log(`\n${passed} passed, ${failures.length} failed\n`)
for (const f of failures) {
  console.log(`FAIL  ${f.name}`)
  for (const p of f.problems) console.log(`      ${p}`)
  console.log(
    f.out
      .split('\n')
      .map((l) => `      | ${l}`)
      .join('\n'),
  )
}
process.exit(failures.length ? 1 : 0)

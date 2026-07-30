#!/usr/bin/env node
// Tests for the reference tooling.
//
// A validator that only ever says OK is worthless, so most of these are
// negative: each one breaks the example tree in a specific way and asserts the
// tools notice. Run with `npm test`.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
function check(name, { mutate, tool = 'validate.mjs', args = [], argsFor, expect, expectCode }) {
  const dir = mkdtempSync(join(tmpdir(), 'regen-test-'))
  try {
    cpSync(EXAMPLE, dir, { recursive: true })
    mutate?.({
      write: (rel, body) => writeFileSync(join(dir, rel), body),
      read: (rel) => readFileSync(join(dir, rel), 'utf8'),
      remove: (rel) => rmSync(join(dir, rel), { recursive: true, force: true }),
    })
    const { code, out } = run(tool, argsFor ? argsFor(dir) : [...args, dir])
    const problems = []
    for (const e of [expect].flat().filter(Boolean))
      if (!out.includes(e)) problems.push(`expected output to contain ${JSON.stringify(e)}`)
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

#!/usr/bin/env node
// Detect code-ahead drift: implementation changed without its knowledge changing.
//
//   node tools/drift.mjs [tree] --base main
//   node tools/drift.mjs --tree example --changed a.ts b.md
//   node tools/drift.mjs --base main --json
//
// `--changed` consumes every remaining argument, so give the tree with --tree
// (or as the first positional) when using it.
//
// The rule is structural, not semantic. If a change touches a module's
// non-knowledge files and contains no corresponding change to that module's
// knowledge, that is code-ahead drift. No understanding of the code is needed,
// only the observation that a build artifact changed while its source did not.
//
// This over-reports by design: a pure refactor trips it too. Judging whether a
// change is behavioural is human (or agent) work, and the escape hatch is an
// explicit drift_debt block in the module's lock file.

import { execFileSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import { loadTree } from './lib/load.mjs'

// `--changed` is greedy, so everything before it is parsed first and everything
// after it is a file path.
const raw = process.argv.slice(2)
const changedIdx = raw.indexOf('--changed')
const head = changedIdx === -1 ? raw : raw.slice(0, changedIdx)
const tail = changedIdx === -1 ? [] : raw.slice(changedIdx + 1)

const json = head.includes('--json')
const opt = (name) => {
  const i = head.indexOf(name)
  return i === -1 ? undefined : head[i + 1]
}
const positional = head.filter((a, i) => !a.startsWith('--') && head[i - 1] !== '--base' && head[i - 1] !== '--tree')

const tree = loadTree(opt('--tree') ?? positional[0] ?? process.env.REGEN_TREE ?? '.')

// ---------------------------------------------------------------- changed set

let changed = []
if (changedIdx !== -1) {
  changed = tail
} else {
  const base = opt('--base') ?? 'origin/main'
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: tree.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    changed = out.split('\n').filter(Boolean)
  } catch (e) {
    console.error(`Could not diff against ${base}. Pass --changed <files> instead, or fetch the base ref.`)
    console.error(String(e.stderr ?? e.message).trim())
    process.exit(2)
  }
}

// Paths from git are relative to the repo root, which may differ from the tree.
const treeRel = relative(process.cwd(), tree.root)
const intoTree = (p) => (treeRel && p.startsWith(`${treeRel}${sep}`) ? p.slice(treeRel.length + 1) : p)

// ---------------------------------------------------------------- partition

const state = new Map() // module -> { knowledge: [], code: [] }
const touch = (m, kind, path) => {
  if (!state.has(m)) state.set(m, { knowledge: [], code: [] })
  state.get(m)[kind].push(path)
}

const IGNORE = /(^|\/)(\.github|node_modules|dist|coverage|\.astro)\//
const META = /(^|\/)(README|LICENSE|CHANGELOG)(\.md)?$|(^|\/)(package(-lock)?\.json|\.gitignore)$/i

for (const raw of changed) {
  const path = intoTree(raw)
  if (IGNORE.test(path) || META.test(path)) continue

  const parts = path.split(sep)
  const k = parts.indexOf('knowledge')

  if (k === 0) continue // global knowledge, owned by no module
  if (k > 0) {
    touch(parts[k - 1], 'knowledge', path)
    continue
  }
  // knowledge.lock sits beside the knowledge directory, not inside it.
  if (parts.length >= 2 && parts[parts.length - 1] === 'knowledge.lock') {
    touch(parts[parts.length - 2], 'knowledge', path)
    continue
  }
  if (tree.modules.has(parts[0])) touch(parts[0], 'code', path)
}

// ---------------------------------------------------------------- verdict

const findings = []
for (const [module, { knowledge, code }] of [...state].sort()) {
  if (!code.length) continue
  if (knowledge.length) continue // knowledge moved with the code, no drift

  const lock = tree.locks.get(module)
  const debt = lock?.data?.drift_debt
  findings.push({
    module,
    code,
    accepted: Boolean(debt),
    debt: debt ?? null,
  })
}

const blocking = findings.filter((f) => !f.accepted)

if (json) {
  console.log(JSON.stringify({ findings, blocking: blocking.length, changed: changed.length }, null, 2))
  process.exit(blocking.length ? 1 : 0)
}

console.log(`Drift check  ${tree.root}`)
console.log(`${changed.length} changed file(s), ${state.size} module(s) touched`)
console.log()

if (!findings.length) {
  console.log('No code-ahead drift. Every module with implementation changes also changed its knowledge.')
  process.exit(0)
}

for (const f of findings) {
  if (f.accepted) {
    console.log(`ACCEPTED  ${f.module}: code-ahead, declared as drift debt`)
    console.log(`          since ${f.debt.since}, ${f.debt.reason}`)
    if (f.debt.reconciliation_task) console.log(`          reconciliation: ${f.debt.reconciliation_task}`)
  } else {
    console.log(`DRIFT     ${f.module}: implementation changed, knowledge did not`)
    for (const p of f.code.slice(0, 8)) console.log(`          ${p}`)
    if (f.code.length > 8) console.log(`          ... and ${f.code.length - 8} more`)
  }
  console.log()
}

if (blocking.length) {
  console.log(`FAILED: ${blocking.length} module(s) with code-ahead drift.`)
  console.log()
  console.log('Choose one per module:')
  console.log('  1. Reconcile. Write the knowledge delta describing what the code now does. Usually correct.')
  console.log('  2. Revert, if the change was not meant to alter behaviour.')
  console.log('  3. Accept as drift debt, for genuine emergencies, by adding to the module knowledge.lock:')
  console.log('       drift: code-ahead')
  console.log('       drift_debt:')
  console.log('         since: YYYY-MM-DD')
  console.log('         reason: what happened')
  console.log('         reconciliation_task: TICKET-123')
  console.log()
  console.log('A pure refactor with no observable behaviour change is not drift. If that is the case,')
  console.log('option 3 with reason "refactor, no behaviour change" is the honest record.')
  process.exit(1)
}
process.exit(0)

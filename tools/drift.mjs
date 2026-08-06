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
import { loadTree, locksFor, LOCK_PATTERN } from './lib/load.mjs'

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

const unmapped = []
const IGNORE = /(^|\/)(\.github|node_modules|dist|coverage|\.astro)\//
const META = /(^|\/)(README|LICENSE|CHANGELOG)(\.md)?$|(^|\/)(package(-lock)?\.json|\.gitignore)$/i

// Modules may declare where their implementation lives when it is not under
// the module directory (REP-0002 era lock field).
const declared = []
for (const lock of tree.locks.values())
  for (const prefix of lock.data?.implementation_paths ?? [])
    declared.push({ module: lock.module, prefix: prefix.replace(/\/+$/, '') })

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
  // Lock files sit beside the knowledge directory, not inside it, and may be
  // per-stack (knowledge.python.lock).
  if (parts.length >= 2 && LOCK_PATTERN.test(parts[parts.length - 1])) {
    touch(parts[parts.length - 2], 'knowledge', path)
    continue
  }
  if (tree.modules.has(parts[0])) {
    touch(parts[0], 'code', path)
    continue
  }

  const owner = declared.find((d) => path === d.prefix || path.startsWith(`${d.prefix}/`))
  if (owner) {
    touch(owner.module, 'code', path)
    continue
  }

  // A changed file we cannot attribute to a module. Silence here is the worst
  // possible behaviour: it produces a clean report from an empty partition,
  // which reads as "no drift" when it means "I could not tell". Observed on the
  // reference demo, whose implementations live in impl/<stack>/ rather than
  // <module>/, so drift detection had never examined them at all.
  unmapped.push(path)
}

// ---------------------------------------------------------------- verdict

const findings = []
for (const [module, { knowledge, code }] of [...state].sort()) {
  if (!code.length) continue
  if (knowledge.length) continue // knowledge moved with the code, no drift

  // With several stacks, any declared drift debt covers the module.
  const debt = locksFor(module, tree).map((l) => l.data?.drift_debt).find(Boolean)
  findings.push({
    module,
    code,
    accepted: Boolean(debt),
    debt: debt ?? null,
  })
}

// Unattributable code changes are reported before any verdict, because a
// verdict computed from files we could not classify is not a verdict.
const IMPL_HINT = /(^|\/)(impl|src|lib|app|server|api)(\/|$)|\.(ts|js|mjs|py|go|rb|java|rs|php)$/
const unmappedCode = unmapped.filter((p) => IMPL_HINT.test(p))

const blocking = findings.filter((f) => !f.accepted)

if (json) {
  console.log(
    JSON.stringify({ findings, blocking: blocking.length, changed: changed.length, unmapped: unmappedCode }, null, 2),
  )
  process.exit(blocking.length || unmappedCode.length ? 1 : 0)
}

console.log(`Drift check  ${tree.root}`)
console.log(`${changed.length} changed file(s), ${state.size} module(s) touched`)
console.log()

if (unmappedCode.length) {
  console.log(`CANNOT TELL: ${unmappedCode.length} changed file(s) belong to no module, so drift was not assessed for them:`)
  for (const p of unmappedCode.slice(0, 10)) console.log(`          ${p}`)
  if (unmappedCode.length > 10) console.log(`          ... and ${unmappedCode.length - 10} more`)
  console.log()
  console.log('A module is a directory containing knowledge/. Implementations outside one are invisible')
  console.log('to this check. Either move them under the module, or map them with implementation_paths')
  console.log('in the module lock. Reporting "no drift" here would be a false reassurance.')
  console.log()
}

if (!findings.length && !unmappedCode.length) {
  console.log('No code-ahead drift. Every module with implementation changes also changed its knowledge.')
  process.exit(unmappedCode.length ? 1 : 0)
}

if (!findings.length) process.exit(1)

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

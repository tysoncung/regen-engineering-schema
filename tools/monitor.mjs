#!/usr/bin/env node
// The Monitor: which module is furthest from being understood, and which is
// getting worse fastest.
//
//   node tools/monitor.mjs [tree] [--json] [--record] [--baseline <file>]
//
// The debt report answers "how healthy is this tree right now", per metric,
// across the whole tree. That is the wrong shape for deciding what to do next,
// for two reasons.
//
// It is **per metric, not per module**. Freshness at 50% does not tell you which
// module to open. Work happens on modules, so the ranking has to be by module.
//
// It has **no memory**. A module at 60% that was at 90% last month is in trouble;
// a module at 60% that was at 30% is being fixed. The number is identical and the
// correct response is opposite. REP-0006 asks for decay signals, and decay is a
// derivative: you cannot see it in a snapshot.
//
// So this consumes `debt.mjs --json` rather than recomputing anything, which
// means the two can never disagree about the facts, only about presentation.
// Same principle as the shared loader.
//
// Output is a ranked list, never a verdict. Deciding whether a decaying module
// is worth regenerating is the Trigger's job, and it needs judgement about cost
// that no script has.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTree } from './lib/load.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const json = argv.includes('--json')
const record = argv.includes('--record')
// indexOf returns -1 when the flag is absent, and argv[-1 + 1] is the first
// positional argument, so a naive lookup silently treats the tree path as the
// baseline file and then tries to write over the directory.
const baselineIdx = argv.indexOf('--baseline')
const baselineArg = baselineIdx === -1 ? null : argv[baselineIdx + 1]
const treeArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--baseline')
const tree = resolve(treeArg ?? process.env.REGEN_TREE ?? 'example')

// debt.mjs exits non-zero when it finds code-ahead drift, because it is
// designed as a CI gate. execFileSync throws on that, which would crash the
// Monitor in exactly the case its highest-weighted signal is present, so the
// exit status is deliberately ignored and only the output is read.
let debtRaw
try {
  debtRaw = execFileSync('node', [join(HERE, 'debt.mjs'), tree, '--json'], { encoding: 'utf8' })
} catch (e) {
  if (e.stdout === undefined) throw e
  debtRaw = e.stdout
}
const debt = JSON.parse(debtRaw)

const baseline = baselineArg ?? join(tree, '.regen', 'monitor.json')

// ------------------------------------------------------------------ scoring
//
// Decay per module, 0 clean to 100 furthest from being understood. The weights
// are a judgement and are stated here rather than buried, because the ranking is
// only as defensible as they are.
//
// Integrity dominates because code-ahead drift means the knowledge is already
// known to be wrong: everything else is a prediction of future trouble, and that
// is a fact about present trouble. Regenerability comes next because it is the
// only signal that tests the central claim rather than a proxy for it. Coverage
// is structural and cheap to fix. Traceability and freshness are real but
// recoverable.
//
// These are open to argument. If a signal never changes a ranking, it should be
// dropped rather than defended.
const WEIGHTS = {
  integrity: 40,
  regenerability: 25,
  coverage: 15,
  traceability: 12,
  freshness: 8,
}

// Freshness and regenerability are reported per stack, as "cmdb (python)",
// because one module can have several implementations at different ages. The
// ranking is per module, so those collapse, taking the worst stack's result:
// a module is only as regenerable as its weakest implementation.
const moduleOf = (s) => String(s).replace(/\s*\([^)]*\)\s*$/, '').split(':')[0].trim()

const modules = new Set(debt.coverage.detail.map((d) => d.module))
for (const d of debt.freshness.detail) modules.add(moduleOf(d.module))

const byModule = new Map(
  [...modules].map((m) => [m, { module: m, signals: {}, reasons: [] }]),
)

for (const d of debt.coverage.detail) {
  const e = byModule.get(d.module)
  e.signals.coverage = d.complete ? 0 : 100
  if (!d.complete) e.reasons.push(`incomplete knowledge package: ${d.missing.join(', ')}`)
}

for (const d of debt.freshness.detail) {
  const e = byModule.get(moduleOf(d.module))
  if (!e) continue
  // no-lock is worse than stale: a stale module at least records what produced it.
  const score = d.state === 'current' ? 0 : d.state === 'no-lock' ? 100 : 60
  e.signals.freshness = Math.max(e.signals.freshness ?? 0, score)
  if (d.state !== 'current') e.reasons.push(`${d.module}: ${d.state}${d.evidence ? `, ${d.evidence}` : ''}`)
}

for (const d of debt.integrity.detail) {
  const e = byModule.get(moduleOf(d.module))
  if (!e) continue
  // Declared drift debt is a deliberate, dated decision. Undeclared drift is
  // the same defect with nobody's name on it, so it scores worse.
  e.signals.integrity = d.debt ? 70 : 100
  e.reasons.push(d.debt ? `code-ahead drift, declared since ${d.debt.since}` : 'code-ahead drift, undeclared')
}

for (const d of debt.regenerability.detail) {
  const e = byModule.get(moduleOf(d.target))
  if (!e) continue
  const score =
    d.state === 'current' ? 0 : d.state === 'failing' ? 100 : d.state === 'unknown' ? 70 : 50
  // A module with several stacks takes its worst stack's result.
  e.signals.regenerability = Math.max(e.signals.regenerability ?? 0, score)
  const who = d.target === e.module ? '' : `${d.target}: `
  if (d.state === 'failing') e.reasons.push(`${who}regeneration test FAILING as of ${d.age}d ago`)
  else if (d.state === 'unknown') e.reasons.push(`${who}never regenerated, so regenerability is believed rather than known`)
  else if (d.state === 'stale') e.reasons.push(`${who}last regenerated ${d.age}d ago, past the ${debt.regenerability.staleDays}d threshold`)
}

// Traceability is per rule, so it has to be attributed back to the modules the
// rule affects. A rule with no verifying contract is unverified everywhere it
// applies, not in one place.
for (const e of byModule.values()) e.signals.traceability = 0
if (debt.traceability.total > 0) {
  // A rule with no verifying contract is unverified everywhere it applies, so
  // it has to be attributed to each module it affects rather than to the tree.
  const items = loadTree(tree).items
  const perModule = new Map([...modules].map((m) => [m, { bad: 0, total: 0 }]))
  for (const t of debt.traceability.detail) {
    const item = items.get(t.id)
    const affected = [...new Set([...(item?.data.affects ?? []), ...(item?.data.implemented_by ?? [])])]
    // A rule naming no module constrains the whole tree, so it counts everywhere.
    for (const m of affected.length ? affected : [...modules]) {
      const c = perModule.get(m)
      if (!c) continue
      c.total++
      if (!t.ok) c.bad++
    }
  }
  for (const [m, c] of perModule) {
    if (!c.total) continue
    const e = byModule.get(m)
    e.signals.traceability = Math.round((c.bad / c.total) * 100)
    if (c.bad) e.reasons.push(`${c.bad} of ${c.total} active rule(s) unverified or unimplemented`)
  }
}

for (const e of byModule.values()) {
  let total = 0
  for (const [k, w] of Object.entries(WEIGHTS)) total += ((e.signals[k] ?? 0) / 100) * w
  e.decay = Math.round(total)
}

// ------------------------------------------------------------------ trend

let previous = null
if (existsSync(baseline)) {
  try {
    previous = JSON.parse(readFileSync(baseline, 'utf8'))
  } catch {
    previous = null
  }
}

const prevByModule = new Map((previous?.modules ?? []).map((m) => [m.module, m]))
for (const e of byModule.values()) {
  const p = prevByModule.get(e.module)
  e.previous = p ? p.decay : null
  e.delta = p ? e.decay - p.decay : null
}

const ranked = [...byModule.values()].sort((a, b) => b.decay - a.decay || a.module.localeCompare(b.module))
const result = {
  tree,
  weights: WEIGHTS,
  since: previous?.recorded ?? null,
  modules: ranked.map(({ module, decay, delta, previous: prev, signals, reasons }) => ({
    module, decay, delta, previous: prev, signals, reasons,
  })),
}

if (record) {
  // Deliberately no timestamp from the clock in the payload beyond this, and
  // deliberately checked in: the whole value is the comparison against last
  // time, so the baseline has to survive a fresh CI runner.
  mkdirSync(dirname(baseline), { recursive: true })
  writeFileSync(
    baseline,
    `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), modules: result.modules }, null, 2)}\n`,
  )
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const arrow = (d) => (d === null ? '  new' : d > 0 ? `+${d} worse` : d < 0 ? `${d} better` : '   flat')
const bar = (n) => '#'.repeat(Math.round(n / 5)).padEnd(20, '.')

console.log(`Monitor: ${ranked.length} module(s) in ${tree}`)
console.log(previous ? `Compared against the baseline recorded ${previous.recorded}.` : 'No baseline recorded yet, so no trend. Run with --record.')
console.log()

for (const e of ranked) {
  console.log(`${String(e.decay).padStart(3)}  ${bar(e.decay)}  ${e.module.padEnd(16)} ${arrow(e.delta)}`)
  for (const r of e.reasons) console.log(`                            ${r}`)
}

console.log()
const worst = ranked[0]
if (!worst || worst.decay === 0) {
  console.log('Nothing is decaying by any signal this tool can see.')
} else {
  console.log(`Furthest from being understood: ${worst.module}.`)
  const worsening = ranked.filter((e) => e.delta !== null && e.delta > 0)
  if (worsening.length)
    console.log(`Getting worse since the baseline: ${worsening.map((e) => `${e.module} (+${e.delta})`).join(', ')}.`)
}

console.log()
console.log('A ranking, not a verdict. Whether any of this is worth the cost of')
console.log('regenerating is a judgement about money and attention that no script has.')

if (record) console.log(`\nBaseline written to ${baseline}. Commit it, or the next run has no memory.`)
process.exit(0)

#!/usr/bin/env node
// Knowledge debt report: the four metrics, computed rather than estimated.
//
//   node tools/debt.mjs [tree] [--json]
//
// Coverage     modules with a structurally complete knowledge package
// Freshness    modules built from current knowledge (git-aware where possible)
// Integrity    modules with code-ahead drift. Target zero. This is the rot metric
// Traceability active rules with both a verifying contract and an implementing module

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadTree, isVerified, ownerOf, locksFor, ID_PATTERN } from './lib/load.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const treeArg = argv.find((a) => !a.startsWith('--'))
const tree = loadTree(treeArg ?? process.env.REGEN_TREE ?? 'example')

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: tree.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}
const inGitRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true'

// ---------------------------------------------------------------- coverage
// "Complete" has to mean something structural to be countable: an overview,
// at least one knowledge item, and a lock file. That is a floor, not a
// guarantee of quality; the Regeneration Test is what judges quality.

const required = ['overview.md']
const coverage = []
for (const m of [...tree.modules].sort()) {
  const dir = join(tree.root, m, 'knowledge')
  const missing = required.filter((f) => !existsSync(join(dir, f)))
  const items = [...tree.items.values()].filter((o) => o.file.startsWith(`${m}/`)).length
  if (!items) missing.push('no knowledge items')
  if (!locksFor(m, tree).length) missing.push('knowledge.lock')
  coverage.push({ module: m, complete: missing.length === 0, missing })
}

// ---------------------------------------------------------------- freshness
// A module is stale when the knowledge that produced it is not the current
// knowledge. Where git is available this is checked properly, by comparing the
// last commit touching the module's knowledge against the recorded version.
// Otherwise fall back to the drift field the lock declares.

// A module with several implementations has one lock per stack, and each is
// judged separately: TypeScript can be current while Python lags behind.
const freshness = []
for (const m of [...tree.modules].sort()) {
  const locks = locksFor(m, tree)
  if (!locks.length) {
    freshness.push({ module: m, state: 'no-lock' })
    continue
  }
  const head = inGitRepo ? git(['log', '-1', '--format=%h', '--', `${m}/knowledge`]) : null

  for (const lock of locks) {
    const label = lock.stack ? `${m} (${lock.stack})` : m
    const declared = lock.data?.drift ?? 'unknown'
    let state = declared === 'knowledge-ahead' ? 'stale' : 'current'
    let evidence = `lock declares drift: ${declared}`

    const recorded = lock.data?.knowledge_version
    if (head && recorded) {
      const matches = head.startsWith(recorded) || recorded.startsWith(head)
      evidence = matches
        ? `knowledge_version ${recorded} matches last knowledge commit`
        : `knowledge_version ${recorded} but knowledge last changed in ${head}`
      if (!matches) state = 'stale'
    }
    freshness.push({ module: label, state, evidence })
  }
}

// ---------------------------------------------------------------- integrity

const integrity = []
for (const lock of [...tree.locks.values()].sort((a, b) => a.file.localeCompare(b.file))) {
  if (lock.data?.drift === 'code-ahead')
    integrity.push({
      module: lock.stack ? `${lock.module} (${lock.stack})` : lock.module,
      debt: lock.data?.drift_debt ?? null,
    })
}

// ---------------------------------------------------------- traceability

const traceable = []
for (const [id, { data }] of tree.items) {
  if (!['business-rule', 'nfr'].includes(data.type)) continue
  if (data.status !== 'active') continue
  const verified = isVerified(id, tree.items)
  const implemented = (data.implemented_by ?? []).length > 0
  traceable.push({ id, verified, implemented, ok: verified && implemented })
}

// ------------------------------------------------------------ regenerability
// The odd one out, and deliberately so. The other four are computed from files
// in seconds. This one records the outcome of actually regenerating something,
// which costs real money, and that is exactly what makes it honest: it is the
// only metric that cannot be satisfied by tidy paperwork.
//
// Absence of a record must never read as a pass. A module nobody has ever
// regenerated is unknown, not healthy.

const STALE_DAYS = Number(
  (argv.find((a) => a.startsWith('--stale=')) ?? '--stale=90').split('=')[1],
)
const today = new Date(process.env.REGEN_TODAY ?? Date.now())
const daysSince = (iso) => Math.floor((today - new Date(iso)) / 86400000)

const regenerability = []
for (const lock of [...tree.locks.values()].sort((a, b) => a.file.localeCompare(b.file))) {
  const label = lock.stack ? `${lock.module} (${lock.stack})` : lock.module
  const r = lock.data?.last_regeneration
  if (!r) {
    regenerability.push({ target: label, state: 'unknown' })
    continue
  }
  const age = daysSince(r.at)
  const state = r.result !== 'pass' ? 'failing' : age > STALE_DAYS ? 'stale' : 'current'
  regenerability.push({
    target: label,
    state,
    age,
    model: r.model,
    guesses: r.guesses ?? null,
    scenarios: r.contracts_passed != null ? `${r.contracts_passed}/${r.contracts_total ?? '?'}` : null,
  })
}
const totalGuesses = regenerability.reduce((n, r) => n + (r.guesses ?? 0), 0)

// ------------------------------------------------------------- under-linking
// Missing links silently shrink the regeneration scope, which is the most
// dangerous failure mode in the methodology because it produces confident,
// incomplete work. Flagging every single-module rule would be far too noisy to
// be useful, so look for a specific tell instead: prose that cites an item
// owned by another module, while `affects` never mentions that module.

const underLinked = []
for (const [id, item] of tree.items) {
  const owner = ownerOf(item)
  const declared = new Set([...(item.data.affects ?? []), ...(item.data.implemented_by ?? [])])
  const cited = new Set()
  for (const ref of item.body.match(ID_PATTERN) ?? []) {
    if (ref === id || !tree.items.has(ref)) continue
    const refOwner = ownerOf(tree.items.get(ref))
    if (refOwner && refOwner !== owner && !declared.has(refOwner)) cited.add(`${ref} (${refOwner})`)
  }
  if (cited.size) underLinked.push({ id, file: item.file, cited: [...cited] })
}

// ---------------------------------------------------------------- report

const pct = (n, d) => (d === 0 ? 100 : Math.round((n / d) * 100))
const result = {
  coverage: { complete: coverage.filter((c) => c.complete).length, total: coverage.length, detail: coverage },
  freshness: {
    current: freshness.filter((f) => f.state === 'current').length,
    total: freshness.length,
    detail: freshness,
  },
  integrity: { codeAhead: integrity.length, detail: integrity },
  traceability: { ok: traceable.filter((t) => t.ok).length, total: traceable.length, detail: traceable },
  regenerability: {
    current: regenerability.filter((r) => r.state === 'current').length,
    total: regenerability.length,
    unknown: regenerability.filter((r) => r.state === 'unknown').length,
    failing: regenerability.filter((r) => r.state === 'failing').length,
    guesses: totalGuesses,
    staleDays: STALE_DAYS,
    detail: regenerability,
  },
  gitAware: inGitRepo,
}
result.coverage.pct = pct(result.coverage.complete, result.coverage.total)
result.freshness.pct = pct(result.freshness.current, result.freshness.total)
result.traceability.pct = pct(result.traceability.ok, result.traceability.total)
result.regenerability.pct = pct(result.regenerability.current, result.regenerability.total)

if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.integrity.codeAhead > 0 ? 1 : 0)
}

const bar = (p) => '#'.repeat(Math.round(p / 5)).padEnd(20, '.')

console.log(`Knowledge debt report  ${tree.root}`)
console.log(inGitRepo ? '(git-aware freshness)' : '(no git: freshness falls back to declared drift)')
console.log()
console.log(`Coverage      ${bar(result.coverage.pct)} ${result.coverage.pct}%  ${result.coverage.complete}/${result.coverage.total} modules`)
for (const c of coverage.filter((c) => !c.complete)) console.log(`                 ${c.module}: missing ${c.missing.join(', ')}`)

console.log(`Freshness     ${bar(result.freshness.pct)} ${result.freshness.pct}%  ${result.freshness.current}/${result.freshness.total} modules current`)
for (const f of freshness.filter((f) => f.state !== 'current')) console.log(`                 ${f.module}: ${f.state}, ${f.evidence ?? ''}`)

console.log(`Integrity     ${result.integrity.codeAhead === 0 ? 'clean'.padEnd(20, ' ') : bar(0)} ${result.integrity.codeAhead} code-ahead`)
for (const i of integrity)
  console.log(`                 ${i.module}: code-ahead${i.debt ? ` since ${i.debt.since}, ${i.debt.reason}` : ', undeclared'}`)

console.log(`Traceability  ${bar(result.traceability.pct)} ${result.traceability.pct}%  ${result.traceability.ok}/${result.traceability.total} active rules`)
for (const t of traceable.filter((t) => !t.ok))
  console.log(`                 ${t.id}: ${!t.verified ? 'no verifying contract' : ''}${!t.verified && !t.implemented ? ', ' : ''}${!t.implemented ? 'no implementing module' : ''}`)

console.log(`Regenerability ${bar(result.regenerability.pct)} ${result.regenerability.pct}%  ${result.regenerability.current}/${result.regenerability.total} verified within ${STALE_DAYS}d`)
for (const r of regenerability.filter((r) => r.state !== 'current')) {
  if (r.state === 'unknown')
    console.log(`                 ${r.target}: never regenerated (unknown, not passing)`)
  else if (r.state === 'failing')
    console.log(`                 ${r.target}: FAILING as of ${r.age}d ago${r.scenarios ? `, ${r.scenarios}` : ''}`)
  else console.log(`                 ${r.target}: last passed ${r.age}d ago, past the ${STALE_DAYS}d threshold`)
}
if (totalGuesses > 0)
  console.log(`                 ${totalGuesses} unanswered question(s) reported by regenerating agents`)

if (underLinked.length) {
  console.log()
  console.log(`Possible under-linking (${underLinked.length}):`)
  for (const u of underLinked)
    console.log(`  ${u.id} cites ${u.cited.join(', ')} but does not list that module in affects`)
  console.log('A missing affects link silently shrinks the regeneration scope.')
}

process.exit(result.integrity.codeAhead > 0 ? 1 : 0)

#!/usr/bin/env node
// The Trigger: is regenerating this module worth what it costs?
//
//   node tools/trigger.mjs [tree] [--json]
//
// Regeneration costs money and attention, so "always" and "never" are both
// wrong. This weighs the signals and proposes, with reasoning.
//
// The most useful thing it does is refuse. Two states make regeneration
// actively harmful rather than merely wasteful, and both are easy to walk into
// while looking at a dashboard that says a module is unhealthy:
//
//   code-ahead drift   The implementation contains behaviour the knowledge does
//                      not describe. Regenerating from knowledge destroys it,
//                      silently, and the module will look healthier afterwards
//                      because the evidence is gone. Reconcile first.
//
//   a failing test     The last Regeneration Test failed, so the knowledge is
//                      already known to be insufficient. Spending again to
//                      re-prove that buys nothing. Fix the knowledge.
//
// A pass with many guesses is treated as a warning rather than a success: the
// module got lucky, and luck is not a property you can rely on twice.
//
// Everything here is a proposal. Nothing regenerates anything.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTree, locksFor, walk } from './lib/load.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const json = argv.includes('--json')
const treeArg = argv.find((a) => !a.startsWith('--'))
const treePath = resolve(treeArg ?? process.env.REGEN_TREE ?? 'example')
const tree = loadTree(treePath)

// The model you would regenerate with today. Compared against what each module
// was last built by, which is the only way to notice the manifesto's
// "regenerate when the model improves" case, and the case it has never actually
// exercised.
const CURRENT_MODEL = process.env.REGEN_LLM_MODEL ?? null
const STALE_DAYS = Number(process.env.REGEN_STALE_DAYS ?? 90)
// Rough blended rate. Wrong for every specific provider and right enough for
// the only question being asked, which is whether this costs pennies or pounds.
const RATE_PER_MTOK = Number(process.env.REGEN_RATE_PER_MTOK ?? 10)

const today = new Date()
const daysSince = (d) => {
  const t = Date.parse(d)
  return Number.isNaN(t) ? null : Math.floor((today - t) / 86400000)
}

let debtRaw
try {
  debtRaw = execFileSync('node', [join(HERE, 'debt.mjs'), treePath, '--json'], { encoding: 'utf8' })
} catch (e) {
  if (e.stdout === undefined) throw e
  debtRaw = e.stdout
}
const debt = JSON.parse(debtRaw)
const freshnessOf = new Map(debt.freshness.detail.map((d) => [d.module, d]))

/** Bytes of text under a path, ignoring anything that is not worth sending to a model. */
function bytesUnder(root) {
  if (!existsSync(root)) return 0
  if (statSync(root).isFile()) return statSync(root).size
  let total = 0
  for (const f of walk(root)) {
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|zip|db|sqlite3?)$/i.test(f)) continue
    total += statSync(f).size
  }
  return total
}

const proposals = []

for (const module of [...tree.modules].sort()) {
  const knowledgeBytes = bytesUnder(join(treePath, module, 'knowledge'))

  for (const lock of locksFor(module, tree)) {
    const stack = lock.stack ?? null
    const label = stack ? `${module} (${stack})` : module
    const last = lock.data.last_regeneration ?? null

    const blockers = []
    const reasons = []
    const cautions = []

    // ---------------------------------------------------------- blockers

    if (lock.data.drift === 'code-ahead') {
      const debtNote = lock.data.drift_debt
        ? `declared since ${lock.data.drift_debt.since} (${lock.data.drift_debt.reason})`
        : 'undeclared'
      blockers.push(
        `code-ahead drift, ${debtNote}. The implementation contains behaviour the knowledge ` +
          `does not describe, and regenerating would delete it without a trace. Run reconcile first.`,
      )
    }

    if (last?.result === 'fail') {
      blockers.push(
        `the last Regeneration Test failed on ${last.at}` +
          `${last.contracts_total ? `, at ${last.contracts_passed}/${last.contracts_total} contracts` : ''}. ` +
          `The knowledge is already known to be insufficient, so spending again proves nothing new. ` +
          `Improve the knowledge, then retest.`,
      )
    }

    // ---------------------------------------------------------- triggers

    const fresh = freshnessOf.get(label) ?? freshnessOf.get(module)
    if (fresh && fresh.state === 'stale') {
      reasons.push({
        signal: 'knowledge-ahead',
        weight: 'strong',
        detail: `the knowledge has moved on and this implementation has not: ${fresh.evidence}`,
      })
    }
    if (fresh && fresh.state === 'no-lock') {
      reasons.push({ signal: 'no-provenance', weight: 'strong', detail: 'nothing records what produced this implementation' })
    }

    if (!last) {
      reasons.push({
        signal: 'never-verified',
        weight: 'moderate',
        detail: 'no Regeneration Test has ever run, so regenerability is believed rather than known',
      })
    } else {
      const age = daysSince(last.at)
      if (last.result === 'pass' && age !== null && age > STALE_DAYS) {
        reasons.push({
          signal: 'verification-stale',
          weight: 'moderate',
          detail: `last verified ${age} days ago, past the ${STALE_DAYS} day threshold`,
        })
      }
      if (CURRENT_MODEL && last.model && last.model !== CURRENT_MODEL) {
        reasons.push({
          signal: 'model-moved',
          weight: 'weak',
          detail:
            `last built by ${last.model}; you would build with ${CURRENT_MODEL} today. ` +
            `This is the "regenerate when the model improves" case, and it is worth noting ` +
            `that a different model is not automatically a better one.`,
        })
      }
      // A pass is not a pass if the agent had to invent nineteen answers.
      if (last.result === 'pass' && (last.guesses ?? 0) >= 5) {
        cautions.push(
          `the last pass involved ${last.guesses} guesses. It succeeded, but partly on luck, ` +
            `and luck is not a property you can rely on twice. Answering those questions in the ` +
            `knowledge is cheaper than regenerating and more likely to help.`,
        )
      }
    }

    // ------------------------------------------------------------- cost

    const implBytes = (lock.data.implementation_paths ?? [])
      .map((p) => bytesUnder(join(treePath, p)))
      .reduce((a, b) => a + b, 0)
    const inTok = Math.round(knowledgeBytes / 4)
    const outTok = implBytes ? Math.round(implBytes / 4) : null
    const cost = ((inTok + (outTok ?? inTok)) / 1e6) * RATE_PER_MTOK

    const strongest = reasons.some((r) => r.weight === 'strong')
      ? 'strong'
      : reasons.some((r) => r.weight === 'moderate')
        ? 'moderate'
        : reasons.length
          ? 'weak'
          : 'none'

    const verdict = blockers.length ? 'blocked' : strongest === 'none' ? 'hold' : strongest === 'weak' ? 'hold' : 'propose'

    proposals.push({
      module, stack, label, verdict, blockers, reasons, cautions,
      cost: {
        knowledgeBytes,
        implementationBytes: implBytes || null,
        estimateUsd: Number(cost.toFixed(2)),
        basis: implBytes
          ? 'knowledge in, implementation out, at a blended rate'
          : 'knowledge in, output assumed equal, because no implementation_paths are declared',
      },
    })
  }
}

const ORDER = { propose: 0, blocked: 1, hold: 2 }
proposals.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.label.localeCompare(b.label))

if (json) {
  console.log(JSON.stringify({ tree: treePath, currentModel: CURRENT_MODEL, staleDays: STALE_DAYS, proposals }, null, 2))
  process.exit(0)
}

console.log(`Trigger: ${proposals.length} implementation(s) in ${treePath}`)
console.log(CURRENT_MODEL ? `Would regenerate with ${CURRENT_MODEL}.` : 'REGEN_LLM_MODEL is not set, so the model-moved signal is not checked.')
console.log()

const propose = proposals.filter((p) => p.verdict === 'propose')
const blocked = proposals.filter((p) => p.verdict === 'blocked')
const hold = proposals.filter((p) => p.verdict === 'hold')

if (blocked.length) {
  console.log('DO NOT REGENERATE')
  for (const p of blocked) {
    console.log(`  ${p.label}`)
    for (const b of p.blockers) console.log(`    ${b}`)
  }
  console.log()
}

if (propose.length) {
  console.log('WORTH PROPOSING')
  for (const p of propose) {
    console.log(`  ${p.label}   about $${p.cost.estimateUsd}`)
    for (const r of p.reasons) console.log(`    [${r.weight}] ${r.signal}: ${r.detail}`)
    for (const c of p.cautions) console.log(`    caution: ${c}`)
  }
  console.log()
}

if (hold.length) {
  console.log('HOLD')
  for (const p of hold) {
    const why = p.reasons.length ? p.reasons.map((r) => r.signal).join(', ') : 'no signal'
    console.log(`  ${p.label}: ${why}, not enough on its own`)
    for (const c of p.cautions) console.log(`    caution: ${c}`)
  }
  console.log()
}

if (!propose.length && !blocked.length) console.log('Nothing is worth regenerating today.')

console.log('Proposals. Nothing here regenerates anything, and the cost figures are an')
console.log('order of magnitude rather than a quote: they say pennies or pounds, no more.')
process.exit(0)

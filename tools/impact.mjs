#!/usr/bin/env node
// Compute the regeneration scope of a knowledge change.
//
// This is deterministic graph traversal, not a judgment call, which is exactly
// why it belongs in a script rather than in a prompt. Given a changed item or
// module, it reports every module that must be regenerated and every contract
// that must pass afterwards.
//
//   node tools/impact.mjs BR-002 [tree]
//   node tools/impact.mjs --module customer [tree]
//   node tools/impact.mjs --changed <file>... [tree]   (paths from a git diff)
//   node tools/impact.mjs BR-002 --json

import { loadTree, verifiersOf } from './lib/load.mjs'
import { basename, sep } from 'node:path'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const args = argv.filter((a) => a !== '--json')

let mode = 'item'
if (args[0] === '--module') mode = 'module'
else if (args[0] === '--changed') mode = 'changed'

const targets = mode === 'item' ? args.slice(0, 1) : args.slice(1)
const treeArg = mode === 'item' ? args[1] : undefined
const tree = loadTree(treeArg ?? process.env.REGEN_TREE ?? 'example')

if (!targets.length || !targets[0]) {
  console.error('usage: impact.mjs <ID> [tree] | --module <name> | --changed <file>...')
  process.exit(2)
}

// ---------------------------------------------------------------- resolve

const seedIds = new Set()
const notes = []

if (mode === 'item') {
  const id = targets[0]
  if (!tree.items.has(id)) {
    console.error(`Unknown item ${id}. Known ids: ${[...tree.items.keys()].sort().join(', ')}`)
    process.exit(2)
  }
  seedIds.add(id)
} else if (mode === 'module') {
  // Every item that names this module is a seed: changing the module can
  // invalidate anything asserted about it.
  for (const [id, { data }] of tree.items)
    if ((data.affects ?? []).includes(targets[0]) || (data.implemented_by ?? []).includes(targets[0]))
      seedIds.add(id)
  if (!seedIds.size) notes.push(`No knowledge items reference module "${targets[0]}"`)
} else {
  // Map changed file paths back to the items they contain.
  for (const path of targets) {
    const hit = [...tree.items.values()].find((o) => path.endsWith(o.file) || o.file.endsWith(basename(path)))
    if (hit) seedIds.add(hit.data.id)
    else notes.push(`No knowledge item matched changed path ${path}`)
  }
}

// ---------------------------------------------------------------- traverse

// Modules in scope come from `affects` and `implemented_by` on every seed item.
// A superseding item also drags in whatever its predecessor touched, since the
// old behaviour has to be removed from those modules too.
const scope = new Set()
const reasons = new Map()
const addModule = (m, why) => {
  scope.add(m)
  if (!reasons.has(m)) reasons.set(m, new Set())
  reasons.get(m).add(why)
}

const expand = (id, depth = 0) => {
  if (depth > 10) return
  const item = tree.items.get(id)
  if (!item) return
  for (const m of item.data.affects ?? []) addModule(m, `${id} affects`)
  for (const m of item.data.implemented_by ?? []) addModule(m, `${id} implemented_by`)
  if (item.data.supersedes) expand(item.data.supersedes, depth + 1)
}
for (const id of seedIds) expand(id)

// Contracts that must pass: every contract verifying a seed item, plus every
// contract belonging to a module in scope. The second half is what stops a
// regeneration from quietly breaking a rule nobody edited.
const contracts = new Set()
for (const id of seedIds) for (const c of verifiersOf(id, tree.items)) contracts.add(c)
for (const [id, { data, file }] of tree.items) {
  if (data.type !== 'contract') continue
  const owner = file.split(sep)[0]
  if (scope.has(owner)) contracts.add(id)
  for (const v of data.verifies ?? []) if (seedIds.has(v)) contracts.add(id)
}

// ---------------------------------------------------------------- report

const result = {
  seeds: [...seedIds].sort(),
  modules: [...scope].sort(),
  contracts: [...contracts].sort(),
  unscoped: [...tree.modules].filter((m) => !scope.has(m)).sort(),
  notes,
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

console.log(`Regeneration scope for: ${result.seeds.join(', ') || '(nothing)'}`)
console.log()
if (result.modules.length) {
  console.log(`Modules to regenerate (${result.modules.length}):`)
  for (const m of result.modules) console.log(`  ${m}   <- ${[...reasons.get(m)].join(', ')}`)
} else {
  console.log('Modules to regenerate: none')
}
console.log()
console.log(`Contracts that must pass (${result.contracts.length}): ${result.contracts.join(', ') || 'none'}`)
if (result.unscoped.length) console.log(`Untouched: ${result.unscoped.join(', ')}`)
for (const n of notes) console.log(`  note: ${n}`)

if (result.modules.length && result.contracts.length === 0)
  console.log('\nWARNING: modules are in scope but no contract verifies them. Regenerating is unsafe.')

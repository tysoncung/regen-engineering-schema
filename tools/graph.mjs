#!/usr/bin/env node
// Render the knowledge graph.
//
//   regen-graph                      Mermaid, whole tree
//   regen-graph --focus BR-002       just what a change to BR-002 touches
//   regen-graph --format dot         Graphviz
//   regen-graph --format text        terminal, no tooling required
//
// The links between knowledge items are the part people find hardest to believe
// is real, because in most projects "we have documentation" means a folder of
// prose nobody can reason about. Drawing the graph makes the difference obvious:
// either the arrows are there or they are not, and a rule floating unconnected
// is visibly not doing its job.

import { loadTree, verifiersOf, ownerOf } from './lib/load.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i === -1 ? d : argv[i + 1]
}

const tree = loadTree(opt('--tree', argv.find((a) => !a.startsWith('--')) ?? 'example'))
const format = opt('--format', 'mermaid')
const focus = opt('--focus', null)

if (focus && !tree.items.has(focus)) {
  console.error(`Unknown item ${focus}. Known: ${[...tree.items.keys()].sort().join(', ')}`)
  process.exit(2)
}

// ---------------------------------------------------------------- select

// With --focus, show the item, everything it touches, and everything that
// verifies it: the same neighbourhood impact analysis walks.
let ids = [...tree.items.keys()]
if (focus) {
  const keep = new Set([focus])
  const item = tree.items.get(focus)
  for (const v of item.data.verified_by ?? []) keep.add(v)
  for (const v of verifiersOf(focus, tree.items)) keep.add(v)
  for (const v of item.data.verifies ?? []) keep.add(v)
  if (item.data.supersedes) keep.add(item.data.supersedes)
  for (const [id, o] of tree.items) {
    if ((o.data.verifies ?? []).includes(focus)) keep.add(id)
    if (o.data.supersedes === focus) keep.add(id)
  }
  ids = [...keep]
}
ids.sort()

const modules = new Set()
for (const id of ids) {
  const d = tree.items.get(id).data
  for (const m of [...(d.affects ?? []), ...(d.implemented_by ?? [])]) modules.add(m)
}

// ---------------------------------------------------------------- shapes

const SHAPE = {
  'business-rule': (id, t) => `${id}["${t}"]`,
  contract: (id, t) => `${id}{{"${t}"}}`,
  decision: (id, t) => `${id}[/"${t}"/]`,
  assumption: (id, t) => `${id}(["${t}"])`,
  nfr: (id, t) => `${id}[["${t}"]]`,
}

const clip = (s, n = 38) => (s.length > n ? `${s.slice(0, n - 1)}...` : s).replace(/"/g, "'")

// ---------------------------------------------------------------- render

if (format === 'text') {
  console.log(`Knowledge graph  ${tree.root}${focus ? `  (focus: ${focus})` : ''}\n`)
  for (const id of ids) {
    const { data } = tree.items.get(id)
    const verifiedBy = [...new Set([...(data.verified_by ?? []), ...verifiersOf(id, tree.items)])]
    console.log(`${id}  ${data.title}`)
    console.log(`  type       ${data.type}   status ${data.status}   owner ${ownerOf(tree.items.get(id)) ?? 'global'}`)
    if (data.affects?.length) console.log(`  affects    ${data.affects.join(', ')}`)
    if (data.implemented_by?.length) console.log(`  built in   ${data.implemented_by.join(', ')}`)
    if (verifiedBy.length) console.log(`  verified   ${verifiedBy.join(', ')}`)
    else if (data.type === 'business-rule' && data.status === 'active')
      console.log(`  verified   NOTHING VERIFIES THIS`)
    if (data.verifies?.length) console.log(`  verifies   ${data.verifies.join(', ')}`)
    if (data.supersedes) console.log(`  replaces   ${data.supersedes}`)
    console.log()
  }
  process.exit(0)
}

const edges = []
const seen = new Set()
const edge = (a, arrow, b, label) => {
  const key = `${a}${arrow}${b}${label ?? ''}`
  if (seen.has(key)) return
  seen.add(key)
  edges.push(label ? `  ${a} ${arrow}|${label}| ${b}` : `  ${a} ${arrow} ${b}`)
}

const lines = []
if (format === 'dot') {
  lines.push('digraph knowledge {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];')
} else {
  lines.push('graph TD' === '' ? '' : 'flowchart LR')
}

// Items, grouped by owning module so the picture matches the repository.
const byOwner = new Map()
for (const id of ids) {
  const owner = ownerOf(tree.items.get(id)) ?? 'global'
  if (!byOwner.has(owner)) byOwner.set(owner, [])
  byOwner.get(owner).push(id)
}

for (const [owner, group] of [...byOwner].sort()) {
  if (format === 'dot') {
    lines.push(`  subgraph cluster_${owner.replace(/\W/g, '_')} {`, `    label="${owner}";`)
    for (const id of group) lines.push(`    "${id}" [label="${id}\\n${clip(tree.items.get(id).data.title, 28)}"];`)
    lines.push('  }')
  } else {
    lines.push(`  subgraph ${owner.replace(/\W/g, '_')}["${owner}"]`)
    for (const id of group) {
      const { data } = tree.items.get(id)
      const shape = SHAPE[data.type] ?? ((i, t) => `${i}["${t}"]`)
      lines.push(`    ${shape(id, `${id}<br/>${clip(data.title)}`)}`)
    }
    lines.push('  end')
  }
}

// Modules as their own nodes, so "which code does this touch" is visible.
for (const m of [...modules].sort()) {
  if (format === 'dot') lines.push(`  "mod_${m}" [shape=folder, label="${m}"];`)
  else lines.push(`  mod_${m}[("${m}")]`)
}

for (const id of ids) {
  const { data } = tree.items.get(id)
  const q = (x) => (format === 'dot' ? `"${x}"` : x)
  const arrow = format === 'dot' ? '->' : '-->'

  for (const m of data.affects ?? []) {
    if (format === 'dot') edges.push(`  ${q(id)} ${arrow} ${q(`mod_${m}`)} [label="affects", style=dashed];`)
    else edge(id, '-..->', `mod_${m}`, 'affects')
  }
  for (const m of data.implemented_by ?? []) {
    if (format === 'dot') edges.push(`  ${q(id)} ${arrow} ${q(`mod_${m}`)} [label="built in"];`)
    else edge(id, '-->', `mod_${m}`, 'built in')
  }
  for (const v of data.verifies ?? []) {
    if (!ids.includes(v)) continue
    if (format === 'dot') edges.push(`  ${q(id)} ${arrow} ${q(v)} [label="verifies", color="#2c7a58"];`)
    else edge(id, '==>', v, 'verifies')
  }
  if (data.supersedes && ids.includes(data.supersedes)) {
    if (format === 'dot') edges.push(`  ${q(id)} ${arrow} ${q(data.supersedes)} [label="supersedes", style=dotted];`)
    else edge(id, '-.->', data.supersedes, 'supersedes')
  }
}

lines.push(...edges)

if (format === 'dot') {
  lines.push('}')
} else {
  // Unverified active rules are the thing worth spotting at a glance.
  const unverified = ids.filter((id) => {
    const d = tree.items.get(id).data
    return (
      d.type === 'business-rule' &&
      d.status === 'active' &&
      !(d.verified_by ?? []).length &&
      !verifiersOf(id, tree.items).length
    )
  })
  lines.push('  classDef unverified stroke:#c0392b,stroke-width:2px;')
  if (unverified.length) lines.push(`  class ${unverified.join(',')} unverified`)
  lines.push('  classDef mod fill:#e6f2ec,stroke:#2c7a58;')
  if (modules.size) lines.push(`  class ${[...modules].map((m) => `mod_${m}`).join(',')} mod`)
}

console.log(lines.join('\n'))

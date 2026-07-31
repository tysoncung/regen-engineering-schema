#!/usr/bin/env node
// Generate the documents enterprises are obliged to write, from the knowledge
// that already exists.
//
//   regen-docs requirements [tree]
//   regen-docs hld [tree]
//   regen-docs dld --module customer [tree]
//   regen-docs raid [tree]
//   regen-docs traceability [tree]
//
// The cardinal rule: DERIVE, NEVER INVENT. Where the knowledge is silent the
// document says "Not specified", because a generated document that quietly
// fills gaps with plausible prose launders absence into apparent completeness,
// which is worse than no document at all.
//
// Every statement carries its source id, so any line traces back to the item
// that asserts it. Generated documents are build artifacts: do not commit them
// into the knowledge tree, or you have created a second source of truth.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTree, verifiersOf, ownerOf } from './lib/load.mjs'

const argv = process.argv.slice(2)
const kind = argv[0]
const opt = (n) => {
  const i = argv.indexOf(n)
  return i === -1 ? undefined : argv[i + 1]
}
const KINDS = ['requirements', 'hld', 'dld', 'raid', 'traceability']
if (!KINDS.includes(kind)) {
  console.error(`usage: regen-docs <${KINDS.join('|')}> [tree] [--module <name>]`)
  process.exit(2)
}
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--module')
const tree = loadTree(opt('--tree') ?? positional[0] ?? process.env.REGEN_TREE ?? '.')
const onlyModule = opt('--module')

// ---------------------------------------------------------------- helpers

const NOT_SPECIFIED = '*Not specified in the knowledge tree.*'

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: tree.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

const byType = (t) =>
  [...tree.items.values()]
    .filter((o) => o.data.type === t && (!onlyModule || ownerOf(o) === onlyModule || (o.data.affects ?? []).includes(onlyModule)))
    .sort((a, b) => a.data.id.localeCompare(b.data.id))

const active = (items) => items.filter((o) => o.data.status === 'active')
const body = (o) => o.body.trim() || NOT_SPECIFIED
const line = (o) => o.body.trim().split('\n').find((l) => l.trim()) ?? NOT_SPECIFIED

function narrative(relPath) {
  const p = join(tree.root, relPath)
  return existsSync(p) ? readFileSync(p, 'utf8').replace(/^#.*\n/, '').trim() : null
}

const out = []
const w = (s = '') => out.push(s)

function stamp(title) {
  const version = git(['rev-parse', '--short', 'HEAD']) ?? 'unversioned'
  w(`# ${title}`)
  w()
  w(`> Generated from the knowledge tree at \`${tree.root}\`, knowledge version \`${version}\`,`)
  w(`> on ${new Date().toISOString().slice(0, 10)} by regen-docs. **Do not edit or commit this file**:`)
  w(`> it is a build artifact, and the knowledge tree is the source. Every statement below`)
  w(`> carries the id of the item asserting it. Gaps are marked rather than filled, because a`)
  w(`> generated document that invents content launders absence into apparent completeness.`)
  w()
}

// ---------------------------------------------------------------- documents

if (kind === 'requirements') {
  stamp('Requirements Specification')

  const vision = narrative('knowledge/vision.md')
  w('## 1. Purpose')
  w()
  w(vision ?? NOT_SPECIFIED)
  w()

  w('## 2. Functional requirements')
  w()
  const rules = active(byType('business-rule'))
  if (!rules.length) w(NOT_SPECIFIED)
  for (const r of rules) {
    const verified = [...new Set([...(r.data.verified_by ?? []), ...verifiersOf(r.data.id, tree.items)])]
    w(`### ${r.data.id}: ${r.data.title}`)
    w()
    w(body(r))
    w()
    w(`| | |`)
    w(`|---|---|`)
    w(`| Applies to | ${(r.data.affects ?? []).join(', ') || NOT_SPECIFIED} |`)
    w(`| Acceptance criteria | ${verified.length ? verified.map((v) => `${v}: ${tree.items.get(v)?.data.title ?? ''}`).join('; ') : '**None. This requirement is unverifiable as written.**'} |`)
    if (r.data.depends_on?.length) w(`| Depends on | ${r.data.depends_on.join(', ')} |`)
    w()
  }

  w('## 3. Non-functional requirements')
  w()
  const nfrs = active(byType('nfr'))
  if (!nfrs.length) w(NOT_SPECIFIED)
  for (const n of nfrs) {
    w(`### ${n.data.id}: ${n.data.title}`)
    w()
    w(body(n))
    w()
  }

  w('## 4. Assumptions')
  w()
  const asms = active(byType('assumption'))
  if (!asms.length) w(NOT_SPECIFIED)
  for (const a of asms) w(`- **${a.data.id}** ${a.data.title}: ${line(a)}`)
  w()
}

if (kind === 'hld') {
  stamp('High-Level Design')

  w('## 1. System purpose')
  w()
  w(narrative('knowledge/vision.md') ?? NOT_SPECIFIED)
  w()

  w('## 2. Modules and responsibilities')
  w()
  for (const m of [...tree.modules].sort()) {
    if (onlyModule && m !== onlyModule) continue
    w(`### ${m}`)
    w()
    w(narrative(`${m}/knowledge/overview.md`) ?? NOT_SPECIFIED)
    w()
  }

  w('## 3. Architecture decisions')
  w()
  const adrs = active(byType('decision'))
  if (!adrs.length) w(NOT_SPECIFIED)
  for (const d of adrs) {
    w(`### ${d.data.id}: ${d.data.title}`)
    w()
    w(body(d))
    w()
  }

  w('## 4. Cross-module surface')
  w()
  const cross = active(byType('business-rule')).filter((r) => (r.data.affects ?? []).length > 1)
  if (!cross.length) w('No knowledge item declares an effect on more than one module.')
  for (const r of cross)
    w(`- **${r.data.id}** ${r.data.title}: spans ${(r.data.affects ?? []).join(', ')}`)
  w()
}

if (kind === 'dld') {
  stamp(`Detail Design${onlyModule ? `: ${onlyModule}` : ''}`)
  const mods = onlyModule ? [onlyModule] : [...tree.modules].sort()

  for (const m of mods) {
    w(`## Module: ${m}`)
    w()
    w(narrative(`${m}/knowledge/overview.md`) ?? NOT_SPECIFIED)
    w()
    const api = join(tree.root, m, 'knowledge', 'api.openapi.yaml')
    w(`### Interface contract`)
    w()
    if (existsSync(api)) {
      w('The authoritative wire-format contract (REP-0002):')
      w()
      w('```yaml')
      w(readFileSync(api, 'utf8').trimEnd())
      w('```')
    } else {
      w(NOT_SPECIFIED + ' No `api.openapi.yaml` in this package.')
    }
    w()
    w(`### Behavioural contracts`)
    w()
    const cts = active(byType('contract')).filter((c) => ownerOf(c) === m)
    if (!cts.length) w(NOT_SPECIFIED)
    for (const c of cts) {
      w(`#### ${c.data.id}: ${c.data.title}  (verifies ${(c.data.verifies ?? []).join(', ') || NOT_SPECIFIED})`)
      w()
      w(body(c))
      w()
    }
  }
}

if (kind === 'raid') {
  stamp('RAID Log')

  const sections = [
    ['Risks', 'risk', (o) => {
      const l = o.data.likelihood ?? 'not specified'
      const i = o.data.impact ?? 'not specified'
      const mit = o.data.mitigation ?? '**No mitigation recorded.**'
      return `| ${o.data.id} | ${o.data.title} | ${l} | ${i} | ${mit} | ${(o.data.affects ?? []).join(', ') || '-'} |`
    }, '| Id | Risk | Likelihood | Impact | Mitigation | Threatens |\n|---|---|---|---|---|---|'],
    ['Assumptions', 'assumption', (o) => `| ${o.data.id} | ${o.data.title} | ${line(o).slice(0, 120)} |`,
      '| Id | Assumption | Detail |\n|---|---|---|'],
    ['Issues', 'issue', (o) => `| ${o.data.id} | ${o.data.title} | ${o.data.owner ?? '**Unowned.**'} | ${line(o).slice(0, 100)} |`,
      '| Id | Issue | Owner | Detail |\n|---|---|---|---|'],
  ]

  for (const [heading, type, render, header] of sections) {
    w(`## ${heading}`)
    w()
    const items = active(byType(type))
    if (!items.length) {
      w(type === 'risk'
        ? 'No risks recorded. That is rarely because none exist.'
        : type === 'issue'
          ? 'No open issues recorded.'
          : NOT_SPECIFIED)
    } else {
      w(header)
      for (const o of items) w(render(o))
    }
    w()
  }

  w('## Dependencies')
  w()
  const deps = [...tree.items.values()].filter((o) => o.data.depends_on?.length)
  if (!deps.length) w('No item declares a dependency. External dependencies almost certainly exist and are not written down.')
  else {
    w('| Declared by | Depends on |')
    w('|---|---|')
    for (const o of deps.sort((a, b) => a.data.id.localeCompare(b.data.id)))
      w(`| ${o.data.id} ${o.data.title} | ${o.data.depends_on.join(', ')} |`)
  }
  w()
}

if (kind === 'traceability') {
  stamp('Traceability Matrix')
  w('Requirement to implementation to verification, from links that already exist.')
  w()
  w('| Requirement | Title | Implemented by | Verified by | Status |')
  w('|---|---|---|---|---|')
  const reqs = [...active(byType('business-rule')), ...active(byType('nfr'))]
  for (const r of reqs) {
    const verified = [...new Set([...(r.data.verified_by ?? []), ...verifiersOf(r.data.id, tree.items)])]
    const impl = (r.data.implemented_by ?? [])
    const status =
      verified.length && impl.length ? 'traced' : `**GAP: ${!impl.length ? 'no implementation link' : ''}${!impl.length && !verified.length ? ', ' : ''}${!verified.length ? 'no verifying contract' : ''}**`
    w(`| ${r.data.id} | ${r.data.title} | ${impl.join(', ') || '-'} | ${verified.join(', ') || '-'} | ${status} |`)
  }
  w()
  const gaps = reqs.filter((r) => {
    const verified = (r.data.verified_by ?? []).length || verifiersOf(r.data.id, tree.items).length
    return !verified || !(r.data.implemented_by ?? []).length
  })
  w(gaps.length
    ? `${gaps.length} of ${reqs.length} requirement(s) have traceability gaps, listed above.`
    : `All ${reqs.length} active requirements trace to both an implementation and a verifying contract.`)
  w()
}

console.log(out.join('\n'))

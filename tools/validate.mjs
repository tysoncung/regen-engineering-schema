#!/usr/bin/env node
// Reference validator for the Regen Engineering knowledge schema.
// Validates frontmatter and lock files, then resolves every link in the
// knowledge graph. Non-zero exit on any error, so it drops straight into CI.
//
//   node tools/validate.mjs [tree]

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// The default ajv export only understands draft-07; the schemas here declare
// 2020-12, which needs this build.
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { loadTree, isVerified } from './lib/load.mjs'
import { checkModuleInterface } from './lib/openapi.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = join(HERE, '..', 'schemas')

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const load = (f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'))
const validateItem = ajv.compile(load('knowledge-item.schema.json'))
const validateLock = ajv.compile(load('knowledge-lock.schema.json'))

const ajvErrors = (v) => (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')

const tree = loadTree(process.argv[2] ?? process.env.REGEN_TREE ?? 'example')
const errors = tree.problems.map((p) => ({ file: p.file, msg: p.msg }))
const warnings = []
const err = (file, msg) => errors.push({ file, msg })
const warn = (file, msg) => warnings.push({ file, msg })

// ---------------------------------------------------------------- schema

for (const [id, { file, data }] of tree.items)
  if (!validateItem(data)) err(file, `frontmatter schema: ${ajvErrors(validateItem)}`)

const locksByModule = new Map()
for (const lock of tree.locks.values()) {
  if (!locksByModule.has(lock.module)) locksByModule.set(lock.module, [])
  locksByModule.get(lock.module).push(lock)
}

for (const { file, data, module, stack } of tree.locks.values()) {
  if (!validateLock(data)) {
    err(file, `lock schema: ${ajvErrors(validateLock)}`)
    continue
  }
  if (data.module !== module)
    err(file, `lock declares module "${data.module}" but sits in "${module}"`)
  if (!tree.modules.has(data.module))
    err(file, `lock names module "${data.module}" which does not exist`)
  if (data.stack && stack && data.stack !== stack)
    err(file, `lock declares stack "${data.stack}" but the filename says "${stack}"`)
  // With several implementations, provenance is ambiguous unless each lock says
  // which stack it describes.
  if (locksByModule.get(module).length > 1 && !stack)
    err(
      file,
      `module "${module}" has ${locksByModule.get(module).length} locks, so each must name its stack via knowledge.<stack>.lock`,
    )
  for (const c of data.contracts_passed ?? [])
    if (!tree.items.has(c)) err(file, `contracts_passed references unknown contract ${c}`)
}

// ------------------------------------------------------------- interfaces
// REP-0002: a module documenting an HTTP interface must carry a machine-
// readable contract, and the prose summary must agree with it.

for (const module of tree.modules) {
  const moduleDir = join(tree.root, module)
  const overviewPath = join(moduleDir, 'knowledge', 'overview.md')
  const overview = existsSync(overviewPath) ? readFileSync(overviewPath, 'utf8') : ''
  const result = checkModuleInterface(moduleDir, overview)
  for (const msg of result.errors) err(`${module}/knowledge/overview.md`, msg)
  for (const msg of result.warnings) warn(`${module}/knowledge/overview.md`, msg)
}

// ---------------------------------------------------------------- graph

for (const [id, { file, data }] of tree.items) {
  for (const ref of data.verified_by ?? [])
    if (!tree.items.has(ref)) err(file, `${id} verified_by references unknown item ${ref}`)

  for (const ref of data.verifies ?? [])
    if (!tree.items.has(ref)) err(file, `${id} verifies references unknown item ${ref}`)

  if (data.supersedes) {
    if (!tree.items.has(data.supersedes))
      err(file, `${id} supersedes references unknown item ${data.supersedes}`)
    else if (tree.items.get(data.supersedes).data.status !== 'superseded')
      err(
        file,
        `${id} supersedes ${data.supersedes}, but that item's status is "${tree.items.get(data.supersedes).data.status}" rather than "superseded"`,
      )
  }

  for (const m of data.affects ?? [])
    if (!tree.modules.has(m)) err(file, `${id} affects unknown module "${m}"`)

  for (const m of data.implemented_by ?? [])
    if (!tree.modules.has(m)) err(file, `${id} implemented_by unknown module "${m}"`)

  // Traceability: an active rule nobody verifies is knowledge debt.
  if (data.type === 'business-rule' && data.status === 'active' && !isVerified(id, tree.items))
    warn(file, `${id} is active but no contract verifies it`)
}

// A superseded item must have an active replacement. The check above enforces
// this from the replacement's side; without the mirror, an item can be retired
// in favour of something still in draft, and then nothing active describes
// behaviour the system actually has.
//
// Found in the brownfield pilot, where an assumption about field vocabularies
// was marked superseded by a rule that was never promoted out of draft. Both
// items validated cleanly and the tree had a hole where its current account of
// that behaviour should have been.
for (const [id, { file, data }] of tree.items) {
  if (data.status !== 'superseded') continue
  const replacements = [...tree.items.values()].filter((o) => o.data.supersedes === id)
  if (!replacements.length) {
    err(file, `${id} is superseded but no item supersedes it`)
    continue
  }
  if (!replacements.some((o) => o.data.status === 'active'))
    err(
      file,
      `${id} is superseded, but ${replacements
        .map((o) => `${o.data.id} is "${o.data.status}"`)
        .join(' and ')}. Retiring knowledge in favour of a draft leaves nothing active describing this behaviour.`,
    )
}

// ---------------------------------------------------------------- report

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

console.log(`Regen Engineering schema v0.1  ${relative(process.cwd(), tree.root) || '.'}`)
console.log(
  `Scanned ${plural(tree.items.size, 'item')} across ${plural(tree.modules.size, 'module')}: ${[...tree.modules].sort().join(', ') || 'none'}`,
)

for (const w of warnings) console.log(`  warn   ${w.file}: ${w.msg}`)
for (const e of errors) console.log(`  ERROR  ${e.file}: ${e.msg}`)

if (errors.length) {
  console.log(`\nFAILED with ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}.`)
  process.exit(1)
}
console.log(`\nOK. ${plural(warnings.length, 'warning')}.`)

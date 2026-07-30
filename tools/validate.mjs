#!/usr/bin/env node
// Reference validator for the Regen Engineering knowledge schema.
// Validates frontmatter and lock files, then resolves every link in the
// knowledge graph. Non-zero exit on any error, so it drops straight into CI.
//
//   node tools/validate.mjs [tree]

import { readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
// The default ajv export only understands draft-07; the schemas here declare
// 2020-12, which needs this build.
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { loadTree, isVerified } from './lib/load.mjs'

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

for (const [module, { file, data }] of tree.locks) {
  if (!validateLock(data)) {
    err(file, `lock schema: ${ajvErrors(validateLock)}`)
    continue
  }
  if (data.module !== module)
    err(file, `lock declares module "${data.module}" but sits in "${module}"`)
  if (!tree.modules.has(data.module))
    err(file, `lock names module "${data.module}" which does not exist`)
  for (const c of data.contracts_passed ?? [])
    if (!tree.items.has(c)) err(file, `contracts_passed references unknown contract ${c}`)
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

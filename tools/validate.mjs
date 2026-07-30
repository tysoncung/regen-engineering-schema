#!/usr/bin/env node
// Reference validator for the Regen Engineering knowledge schema.
// Walks a knowledge tree, validates frontmatter and lock files, and resolves
// every link in the knowledge graph. Non-zero exit on any error, so it drops
// straight into CI.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, basename, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
// The default ajv export only understands draft-07; the schemas here declare
// 2020-12, which needs this build.
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = join(HERE, '..', 'schemas')
const IGNORED = new Set(['node_modules', '.git', 'dist', '.astro', '.next'])
const ITEM_DIRS = new Set(['rules', 'decisions', 'contracts', 'assumptions', 'nfr'])

const errors = []
const warnings = []
const err = (file, msg) => errors.push({ file, msg })
const warn = (file, msg) => warnings.push({ file, msg })

// ---------------------------------------------------------------- schemas

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const validateItem = ajv.compile(
  JSON.parse(readFileSync(join(SCHEMA_DIR, 'knowledge-item.schema.json'), 'utf8')),
)
const validateLock = ajv.compile(
  JSON.parse(readFileSync(join(SCHEMA_DIR, 'knowledge-lock.schema.json'), 'utf8')),
)

// ---------------------------------------------------------------- helpers

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// Frontmatter is the YAML block delimited by --- at the very start of the file.
function readFrontmatter(file) {
  const text = readFileSync(file, 'utf8')
  if (!text.startsWith('---')) return { missing: true }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { unterminated: true }
  try {
    return { data: parseYaml(text.slice(3, end)) ?? {} }
  } catch (e) {
    return { parseError: e.message }
  }
}

const ajvErrors = (v) =>
  (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')

// ---------------------------------------------------------------- collect

const root = resolve(process.argv[2] ?? 'example')
let files
try {
  files = walk(root)
} catch {
  console.error(`Cannot read knowledge tree at ${root}`)
  process.exit(2)
}

const rel = (f) => relative(root, f) || basename(f)

// A directory named `knowledge` marks a module: the module is its parent
// directory. A `knowledge` directory at the tree root is global knowledge,
// owned by no module.
const modules = new Set()
const knowledgeIndex = (file) => relative(root, file).split(sep).indexOf('knowledge')

for (const f of files) {
  const k = knowledgeIndex(f)
  if (k > 0) modules.add(relative(root, f).split(sep)[k - 1])
}

const items = new Map() // id -> { file, data }

for (const file of files) {
  const parent = basename(dirname(file))
  const inKnowledge = knowledgeIndex(file) !== -1

  if (basename(file) === 'knowledge.lock') {
    let data
    try {
      data = parseYaml(readFileSync(file, 'utf8'))
    } catch (e) {
      err(rel(file), `lock file is not valid YAML: ${e.message}`)
      continue
    }
    if (!validateLock(data)) err(rel(file), `lock schema: ${ajvErrors(validateLock)}`)
    else if (data.module && !modules.has(data.module))
      err(rel(file), `lock names module "${data.module}" which does not exist`)
    continue
  }

  if (!file.endsWith('.md') || !inKnowledge || !ITEM_DIRS.has(parent)) continue

  const fm = readFrontmatter(file)
  if (fm.missing) {
    err(rel(file), 'item file has no YAML frontmatter')
    continue
  }
  if (fm.unterminated) {
    err(rel(file), 'frontmatter block is not terminated with ---')
    continue
  }
  if (fm.parseError) {
    err(rel(file), `frontmatter is not valid YAML: ${fm.parseError}`)
    continue
  }

  const data = fm.data
  if (!validateItem(data)) {
    err(rel(file), `frontmatter schema: ${ajvErrors(validateItem)}`)
    continue
  }
  if (items.has(data.id))
    err(rel(file), `duplicate id ${data.id}, already defined in ${items.get(data.id).file}`)
  else items.set(data.id, { file: rel(file), data })
}

// ---------------------------------------------------------------- graph

const has = (id) => items.has(id)

for (const [id, { file, data }] of items) {
  for (const ref of data.verified_by ?? [])
    if (!has(ref)) err(file, `${id} verified_by references unknown item ${ref}`)

  for (const ref of data.verifies ?? [])
    if (!has(ref)) err(file, `${id} verifies references unknown item ${ref}`)

  if (data.supersedes) {
    if (!has(data.supersedes))
      err(file, `${id} supersedes references unknown item ${data.supersedes}`)
    else if (items.get(data.supersedes).data.status !== 'superseded')
      err(
        file,
        `${id} supersedes ${data.supersedes}, but that item's status is "${items.get(data.supersedes).data.status}" rather than "superseded"`,
      )
  }

  for (const m of data.affects ?? [])
    if (!modules.has(m)) err(file, `${id} affects unknown module "${m}"`)

  for (const m of data.implemented_by ?? [])
    if (!modules.has(m)) err(file, `${id} implemented_by unknown module "${m}"`)

  // Traceability: an active rule nobody verifies is knowledge debt.
  if (data.type === 'business-rule' && data.status === 'active') {
    const verified =
      (data.verified_by ?? []).length > 0 ||
      [...items.values()].some((o) => (o.data.verifies ?? []).includes(id))
    if (!verified) warn(file, `${id} is active but no contract verifies it`)
  }
}

// ---------------------------------------------------------------- report

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

console.log(`Regen Engineering schema v0.1  ${relative(process.cwd(), root) || '.'}`)
console.log(
  `Scanned ${plural(items.size, 'item')} across ${plural(modules.size, 'module')}: ${[...modules].sort().join(', ') || 'none'}`,
)

for (const w of warnings) console.log(`  warn   ${w.file}: ${w.msg}`)
for (const e of errors) console.log(`  ERROR  ${e.file}: ${e.msg}`)

if (errors.length) {
  console.log(`\nFAILED with ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}.`)
  process.exit(1)
}
console.log(`\nOK. ${plural(warnings.length, 'warning')}.`)

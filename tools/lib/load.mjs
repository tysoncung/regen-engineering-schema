// Shared loader for a Regen Engineering knowledge tree.
// validate, impact, and debt all read the tree through this, so they can never
// disagree about what a module is or which files count as knowledge items.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, basename, dirname, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

export const IGNORED = new Set(['node_modules', '.git', 'dist', '.astro', '.next', 'coverage'])
export const ITEM_DIRS = new Set(['rules', 'decisions', 'contracts', 'assumptions', 'nfr', 'risks', 'issues'])
// knowledge.lock, or knowledge.<stack>.lock when a module has several stacks.
export const LOCK_PATTERN = /^knowledge(?:\.([a-z0-9][a-z0-9-]*))?\.lock$/

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// Frontmatter is the YAML block delimited by --- at the very start of a file.
export function readFrontmatter(file) {
  const text = readFileSync(file, 'utf8')
  if (!text.startsWith('---')) return { missing: true }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { unterminated: true }
  try {
    return { data: parseYaml(text.slice(3, end)) ?? {}, body: text.slice(end + 4) }
  } catch (e) {
    return { parseError: e.message }
  }
}

export const ID_PATTERN = /\b(?:BR|ADR|CT|NFR|ASM|RISK|ISS)-[0-9]{3,}\b/g

/** The module a knowledge item belongs to, or null for global knowledge. */
export function ownerOf(item) {
  const first = item.file.split(sep)[0]
  return first === 'knowledge' ? null : first
}

/**
 * Load a knowledge tree.
 *
 * A directory named `knowledge` marks a module: the module is its parent
 * directory. A `knowledge` directory at the tree root is global knowledge,
 * owned by no module.
 *
 * Returns { root, rel, modules, items, locks, problems } where items maps
 * id -> { file, data } and locks maps module -> { file, data }.
 */
export function loadTree(rootPath) {
  const root = resolve(rootPath)
  const files = walk(root)
  const rel = (f) => relative(root, f) || basename(f)
  const knowledgeIndex = (file) => rel(file).split(sep).indexOf('knowledge')

  const modules = new Set()
  for (const f of files) {
    const k = knowledgeIndex(f)
    if (k > 0) modules.add(rel(f).split(sep)[k - 1])
  }

  const items = new Map()
  const locks = new Map()
  const problems = []

  for (const file of files) {
    // `knowledge.lock`, or `knowledge.<stack>.lock` when a module has more than
    // one implementation. Locks are keyed by module and stack so two stacks
    // cannot silently overwrite each other's provenance.
    const lockName = LOCK_PATTERN.exec(basename(file))
    if (lockName) {
      const module = basename(dirname(file))
      const stack = lockName[1] ?? null
      try {
        const data = parseYaml(readFileSync(file, 'utf8'))
        locks.set(stack ? `${module}:${stack}` : module, {
          file: rel(file),
          data,
          module,
          stack: stack ?? data?.stack ?? null,
        })
      } catch (e) {
        problems.push({ file: rel(file), msg: `lock file is not valid YAML: ${e.message}` })
      }
      continue
    }

    if (!file.endsWith('.md')) continue
    if (knowledgeIndex(file) === -1) continue
    if (!ITEM_DIRS.has(basename(dirname(file)))) continue

    const fm = readFrontmatter(file)
    if (fm.missing) {
      problems.push({ file: rel(file), msg: 'item file has no YAML frontmatter' })
      continue
    }
    if (fm.unterminated) {
      problems.push({ file: rel(file), msg: 'frontmatter block is not terminated with ---' })
      continue
    }
    if (fm.parseError) {
      problems.push({ file: rel(file), msg: `frontmatter is not valid YAML: ${fm.parseError}` })
      continue
    }
    if (!fm.data?.id) {
      problems.push({ file: rel(file), msg: 'frontmatter has no id' })
      continue
    }
    if (items.has(fm.data.id)) {
      problems.push({
        file: rel(file),
        msg: `duplicate id ${fm.data.id}, already defined in ${items.get(fm.data.id).file}`,
      })
      continue
    }
    items.set(fm.data.id, { file: rel(file), data: fm.data, body: fm.body ?? '' })
  }

  return { root, rel, files, modules, items, locks, problems }
}

/** Every lock belonging to a module. More than one means several stacks. */
export function locksFor(module, tree) {
  return [...tree.locks.values()].filter((l) => l.module === module)
}

/** Items that verify the given id, looked up from the contract side. */
export function verifiersOf(id, items) {
  return [...items.values()].filter((o) => (o.data.verifies ?? []).includes(id)).map((o) => o.data.id)
}

/** True when an item has at least one contract verifying it, from either direction. */
export function isVerified(id, items) {
  const item = items.get(id)
  if (!item) return false
  return (item.data.verified_by ?? []).length > 0 || verifiersOf(id, items).length > 0
}

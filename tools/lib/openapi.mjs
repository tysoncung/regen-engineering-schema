// REP-0002: interface contracts for modules exposing an API.
//
// The Regeneration Test failed exclusively on wire-format questions the prose
// never answered, and a contract exercised an endpoint no overview documented.
// These checks make that class of gap structural rather than discoverable only
// by regenerating.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** Method+path rows from a markdown interface table in an overview. */
export function prosePathRows(overviewText) {
  const rows = []
  for (const line of overviewText.split('\n')) {
    const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\|\s*`([^`]+)`/.exec(line.trim())
    if (m) rows.push({ method: m[1], path: m[2] })
  }
  return rows
}

/** Parameter names differ legitimately ({id} vs {addressId}); shape does not. */
export const normalisePath = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/'

/**
 * Check one module's interface documentation against its OpenAPI contract.
 * Returns { errors: [], warnings: [] }.
 */
export function checkModuleInterface(moduleDir, overviewText) {
  const errors = []
  const warnings = []
  const rows = prosePathRows(overviewText)
  const openapiPath = join(moduleDir, 'knowledge', 'api.openapi.yaml')
  const hasOpenapi = existsSync(openapiPath)

  // A module that documents no HTTP interface needs no interface contract.
  if (!rows.length && !hasOpenapi) return { errors, warnings }

  if (rows.length && !hasOpenapi) {
    errors.push(
      `overview.md documents ${rows.length} HTTP operation(s) but the package has no api.openapi.yaml. ` +
        `Wire format expressed only in prose is where regeneration fails; see REP-0002.`,
    )
    return { errors, warnings }
  }

  let spec
  try {
    spec = parseYaml(readFileSync(openapiPath, 'utf8'))
  } catch (e) {
    errors.push(`api.openapi.yaml is not valid YAML: ${e.message}`)
    return { errors, warnings }
  }

  if (!spec?.paths || typeof spec.paths !== 'object') {
    errors.push('api.openapi.yaml has no paths object')
    return { errors, warnings }
  }

  const specOps = new Set()
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item ?? {})) {
      if (METHODS.includes(method.toUpperCase())) specOps.add(`${method.toUpperCase()} ${normalisePath(p)}`)
    }
  }

  // The prose table is a summary of the contract. A row the contract does not
  // contain means the two disagree, and the machine-readable file wins.
  for (const row of rows) {
    const key = `${row.method} ${normalisePath(row.path)}`
    if (!specOps.has(key))
      errors.push(
        `overview.md lists "${row.method} ${row.path}" but api.openapi.yaml has no such operation. ` +
          `The OpenAPI file is authoritative; fix whichever is wrong.`,
      )
  }

  // The reverse is only a warning: a summary may legitimately omit operations,
  // but silence about most of the surface usually means the table went stale.
  const proseKeys = new Set(rows.map((r) => `${r.method} ${normalisePath(r.path)}`))
  const missing = [...specOps].filter((k) => !proseKeys.has(k))
  if (rows.length && missing.length > rows.length)
    warnings.push(
      `overview.md summarises ${rows.length} operation(s) but api.openapi.yaml defines ${specOps.size}; the summary may be stale`,
    )

  return { errors, warnings, operations: specOps }
}

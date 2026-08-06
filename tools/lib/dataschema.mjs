// REP-0005: schema as knowledge, and migrations as an append-only type.
//
// The methodology's central claim is an asymmetry: implementations are cheap and
// replaceable, knowledge is scarce and durable. Data breaks that asymmetry,
// because data is neither. It cannot be regenerated from knowledge, cannot be
// thrown away, and usually cannot be rolled back.
//
// So the shape of stored data has to be knowledge, and the history of how it got
// that shape has to be knowledge too. These checks make both structural.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export const DATA_SCHEMA_FILE = 'data.schema.yaml'

// Verbs and nouns that betray a module storing something. Used only to warn,
// never to fail: prose is not a reliable signal, and a false accusation of
// owning data is more annoying than a missed one.
const PERSISTENCE_HINTS =
  /\b(stored|persist(s|ed|ence)?|database|table|row|rows|column|schema|record(s|ed)?\s+(are|is)\s+kept|written to disk|migration)\b/i

/**
 * Check one module's data schema, if it has or should have one.
 * Returns { errors, warnings, schema }.
 */
export function checkModuleData(moduleDir, overviewText, ajv, schemaJson) {
  const errors = []
  const warnings = []
  const path = join(moduleDir, 'knowledge', DATA_SCHEMA_FILE)

  if (!existsSync(path)) {
    if (PERSISTENCE_HINTS.test(overviewText)) {
      warnings.push(
        `the overview describes stored data but the module carries no ${DATA_SCHEMA_FILE}. ` +
          `Two regenerations of the same knowledge could reasonably invent different shapes, ` +
          `and the second one orphans every existing row.`,
      )
    }
    return { errors, warnings, schema: null }
  }

  let schema
  try {
    schema = parseYaml(readFileSync(path, 'utf8'))
  } catch (e) {
    errors.push(`${DATA_SCHEMA_FILE} is not valid YAML: ${e.message}`)
    return { errors, warnings, schema: null }
  }

  const validate = ajv.compile(schemaJson)
  if (!validate(schema)) {
    for (const e of validate.errors) errors.push(`${DATA_SCHEMA_FILE}${e.instancePath}: ${e.message}`)
    return { errors, warnings, schema: null }
  }

  // Identity must name fields that exist. A logical identity pointing at nothing
  // is the kind of error that survives review and breaks a regeneration.
  for (const [name, entity] of Object.entries(schema.entities)) {
    const fieldNames = new Set(entity.fields.map((f) => f.name))
    for (const id of entity.identity ?? []) {
      if (!fieldNames.has(id))
        errors.push(`${DATA_SCHEMA_FILE}: entity "${name}" has identity "${id}", which is not one of its fields`)
    }
    if (!entity.identity?.length)
      warnings.push(
        `${DATA_SCHEMA_FILE}: entity "${name}" states no identity, so nothing records how one is told from another`,
      )
    // A field added at a version the schema has not reached yet is a copy-paste error.
    for (const f of entity.fields) {
      if (f.since && f.since > schema.version)
        errors.push(
          `${DATA_SCHEMA_FILE}: field "${name}.${f.name}" claims since ${f.since}, but the schema is at version ${schema.version}`,
        )
    }
  }

  for (const [i, rel] of (schema.relationships ?? []).entries()) {
    for (const side of ['from', 'to']) {
      if (!schema.entities[rel[side]])
        errors.push(`${DATA_SCHEMA_FILE}: relationship ${i} names unknown entity "${rel[side]}" as ${side}`)
    }
  }

  return { errors, warnings, schema }
}

/**
 * Check the migration chain for a module against its data schema.
 *
 * Migrations are append-only and describe events that already happened to real
 * data, so the chain is the thing worth checking: an unbroken sequence, and a
 * schema version that matches where the chain ends. A gap means a step was lost;
 * a mismatch means the model and its history disagree about what shape the data
 * is in, and one of them is lying to the next person who reads it.
 */
export function checkMigrationChain(module, migrations, schema) {
  const errors = []
  const warnings = []
  if (!migrations.length) {
    if (schema && schema.version > 1)
      warnings.push(
        `${module}: the data schema is at version ${schema.version} but no migration records how it got past 1. ` +
          `The shape is recorded and the history that produced it is not.`,
      )
    return { errors, warnings }
  }

  const sorted = [...migrations].sort((a, b) => a.data.from - b.data.from)

  for (const m of sorted) {
    if (m.data.to !== m.data.from + 1)
      errors.push(`${m.data.id} goes from ${m.data.from} to ${m.data.to}; a migration is one step`)
  }

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (cur.data.from !== prev.data.to)
      errors.push(
        `migration chain is broken: ${prev.data.id} ends at ${prev.data.to} and ${cur.data.id} starts at ${cur.data.from}`,
      )
  }

  if (sorted[0].data.from !== 1)
    errors.push(`the migration chain starts at ${sorted[0].data.from}; the first migration must go from 1`)

  // An applied migration is a record of something that happened. An unapplied
  // one behind an applied one means the history is out of order.
  let seenUnapplied = null
  for (const m of sorted) {
    if (!m.data.applied_at) seenUnapplied = m.data.id
    else if (seenUnapplied)
      errors.push(`${m.data.id} is applied but ${seenUnapplied} before it is not, so the recorded history has a hole`)
  }

  if (schema) {
    const applied = sorted.filter((m) => m.data.applied_at)
    const highest = applied.length ? applied[applied.length - 1].data.to : 1
    if (schema.version !== highest)
      errors.push(
        `${module}: the data schema says version ${schema.version}, but the applied migrations end at ${highest}. ` +
          `The model and its history disagree about what shape the data is in.`,
      )
  }

  return { errors, warnings }
}

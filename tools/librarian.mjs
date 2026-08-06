#!/usr/bin/env node
// The Librarian: read the whole tree, not the diff.
//
//   node tools/librarian.mjs [tree] [--json] [--bundle]
//
// Every other tool here looks at a change. This one looks at the corpus, and
// hunts for the failures that only appear when items are read against each
// other: contradictions, orphans, staleness, duplication, and confidence that
// should have moved.
//
// REP-0006 specifies the Librarian as an agent, and it is. This tool is
// deliberately only its cheap half. The division is:
//
//   mechanical (here)   candidates, found by structure and arithmetic. Fast,
//                       free, deterministic, and reproducible. Finds where to
//                       look. Cannot tell you whether what it found is wrong.
//   reading (an agent)  judgement. Whether two rules actually contradict,
//                       whether a duplicate is redundancy or emphasis, whether
//                       an old draft is stale or simply settled.
//
// Running only this half and calling it a Librarian would repeat the exact
// mistake REP-0006 exists to fix: a validator that reports no problems because
// nothing structural is wrong. `--bundle` emits the packet for the reading half.
//
// Exit code is 0 always. These are candidates for a human to read, not build
// breaks, and a tool that fails a build on a heuristic teaches people to
// disable it.

import { readFileSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'
import { loadTree, ownerOf, ID_PATTERN, ITEM_DIRS, LOCK_PATTERN } from './lib/load.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const bundle = argv.includes('--bundle')
const treeArg = argv.find((a) => !a.startsWith('--'))
const tree = loadTree(treeArg ?? process.env.REGEN_TREE ?? 'example')

const DRAFT_DAYS = Number(process.env.REGEN_DRAFT_DAYS ?? 30)
const DUP_THRESHOLD = Number(process.env.REGEN_DUP_THRESHOLD ?? 0.5)

const today = new Date()
const daysSince = (d) => {
  const t = Date.parse(d)
  return Number.isNaN(t) ? null : Math.floor((today - t) / 86400000)
}

const items = [...tree.items.values()]
const findings = []
const add = (kind, severity, msg, detail = {}) => findings.push({ kind, severity, msg, ...detail })

// ------------------------------------------------------------ citation graph
// Who mentions whom, from both the frontmatter links and the prose. Prose
// counts: a rule referenced only in another rule's body is still referenced,
// and treating it as an orphan would be wrong.

const cites = new Map(items.map((i) => [i.data.id, new Set()]))
const citedBy = new Map(items.map((i) => [i.data.id, new Set()]))

const LINK_FIELDS = ['verifies', 'verified_by', 'depends_on', 'supersedes', 'superseded_by', 'refines', 'related']
for (const item of items) {
  const out = new Set()
  for (const f of LINK_FIELDS) for (const v of item.data[f] ?? []) out.add(v)
  for (const m of item.body.matchAll(ID_PATTERN)) out.add(m[0])
  out.delete(item.data.id)
  for (const target of out) {
    if (!tree.items.has(target)) continue
    cites.get(item.data.id).add(target)
    citedBy.get(target).add(item.data.id)
  }
}

// A tree is not only its items. Overviews, vision, and lock files all reference
// rules, and a rule cited from an overview is plainly not an orphan. Missing
// this produced exactly that false positive against the brownfield pilot, where
// ADR-103 was reported as referenced by nothing while the module overview named
// it. A tool that invents orphans gets switched off, so context files count.
const contextRefs = new Map()
for (const file of tree.files) {
  const isLock = LOCK_PATTERN.test(basename(file))
  const isKnowledgeDoc =
    file.endsWith('.md') &&
    tree.rel(file).split(sep).includes('knowledge') &&
    !ITEM_DIRS.has(basename(dirname(file)))
  if (!isLock && !isKnowledgeDoc) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const m of text.matchAll(ID_PATTERN)) {
    if (!tree.items.has(m[0])) continue
    citedBy.get(m[0]).add(tree.rel(file))
    contextRefs.set(m[0], (contextRefs.get(m[0]) ?? 0) + 1)
  }
}

// -------------------------------------------------------- quantitative claims
// The BR-011 / BR-012 case in the reference demo: one rule caps a customer's
// address book at twenty, another caps the address *list response* at fifty.
// Both files are individually well formed, so validation passes. Both are
// wholly reasonable read alone. The contradiction exists only between them.
//
// Numbers are the one kind of claim a machine can compare without understanding
// it, which makes this the one contradiction class worth attempting mechanically.
// It reports tension, not error: two rules can legitimately state different
// numbers about the same noun, and deciding that is the reading half's job.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
}

// Words that can sit between a number and the thing it counts, and words that
// can never be the thing itself.
const NOT_A_NOUN = new Set([
  'most', 'more', 'than', 'the', 'a', 'an', 'of', 'to', 'at', 'in', 'on', 'and', 'or', 'is', 'are',
  'be', 'been', 'per', 'each', 'every', 'other', 'same', 'such', 'only', 'least', 'up', 'no', 'not',
  'its', 'it', 'this', 'that', 'these', 'those', 'has', 'have', 'had', 'was', 'were', 'will', 'would',
  'can', 'could', 'may', 'might', 'must', 'should', 'does', 'do', 'did', 'then', 'when', 'if', 'so',
  'but', 'for', 'with', 'by', 'from', 'as', 'into', 'over', 'under', 'after', 'before', 'during',
  'while', 'because', 'since', 'until', 'total', 'further', 'additional', 'existing', 'new', 'first',
  'last', 'next', 'previous', 'above', 'below', 'exactly', 'about', 'around', 'least', 'separate',
  // Adverbs and connectives, which otherwise land in the noun slot and produce
  // findings about how many "never" the tree contains.
  'never', 'always', 'still', 'also', 'both', 'either', 'neither', 'again', 'once', 'twice',
  'therefore', 'however', 'already', 'yet', 'ever', 'just', 'even', 'rather', 'instead', 'here',
  'there', 'where', 'which', 'who', 'whom', 'whose', 'what', 'how', 'why', 'they', 'them', 'their',
  'we', 'our', 'you', 'your', 'his', 'her', 'him', 'she', 'he', 'one', 'two', 'three',
])

// Bare HTTP status codes. A contract asserting 201 and another asserting 409
// are not in tension, and in a tree full of interface contracts they are the
// single largest source of spurious numbers.
const HTTP_STATUS = new Set([
  100, 101, 200, 201, 202, 203, 204, 206, 301, 302, 303, 304, 307, 308,
  400, 401, 402, 403, 404, 405, 406, 408, 409, 410, 412, 413, 415, 418, 422, 423, 429,
  500, 501, 502, 503, 504,
])

// Nouns whose numbers are protocol facts rather than domain limits. A contract
// asserting 200 and another asserting 404 is not a contradiction.
const NOT_A_SUBJECT = new Set([
  'status', 'code', 'codes', 'response', 'responses', 'error', 'errors', 'version', 'versions',
  'id', 'ids', 'header', 'headers', 'second', 'seconds', 'ms', 'millisecond', 'milliseconds',
  'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months',
  'year', 'years', 'percent', 'section', 'step', 'steps', 'point', 'points',
])

// Qualifiers, split by which way they bound. The direction is what makes the
// comparison meaningful: "at least one" and "at most twenty" are different
// numbers about the same noun and are not in tension, whereas "at most twenty"
// and "more than fifty" cannot both describe a reachable state.
const UPPER = ['at most', 'no more than', 'not more than', 'up to', 'a maximum of', 'maximum of',
  'max of', 'limited to', 'capped at', 'caps at', 'cap of', 'fewer than', 'less than']
const LOWER = ['at least', 'a minimum of', 'minimum of', 'greater than', 'more than', 'exceeds', 'exceed']
const QUALIFIERS = [...UPPER, ...LOWER].sort((a, b) => b.length - a.length)
const isUpper = (q) => UPPER.includes(q)

const singular = (w) => {
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Every "<number> <noun>" claim in a body, with the limiting qualifier if present. */
function quantitativeClaims(body) {
  // Strip fenced code and inline links, both of which are full of numbers that
  // mean nothing here. Ordered-list markers go too: "4. That customers holding"
  // is not a claim about four customers.
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/\b(?:BR|ADR|CT|NFR|ASM|RISK|ISS|MIG)-\d+\b/g, ' ')
    .replace(/^\s{0,3}\d{1,3}[.)]\s+/gm, ' ')
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')

  const words = text.split(/\s+/).map((w) => w.replace(/^[^\w-]+|[^\w-]+$/g, ''))
  const claims = []

  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase()
    let value = null
    if (/^\d{1,6}$/.test(w)) value = Number(w)
    else if (w in NUMBER_WORDS) value = NUMBER_WORDS[w]
    if (value === null) continue
    // Years, and the ordinal-looking cases.
    if (value >= 1900 && value <= 2100) continue
    if (/^\d+$/.test(w) && HTTP_STATUS.has(value)) continue

    // The counted noun: the first plausible noun within three words.
    let subject = null
    for (let j = i + 1; j <= i + 3 && j < words.length; j++) {
      const c = words[j].toLowerCase().replace(/[^a-z-]/g, '')
      if (c.length < 3 || NOT_A_NOUN.has(c)) continue
      subject = singular(c)
      break
    }
    if (!subject || NOT_A_SUBJECT.has(subject) || NOT_A_SUBJECT.has(`${subject}s`)) continue

    // The qualifier, looked for in the four words before the number.
    const before = words.slice(Math.max(0, i - 4), i).join(' ').toLowerCase()
    const qualifier = QUALIFIERS.find((q) => before.endsWith(q)) ?? null

    claims.push({ value, subject, qualifier, phrase: words.slice(Math.max(0, i - 2), i + 4).join(' ') })
  }
  return claims
}

// Group by subject. Global knowledge constrains every module, so it joins each
// module's group rather than forming one of its own.
const bySubject = new Map()
for (const item of items) {
  const owner = ownerOf(item)
  for (const claim of quantitativeClaims(item.body)) {
    const scopes = owner ? [owner] : [...tree.modules, '(global)']
    for (const scope of scopes) {
      const key = `${scope}::${claim.subject}`
      if (!bySubject.has(key)) bySubject.set(key, [])
      bySubject.get(key).push({ ...claim, id: item.data.id, file: item.file, owner })
    }
  }
}

for (const [key, all] of [...bySubject].sort()) {
  const [scope, subject] = key.split('::')

  // Only bounded claims take part. A contract setting up three addresses and
  // another setting up nineteen are both fine, and counting them as tension
  // buries the one finding that matters.
  const claims = all.filter((c) => c.qualifier)

  // One claim per item, keeping its tightest upper bound.
  const perItem = new Map()
  for (const c of claims) {
    const held = perItem.get(c.id)
    if (!held || (isUpper(c.qualifier) && (!isUpper(held.qualifier) || c.value < held.value))) perItem.set(c.id, c)
  }
  if (perItem.size < 2) continue

  // Tension is an upper bound that something else in the tree exceeds. Without
  // a ceiling there is nothing to violate.
  const ceilings = [...perItem.values()].filter((c) => isUpper(c.qualifier))
  if (!ceilings.length) continue
  const ceiling = ceilings.reduce((a, b) => (b.value < a.value ? b : a))
  const over = [...perItem.values()].filter((c) => c.value > ceiling.value)
  if (!over.length) continue

  const involved = [ceiling, ...over]
  add(
    'tension',
    'high',
    `${ceiling.id} bounds "${subject}" at ${ceiling.value}, but ${over.map((c) => c.id).join(' and ')} ` +
      `${over.length > 1 ? 'describe' : 'describes'} ${over.map((c) => c.value).join(' and ')}`,
    {
      scope,
      subject,
      claims: involved.map((c) => ({
        id: c.id, file: c.file, value: c.value, qualifier: c.qualifier, phrase: c.phrase.trim(),
      })),
    },
  )
}

// ------------------------------------------------------------------- orphans
// Knowledge nothing rests on. Either it should be retired, or something that
// depends on it has failed to say so, and the second case shrinks the
// regeneration scope silently.

for (const item of items) {
  const id = item.data.id
  const type = String(item.data.type ?? '')
  const status = String(item.data.status ?? 'active')
  if (status === 'superseded' || status === 'retired' || status === 'rejected') continue

  const incoming = citedBy.get(id)
  const outgoing = cites.get(id)

  if (id.startsWith('CT-')) {
    const verifies = new Set([...(item.data.verifies ?? [])])
    for (const other of items) if ((other.data.verified_by ?? []).includes(id)) verifies.add(other.data.id)
    if (verifies.size === 0)
      add('orphan', 'high', `${id} is a contract that verifies nothing`, { id, file: item.file })
    continue
  }

  if (incoming.size === 0 && outgoing.size === 0)
    add('orphan', 'medium', `${id} is referenced by nothing and references nothing`, { id, file: item.file, type })
  else if (incoming.size === 0 && (id.startsWith('BR-') || id.startsWith('NFR-')))
    add('orphan', 'low', `${id} is referenced by no other knowledge item`, { id, file: item.file, type })
}

// ----------------------------------------------------------------- staleness
// Items that were meant to be temporary and were not.

for (const item of items) {
  const id = item.data.id
  const status = String(item.data.status ?? 'active')
  const since = item.data.since ?? item.data.created ?? null
  const age = since ? daysSince(String(since)) : null

  if (status === 'draft' && age !== null && age > DRAFT_DAYS)
    add('stale', 'medium', `${id} has been a draft for ${age} days`, { id, file: item.file, age })

  if (status === 'proposed' && age !== null && age > DRAFT_DAYS)
    add('stale', 'medium', `${id} has been proposed for ${age} days with no decision`, { id, file: item.file, age })

  const review = item.data.review_by ?? item.data.expires ?? null
  if (review) {
    // daysSince is positive once the date has passed, which is exactly how
    // overdue a review is. Getting this backwards meant no review date could
    // ever be reported, which the tests caught and nothing else would have.
    const overdue = daysSince(String(review))
    if (overdue !== null && overdue > 0)
      add('stale', 'high', `${id} was due for review ${overdue} days ago`, { id, file: item.file, overdue })
  } else if (id.startsWith('ASM-') && status !== 'confirmed' && status !== 'retired') {
    add('stale', 'low', `${id} is an unconfirmed assumption with no review date`, { id, file: item.file })
  }
}

// ------------------------------------------------------- confidence drift
// A low-confidence item that half the tree now depends on has either been
// confirmed by use, or it is load-bearing guesswork. Both need saying out loud.

for (const item of items) {
  const conf = String(item.data.confidence ?? '').toLowerCase()
  if (conf !== 'low' && conf !== 'unverified') continue
  const dependents = citedBy.get(item.data.id)
  if (dependents.size >= 3)
    add(
      'confidence',
      'high',
      `${item.data.id} is marked ${conf} but ${dependents.size} other places rest on it`,
      { id: item.data.id, file: item.file, dependents: [...dependents] },
    )
}

// --------------------------------------------------------------- duplication
// The same fact in two places is drift waiting for one copy to change. Compared
// on content words only, which is crude, and why this reports candidates.

const STOP = new Set([...NOT_A_NOUN, 'must', 'shall', 'rule', 'system', 'customer', 'request', 'returns', 'return'])
const shingle = (body) =>
  new Set(
    body.replace(/```[\s\S]*?```/g, ' ').toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [],
  )

const shingles = items.map((i) => ({ item: i, set: shingle(i.body) }))
for (let a = 0; a < shingles.length; a++) {
  for (let b = a + 1; b < shingles.length; b++) {
    const A = shingles[a], B = shingles[b]
    if (A.set.size < 12 || B.set.size < 12) continue
    if (A.item.data.id.slice(0, 3) !== B.item.data.id.slice(0, 3)) continue
    let shared = 0
    for (const w of A.set) if (B.set.has(w)) shared++
    const jaccard = shared / (A.set.size + B.set.size - shared)
    if (jaccard >= DUP_THRESHOLD)
      add('duplication', 'medium', `${A.item.data.id} and ${B.item.data.id} are ${Math.round(jaccard * 100)}% similar`, {
        ids: [A.item.data.id, B.item.data.id],
        files: [A.item.file, B.item.file],
        similarity: Math.round(jaccard * 100),
      })
  }
}

// ------------------------------------------------------------------- output

const RANK = { high: 0, medium: 1, low: 2 }
findings.sort((x, y) => RANK[x.severity] - RANK[y.severity] || x.kind.localeCompare(y.kind) || x.msg.localeCompare(y.msg))

if (bundle) {
  // The packet for the reading half. Deliberately the whole corpus: the
  // Librarian's whole point is that it reads everything, and a bundle that
  // pre-filtered would smuggle a validator's judgement into a reader's job.
  const out = []
  out.push('# Knowledge tree review packet')
  out.push('')
  out.push(`Tree: ${tree.root}`)
  out.push(`${items.length} items across ${tree.modules.size} module(s).`)
  out.push('')
  out.push('You are reading this whole corpus at once, which is the one thing the')
  out.push('structural tooling cannot do. Look for what only a reader can see:')
  out.push('contradictions between items that are each individually well formed,')
  out.push('knowledge that is stated in one place and quietly assumed elsewhere,')
  out.push('confidence that should have moved in either direction, and rules whose')
  out.push('stated reason no longer matches what the rest of the tree describes.')
  out.push('')
  out.push('Report findings with the items they involve and the evidence, quoted.')
  out.push('Where you are unsure, say unsure. A confident wrong finding costs more')
  out.push('review attention than a missed one, because it trains people to stop')
  out.push('reading the channel.')
  out.push('')
  out.push('## Mechanical candidates already found')
  out.push('')
  if (!findings.length) out.push('None. This says nothing about whether the knowledge is right.')
  for (const f of findings) out.push(`- [${f.severity}] ${f.kind}: ${f.msg}`)
  out.push('')
  out.push('## The corpus')
  for (const item of items.sort((a, b) => a.file.localeCompare(b.file))) {
    out.push('')
    out.push(`### ${item.data.id} (${item.file})`)
    out.push('')
    out.push(`\`\`\`yaml\n${Object.entries(item.data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n\`\`\``)
    out.push(item.body.trim())
  }
  console.log(out.join('\n'))
  process.exit(0)
}

if (json) {
  console.log(JSON.stringify({ tree: tree.root, items: items.length, findings }, null, 2))
  process.exit(0)
}

console.log(`Librarian: read ${items.length} item(s) across ${tree.modules.size} module(s) in ${tree.root}`)
console.log()

if (tree.problems.length) {
  console.log(`${tree.problems.length} item(s) could not be read, and were not reviewed:`)
  for (const p of tree.problems) console.log(`  ${p.file}: ${p.msg}`)
  console.log()
}

if (!findings.length) {
  console.log('No mechanical candidates.')
} else {
  const byKind = new Map()
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  const LABEL = {
    tension: 'Quantitative tension',
    orphan: 'Orphans',
    stale: 'Staleness',
    confidence: 'Confidence that should have moved',
    duplication: 'Duplication candidates',
  }
  for (const [kind, list] of byKind) {
    console.log(`${LABEL[kind] ?? kind} (${list.length})`)
    for (const f of list) {
      console.log(`  [${f.severity}] ${f.msg}`)
      for (const c of f.claims ?? []) console.log(`         ${c.id}: "${c.phrase}"  (${c.file})`)
      if (f.dependents) console.log(`         depended on by ${f.dependents.join(', ')}`)
    }
    console.log()
  }
}

console.log('These are candidates, not verdicts. Nothing here has been read for meaning:')
console.log('structure and arithmetic found where to look, and deciding whether any of')
console.log('it is actually wrong is the reading pass. Run with --bundle for that.')

#!/usr/bin/env node
// The Gatherer: find changes that implied knowledge nobody wrote down.
//
//   node tools/gather.mjs [tree] [--since <ref>] [--bundle] [--read] [--json]
//
// Distinct from `mine`, which is a one-shot bootstrap for a codebase with no
// knowledge at all. This is the steady state, and it hunts a smaller, harder
// catch: the commit whose message contains a business rule, the incident fix
// that reveals a constraint, the change where someone explains in prose why
// something must be a certain way.
//
// Those are the moments when knowledge exists in a person's head and is briefly
// written down somewhere that is not the knowledge tree. They are also the
// moments it is cheapest to capture and easiest to lose.
//
// The mechanical half is a filter, and the filter is the whole idea: **commits
// that changed an implementation and did not change any knowledge**. A commit
// that touched both has already recorded itself, whatever else it did. What is
// left is the set of changes that had something to say and no place to say it.
//
// This is history, not the working tree, which is what makes it different from
// drift-check. Drift asks whether the code is ahead right now. This asks what
// was learned along the way and never written down, including in changes that
// have since been superseded, because the reason usually outlives the diff.

import { execFileSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { loadTree, locksFor } from './lib/load.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const bundle = argv.includes('--bundle')
const read = argv.includes('--read')
const sinceIdx = argv.indexOf('--since')
const sinceArg = sinceIdx === -1 ? null : argv[sinceIdx + 1]
const limitIdx = argv.indexOf('--limit')
const LIMIT = limitIdx === -1 ? 40 : Number(argv[limitIdx + 1])
const treeArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--since' && argv[i - 1] !== '--limit')
const treePath = resolve(treeArg ?? process.env.REGEN_TREE ?? 'example')
const tree = loadTree(treePath)

const git = (args, allowFail = true) => {
  try {
    return execFileSync('git', args, { cwd: treePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (e) {
    if (allowFail) return null
    throw e
  }
}

if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
  console.error('Not a git repository. The Gatherer reads history, so there is nothing to read.')
  process.exit(2)
}

// Which paths count as implementation. Declared paths are authoritative; without
// them, fall back to the module directory minus its knowledge, which is the same
// assumption drift-check makes and is wrong often enough to say so out loud.
const implPaths = []
let declared = true
for (const module of tree.modules) {
  const locks = locksFor(module, tree)
  const paths = locks.flatMap((l) => l.data.implementation_paths ?? [])
  if (paths.length) implPaths.push(...paths)
  else {
    declared = false
    implPaths.push(module)
  }
}

const isKnowledge = (f) => f.split(sep).includes('knowledge') || /(^|\/)knowledge(\.[a-z0-9-]+)?\.lock$/.test(f)
const isImplementation = (f) => !isKnowledge(f) && implPaths.some((p) => f === p || f.startsWith(`${p}/`))

// Default window: since the last commit that touched knowledge. Anything after
// that point is, by definition, change the knowledge has not seen.
const since = sinceArg ?? git(['log', '-1', '--format=%H', '--', ...[...tree.modules].map((m) => `${m}/knowledge`), 'knowledge'])

const range = since ? `${since}..HEAD` : 'HEAD'
// The record separator has to come at the START of the format. --name-only
// prints the file list after the formatted line, so a trailing separator files
// each commit's changed files under the next commit's metadata, which silently
// produces a plausible and completely wrong answer.
const raw = git(['log', range, '--no-merges', `--max-count=${LIMIT}`, '--format=%x1e%H%x00%an%x00%aI%x00%s%x00%b', '--name-only'])

const commits = []
for (const block of (raw ?? '').split('\x1e')) {
  const trimmed = block.trim()
  if (!trimmed) continue
  const [meta, ...fileLines] = trimmed.split('\n')
  const [sha, author, date, subject, body] = meta.split('\x00')
  if (!sha) continue
  const files = fileLines.map((l) => l.trim()).filter(Boolean)
  commits.push({ sha, short: sha.slice(0, 7), author, date: date?.slice(0, 10), subject, body: (body ?? '').trim(), files })
}

// The filter. A commit that touched knowledge has already recorded itself.
const candidates = commits.filter((c) => c.files.some(isImplementation) && !c.files.some(isKnowledge))
const recorded = commits.filter((c) => c.files.some(isKnowledge))
const touchedImpl = commits.filter((c) => c.files.some(isImplementation))

// If nothing in the whole range touched anything recognised as implementation,
// the honest answer is that the implementation could not be found, not that the
// history is clean. drift-check shipped this exact false reassurance once: a
// module whose code lives outside its directory reported no drift because every
// changed file had been silently discarded.
const blind = commits.length > 0 && touchedImpl.length === 0

// Prose in a commit message is the strongest single signal that something was
// explained once and never written down. A one-line subject rarely carries a
// rule; three paragraphs about why a limit is what it is almost always does.
const REASON_WORDS = /\b(because|so that|otherwise|must|cannot|never|always|required|due to|in order to|the reason|turns out|it seems|apparently|workaround|for now|temporarily)\b/i
for (const c of candidates) {
  const prose = `${c.subject}\n${c.body}`
  c.signals = []
  if (c.body.length > 120) c.signals.push('a long commit message, which usually means someone was explaining something')
  if (REASON_WORDS.test(prose)) c.signals.push('reasoning words in the message, which often carry a rule or a constraint')
  if (/\b(fix|hotfix|incident|outage|urgent|revert|regression)\b/i.test(prose))
    c.signals.push('an incident-shaped change, where constraints usually surface and rarely get written down')
  c.rank = c.signals.length
}
candidates.sort((a, b) => b.rank - a.rank || (a.date < b.date ? 1 : -1))

const result = {
  tree: treePath,
  since: since ?? null,
  range,
  declaredImplementationPaths: declared,
  implementationPaths: implPaths,
  examined: commits.length,
  recorded: recorded.length,
  touchedImplementation: touchedImpl.length,
  blind,
  candidates: candidates.map(({ sha, short, author, date, subject, body, files, signals, rank }) => ({
    sha, short, author, date, subject, body, signals, rank,
    files: files.filter(isImplementation),
  })),
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

if (bundle || read) {
  const out = []
  out.push('# Changes that may imply unwritten knowledge')
  out.push('')
  out.push(`Repository: ${treePath}`)
  out.push(`Range: ${range}`)
  out.push(`${commits.length} commit(s) examined, ${recorded.length} of which also changed knowledge and are excluded.`)
  out.push('')
  out.push('Each commit below changed an implementation and changed no knowledge.')
  out.push('For each, answer one question: **does this imply something true about the')
  out.push('system that the knowledge does not contain?**')
  out.push('')
  out.push('Separate carefully. Behaviour a caller could observe is a business rule. A')
  out.push('choice between real alternatives is a decision, with the alternatives that')
  out.push('lost. Something believed but unverified, very common after incidents, is an')
  out.push('assumption and not a rule. Incidental implementation detail is none of these')
  out.push('and must not be promoted.')
  out.push('')
  out.push('Most commits imply nothing. Say so and move on. A refactor with no observable')
  out.push('behaviour change has nothing to gather, and inventing knowledge for it is worse')
  out.push('than skipping it.')
  out.push('')
  out.push('**Hunt for justification you invented.** Every causal claim must trace to the')
  out.push('diff or the message. If the commit does not say why, your draft must not either:')
  out.push('write that the reason was not recorded and leave it. A confident wrong sentence')
  out.push('closes a question that a gap would have kept open.')
  out.push('')
  if (!candidates.length) out.push('_No candidates in this range._')
  for (const c of candidates.slice(0, LIMIT)) {
    out.push('')
    out.push(`## ${c.short} ${c.subject}`)
    out.push('')
    out.push(`Author: ${c.author}, ${c.date}`)
    if (c.signals.length) out.push(`Why this was surfaced: ${c.signals.join('; ')}.`)
    out.push('')
    if (c.body) {
      out.push('Message body:')
      out.push('')
      out.push(c.body.split('\n').map((l) => `> ${l}`).join('\n'))
      out.push('')
    }
    out.push(`Files: ${c.files.slice(0, 20).join(', ')}${c.files.length > 20 ? `, and ${c.files.length - 20} more` : ''}`)
    const diff = git(['show', c.sha, '--format=', '--unified=3', '--', ...c.files.slice(0, 20)])
    if (diff) {
      const capped = diff.length > 12000 ? `${diff.slice(0, 12000)}\n... diff truncated ...` : diff
      out.push('')
      out.push('```diff')
      out.push(capped)
      out.push('```')
    }
  }
  const packet = out.join('\n')

  if (bundle) {
    console.log(packet)
    process.exit(0)
  }

  const { ask } = await import('./lib/read.mjs')
  const system = [
    'You are the Gatherer of a Regen Engineering knowledge tree. You are shown commits',
    'that changed an implementation and changed no knowledge, and your job is to notice',
    'which of them implied something true about the system that nobody wrote down.',
    '',
    'Most commits imply nothing. Saying so is the correct answer most of the time, and a',
    'short honest report beats a padded one. Inventing knowledge for a refactor is worse',
    'than skipping it.',
    '',
    'For anything you do find, produce a draft knowledge item: the type (business rule,',
    'decision, or assumption), a title, the body, the evidence quoted from the commit,',
    'and your confidence. Mark everything draft. Never state a reason the commit does not',
    'give: write that the reason was not recorded. Fluent invented justification is the',
    'failure mode here, and it reads as the most competent sentence in the file.',
    '',
    'Distinguish sharply between what the code now does and what the system should do.',
    'An incident hotfix is exactly where those diverge, and recording the first as though',
    'it were the second launders an emergency into a design.',
    '',
    'Output markdown, most valuable first, with a one-line count of how many commits you',
    'examined and how many implied nothing.',
  ].join('\n')

  try {
    const { text, model, base } = await ask({ system, user: packet, maxTokens: 8000 })
    console.log(text.trim())
    console.log()
    console.log('---')
    console.log(`Read ${candidates.length} candidate commit(s) via ${model} at ${base}.`)
    console.log('Drafts only. Nothing here has been agreed, and no knowledge was changed.')
    process.exit(0)
  } catch (e) {
    console.error(`Reading pass failed.\n${e.message}`)
    process.exit(2)
  }
}

console.log(`Gatherer: ${range} in ${treePath}`)
console.log(`${commits.length} commit(s) examined, ${touchedImpl.length} touching the implementation, ${recorded.length} also changing knowledge.`)
if (!declared)
  console.log('Note: some modules declare no implementation_paths, so the whole module directory was assumed. That over-collects.')
console.log()

if (blind) {
  console.log('CANNOT TELL.')
  console.log()
  console.log(`Not one of the ${commits.length} commit(s) in this range touched anything recognised`)
  console.log(`as implementation. The paths searched were: ${implPaths.join(', ')}.`)
  console.log()
  console.log('That is almost never true of a real repository, so the likely explanation is')
  console.log('that the implementation lives somewhere else. Declare implementation_paths in')
  console.log('the module lock and run this again.')
  console.log()
  console.log('Reporting this as "no unwritten knowledge" would be the more comfortable answer')
  console.log('and a false one, which is the failure this check exists to avoid.')
  process.exit(1)
}

if (!commits.length) {
  console.log('No commits in this range at all, so there is nothing to say about them.')
  console.log('That is not a finding. Widen the range with --since if you meant to look further back.')
  process.exit(0)
}

if (!candidates.length) {
  console.log('No commit in this range changed an implementation without also changing knowledge.')
  console.log(`${touchedImpl.length} commit(s) did touch the implementation, and every one of them`)
  console.log('also changed knowledge, which is the clean state: every change that had')
  console.log('something to say found a place to say it.')
  process.exit(0)
}

console.log(`${candidates.length} candidate(s), most likely to carry unwritten knowledge first:`)
console.log()
for (const c of candidates) {
  console.log(`  ${c.short}  ${c.subject}`)
  console.log(`          ${c.author}, ${c.date}, ${c.files.length} file(s)`)
  for (const s of c.signals) console.log(`          ${s}`)
}

console.log()
console.log('A commit appearing here does not mean knowledge is missing. It means nobody')
console.log('checked. Deciding takes reading the diff and the message, which is --read,')
console.log('or --bundle to do it yourself.')
process.exit(0)

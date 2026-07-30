#!/usr/bin/env node
// The Regeneration Test, as a command.
//
//   regen-test --impl impl/python --stack python \
//              --agent "claude -p" --verify "node verify.mjs python"
//
// Deletes an implementation, asks an agent to rebuild it from the knowledge
// alone, and scores the result against the contracts that already existed.
//
// The point is not to produce code. It is to find out how much you failed to
// write down. A pass means the contracts held. A failure hands you an itemised
// list of things you did not know were missing.
//
// The single rule that makes this worth running: the agent must not see the
// implementation it is replacing. An agent with that code in context will
// reproduce what it remembers and report that the knowledge was fine, which is
// marking its own homework and yields exactly nothing. This script enforces the
// rule physically, by moving the implementation outside the repository, because
// a rule stated only in a prompt is a rule that will eventually be ignored.

import { execSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTree } from './lib/load.mjs'

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const flag = (name) => argv.includes(name)

if (flag('--help') || !opt('--impl')) {
  console.log(`Regeneration Test

  regen-test --impl <path> [options]

Required
  --impl <path>       implementation directory to delete and rebuild

Options
  --tree <path>       knowledge tree root (default: .)
  --module <name>     module under test, for the report
  --stack <name>      stack label, e.g. python
  --agent <cmd>       command to run the agent; the prompt arrives on stdin
                      (default: print the prompt and stop, so you can run it yourself)
  --verify <cmd>      command that scores the result; non-zero means failure
  --out <path>        write the JSON result here
  --keep              leave the regenerated implementation in place afterwards
  --yes               skip the confirmation prompt

The implementation is restored on exit unless --keep is given, including when
the agent fails or the run is interrupted.`)
  process.exit(opt('--impl') ? 0 : 2)
}

const treeRoot = resolve(opt('--tree', '.'))
const implPath = resolve(treeRoot, opt('--impl'))
const stack = opt('--stack', basename(implPath))
const moduleName = opt('--module', null)
const agentCmd = opt('--agent', null)
const verifyCmd = opt('--verify', null)
const outPath = opt('--out', null)

if (!existsSync(implPath)) {
  console.error(`No such implementation: ${implPath}`)
  process.exit(2)
}

// ---------------------------------------------------------------- prompt

const tree = loadTree(treeRoot)

// Everything the agent may read. Built from the tree so it cannot go stale.
const allow = tree.files
  .map((f) => relative(treeRoot, f))
  .filter((f) => f.includes('knowledge') && !f.includes('node_modules'))
  .sort()

const implRel = relative(treeRoot, implPath)

const prompt = `You are performing a Regeneration Test. Write an implementation of a service from its knowledge specification alone.

WORKING DIRECTORY: ${treeRoot}

You may read ONLY these files:

${allow.map((f) => `  ${f}`).join('\n')}

You must NOT read, open, grep, list, or inspect anything else. In particular:
  - any other implementation directory
  - the contract runner or any test harness
  - README files
  - anything under .git

The entire point of this exercise is to find out whether the knowledge above is
sufficient on its own. Reading an existing implementation would invalidate it,
and a quietly invalid test is worse than no test, because it manufactures false
confidence.

YOUR TASK
Write the implementation at: ${implRel}
${stack ? `Target stack: ${stack}` : ''}

The knowledge describes the interface, the business rules, the decisions behind
them, and the contracts your implementation must satisfy. Read all of it before
writing anything. Several behaviours are usually subtler than they first appear.

Do NOT run the contract suite. You get one attempt; someone else scores it.
That constraint is deliberate: it measures the knowledge, not your ability to
iterate against a test.

BEFORE YOU FINISH
Write a file at ${implRel}/../REGEN-GUESSES.md containing:

1. Every question the knowledge did NOT answer, where you had to guess or infer.
   Be specific and honest. This list is the real output of the experiment, and
   it is more valuable than the code.
2. Anything ambiguous or self-contradictory in the knowledge.
3. Anything you expect a contract to catch you out on, and why.

Do not claim the knowledge was complete if it was not. An honest failure here is
a better result than a lucky pass.`

// ---------------------------------------------------------------- isolate

const stash = mkdtempSync(join(tmpdir(), 'regen-test-'))
const stashed = join(stash, basename(implPath))
let restored = false

function restore() {
  if (restored) return
  restored = true
  try {
    if (flag('--keep')) {
      console.log(`\nRegenerated implementation kept at ${implRel}`)
      console.log(`Original preserved at ${stashed}`)
      return
    }
    rmSync(implPath, { recursive: true, force: true })
    renameSync(stashed, implPath)
    console.log(`\nOriginal implementation restored to ${implRel}`)
  } catch (e) {
    // Never let a restore failure pass silently: someone's working code is in
    // the stash directory and they need to know where.
    console.error(`\nRESTORE FAILED: ${e.message}`)
    console.error(`Your original implementation is at: ${stashed}`)
  }
}

process.on('exit', restore)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    restore()
    process.exit(130)
  })
}

console.log('Regeneration Test')
console.log(`  tree:   ${treeRoot}`)
console.log(`  impl:   ${implRel}${stack ? `  (${stack})` : ''}`)
console.log(`  agent:  ${agentCmd ?? '(none: prompt will be printed)'}`)
console.log(`  verify: ${verifyCmd ?? '(none: scoring skipped)'}`)
console.log(`  knowledge files visible to the agent: ${allow.length}`)

renameSync(implPath, stashed)
console.log(`\nImplementation moved out of the repository so it cannot be read.`)

// ---------------------------------------------------------------- run

const started = Date.now()
let agentFailed = false

if (!agentCmd) {
  const promptFile = join(stash, 'PROMPT.md')
  writeFileSync(promptFile, prompt)
  console.log(`\nNo --agent given. The prompt is at:\n  ${promptFile}\n`)
  console.log('Run your agent against it, then re-run with --verify to score.')
  console.log('The original will be restored when this process exits, so use --keep')
  console.log('if you intend to work on it before scoring.')
} else {
  console.log(`\nDispatching the agent. This is usually the slow part.\n`)
  const res = spawnSync(agentCmd, { input: prompt, shell: true, stdio: ['pipe', 'inherit', 'inherit'] })
  agentFailed = res.status !== 0
  if (agentFailed) console.error(`\nAgent exited ${res.status}.`)
}

// ---------------------------------------------------------------- guesses

const guessFile = join(implPath, '..', 'REGEN-GUESSES.md')
let guesses = null
if (existsSync(guessFile)) {
  guesses = readFileSync(guessFile, 'utf8').trim()
  console.log(`\nGuess list collected: ${guesses.split('\n').filter((l) => /^\s*[-*\d]/.test(l)).length} entries`)
} else if (agentCmd) {
  console.warn(`\nWARNING: no guess list at ${relative(treeRoot, guessFile)}`)
  console.warn('The guess list is the primary output of this test. A score without it')
  console.warn('tells you whether the contracts held, not what you failed to write down.')
}

// ---------------------------------------------------------------- score

let score = null
if (verifyCmd && existsSync(implPath)) {
  console.log(`\nScoring: ${verifyCmd}\n`)
  const res = spawnSync(verifyCmd, { cwd: treeRoot, shell: true, encoding: 'utf8' })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  process.stdout.write(output)

  // Best-effort parse. Projects differ, so treat the exit code as the truth and
  // the numbers as a convenience.
  const m = /(\d+)\s*\/\s*(\d+)\s+scenarios?\s+passed/i.exec(output)
  score = {
    passed: res.status === 0,
    scenarios: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    exitCode: res.status,
  }
} else if (verifyCmd) {
  console.warn('\nNothing to score: the agent produced no implementation.')
}

// ---------------------------------------------------------------- report

const result = {
  module: moduleName,
  stack,
  impl: implRel,
  at: new Date().toISOString().slice(0, 10),
  agent: agentCmd,
  agentFailed,
  knowledgeFilesVisible: allow.length,
  durationSeconds: Math.round((Date.now() - started) / 1000),
  score,
  guesses,
}

if (outPath) {
  mkdirSync(resolve(treeRoot, outPath, '..'), { recursive: true })
  writeFileSync(resolve(treeRoot, outPath), JSON.stringify(result, null, 2))
  console.log(`\nResult written to ${outPath}`)
}

console.log('\n' + '='.repeat(60))
if (score?.passed) {
  console.log(`PASS  ${score.scenarios ?? '?'}/${score.total ?? '?'} in ${result.durationSeconds}s`)
  console.log('\nThe contracts held. Read the guess list anyway: in the reference run,')
  console.log('eighteen guesses were reported and only three cost contracts. The other')
  console.log('fifteen were real gaps nothing had exercised yet.')
} else if (score) {
  console.log(`FAIL  ${score.scenarios ?? '?'}/${score.total ?? '?'} in ${result.durationSeconds}s`)
  console.log('\nBefore booking this as knowledge debt, work out which it was:')
  console.log('  the knowledge was incomplete    -> real debt, fix the knowledge')
  console.log('  the model was not capable       -> note the model, not debt')
  console.log('  the harness was flaky           -> fix the harness')
  console.log('\nThe test: could a careful engineer, given only this knowledge, have')
  console.log('built it? If not, the debt is real.')
  console.log('\nFix the knowledge. Never the contracts, and never the code to suit them.')
}
process.exitCode = score && !score.passed ? 1 : 0

// The reading pass: ship a corpus to a model and get findings back.
//
// This is a transport, not a thinker. It holds no opinion about knowledge; the
// judgement is entirely in the prompt and the model. It exists because the
// mechanical half of the Librarian can only compare numbers and count
// references, and the findings that matter are the ones that need reading.
//
// Provider-agnostic on purpose. The manifesto claims knowledge outlives models,
// and REP-0006's Trigger has a signal for "a materially better or cheaper model
// became available". Neither claim is worth much if the tooling can only talk to
// one vendor, so this speaks both the OpenAI-compatible shape (OpenRouter and
// most others) and Anthropic's native one, chosen by whichever key is present.
//
// No dependencies. fetch is built in from Node 18, and adding an SDK for one
// HTTP call would make an offline, deterministic package into a heavy one.

const OPENAI_SHAPE = 'openai'
const ANTHROPIC_SHAPE = 'anthropic'

/**
 * Work out which provider to talk to, from the environment alone.
 * Explicit REGEN_LLM_* always wins, so any OpenAI-compatible endpoint works.
 */
export function provider(env = process.env) {
  const key = env.REGEN_LLM_API_KEY || env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY
  if (!key) {
    return {
      error:
        'No API key. Set OPENROUTER_API_KEY, or ANTHROPIC_API_KEY, or REGEN_LLM_API_KEY\n' +
        'with REGEN_LLM_BASE_URL for any other OpenAI-compatible endpoint.',
    }
  }

  const explicitBase = env.REGEN_LLM_BASE_URL
  const anthropicNative = !explicitBase && !env.REGEN_LLM_API_KEY && !env.OPENROUTER_API_KEY && env.ANTHROPIC_API_KEY

  const base = explicitBase ?? (anthropicNative ? 'https://api.anthropic.com/v1' : 'https://openrouter.ai/api/v1')
  const shape = anthropicNative ? ANTHROPIC_SHAPE : OPENAI_SHAPE
  const model = env.REGEN_LLM_MODEL

  if (!model) {
    return {
      error:
        'No model. Set REGEN_LLM_MODEL.\n' +
        `Talking to ${base}, so use that provider's identifier, for example\n` +
        (shape === ANTHROPIC_SHAPE
          ? '  REGEN_LLM_MODEL=claude-sonnet-4-5\n'
          : '  REGEN_LLM_MODEL=anthropic/claude-sonnet-4.5\n') +
        'Deliberately not defaulted: a guessed identifier fails at the API with a\n' +
        'less useful message than this one, and model choice is a real decision.',
    }
  }

  return { key, base, shape, model }
}

/**
 * Send a system prompt and one user message, return the text.
 * Retries on the transient statuses only; a 401 or a 404 is not worth repeating.
 */
export async function ask({ system, user, maxTokens = 8000, env = process.env, fetchImpl = fetch }) {
  const p = provider(env)
  if (p.error) throw new Error(p.error)

  const isAnthropic = p.shape === ANTHROPIC_SHAPE
  const url = `${p.base}${isAnthropic ? '/messages' : '/chat/completions'}`

  const headers = { 'content-type': 'application/json' }
  if (isAnthropic) {
    headers['x-api-key'] = p.key
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${p.key}`
    // OpenRouter attributes traffic by these; harmless elsewhere.
    headers['http-referer'] = 'https://regen.engineering'
    headers['x-title'] = 'Regen Engineering Librarian'
  }

  const body = isAnthropic
    ? { model: p.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
    : {
        model: p.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }

  const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
  let lastError = null

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt))

    let res
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (e) {
      lastError = new Error(`Network error talking to ${url}: ${e.message}`)
      continue
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 400)
      const err = new Error(`${res.status} from ${url}: ${detail}`)
      if (!RETRYABLE.has(res.status)) throw err
      lastError = err
      continue
    }

    const data = await res.json()
    const text = isAnthropic
      ? (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      : data.choices?.[0]?.message?.content

    if (!text) throw new Error(`No text in the response from ${p.model}: ${JSON.stringify(data).slice(0, 400)}`)
    return { text, model: p.model, base: p.base }
  }

  throw lastError ?? new Error('Request failed with no error recorded')
}

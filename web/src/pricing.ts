import type { ModelUsage, TokenUsage } from './types'

// Prices in US dollars per million tokens, from Anthropic's pricing page
// https://platform.claude.com/docs/en/about-claude/pricing, read on 2026-10-12.
// The page prices cache writes at 1.25x (5 minutes) and 2x (1 hour) the input price for every
// model; only the cache read price differs, so it is listed per model.
// Cache reads cost 0.1x the input price on most models and 0.05x on Opus 5.5 and Sonnet 5.5,
// so they are listed per model. Not priced: the 1.1x surcharge for US-only inference.
interface Price {
  input: number
  output: number
  cacheRead: number
}

const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2
const PER_MILLION = 1_000_000

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08 },
}

// Fast mode multiplies every price, caching included, on the models that offer it.
const FAST_MULTIPLIER: Record<string, number> = { 'claude-opus-5-5': 2, 'claude-opus-5': 2, 'claude-opus-4-8': 2 }

// Haiku 5.5 charges more for a request whose prompt is over 100,000 tokens.
const LONG_PROMPT_PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.5, output: 2.5, cacheRead: 0.05 },
}

// The model part of a usage key: "claude-sonnet-4-5-20250929 fast" is claude-sonnet-4-5.
// Model ids carry a date and sometimes a context tag ("[1m]"); the server adds "fast" and "long".
export function modelOf(key: string): string {
  return key.split(' ')[0].replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
}

export function priceOf(key: string): Price | null {
  const model = modelOf(key)
  const tags = key.split(' ').slice(1)
  const base = (tags.includes('long') && LONG_PROMPT_PRICES[model]) || PRICES[model]
  if (!base) return null
  if (!tags.includes('fast')) return base
  // A fast request on a model without fast mode runs, and is billed, at standard speed.
  const times = FAST_MULTIPLIER[model] ?? 1
  return { input: base.input * times, output: base.output * times, cacheRead: base.cacheRead * times }
}

function dollars(price: Price, usage: TokenUsage): number {
  const cost =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheRead * price.cacheRead +
    usage.cacheWrite5m * price.input * CACHE_WRITE_5M +
    usage.cacheWrite1h * price.input * CACHE_WRITE_1H
  return cost / PER_MILLION
}

export function tokensOf(usage: ModelUsage): number {
  return Object.values(usage).reduce((sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h, 0)
}

// Null when any model has no known price: a guessed price is worse than none.
export function costOf(usage: ModelUsage): number | null {
  let total = 0
  for (const [model, tokens] of Object.entries(usage)) {
    const price = priceOf(model)
    // A model with no tokens (an API error, say) can't make the total unknown.
    if (!price && tokensOf({ [model]: tokens }) === 0) continue
    if (!price) return null
    total += dollars(price, tokens)
  }
  return total
}

export function mergeUsage(all: ModelUsage[]): ModelUsage {
  const merged: ModelUsage = Object.create(null)
  for (const usage of all) {
    for (const [model, t] of Object.entries(usage)) {
      const sum = (merged[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
      sum.input += t.input
      sum.output += t.output
      sum.cacheRead += t.cacheRead
      sum.cacheWrite5m += t.cacheWrite5m
      sum.cacheWrite1h += t.cacheWrite1h
    }
  }
  return merged
}

export function formatDollars(amount: number): string {
  if (amount < 0.01) return 'under $0.01'
  return `about $${amount < 10 ? amount.toFixed(2) : Math.round(amount).toLocaleString('en-GB')}`
}

export function formatTokens(count: number): string {
  if (count >= PER_MILLION) return `${(count / PER_MILLION).toFixed(1)} M tokens`
  if (count >= 1_000) return `${Math.round(count / 1_000)} k tokens`
  return `${count} tokens`
}

// "about $1.24, 1.2 M tokens"; tokens only when a model has no known price; null when nothing was used.
export function describeSpend(usage: ModelUsage): string | null {
  const tokens = tokensOf(usage)
  if (tokens === 0) return null
  const cost = costOf(usage)
  return cost === null ? formatTokens(tokens) : `${formatDollars(cost)}, ${formatTokens(tokens)}`
}

// Just the money, for tight spots such as a room box; null when it can't be priced.
export function describeCost(usage: ModelUsage): string | null {
  const cost = costOf(usage)
  return cost === null || tokensOf(usage) === 0 ? null : formatDollars(cost)
}

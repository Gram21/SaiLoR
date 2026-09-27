import type { LlmConfig } from './types'

/**
 * Cost estimation. There is no built-in price table (see `LlmConfig.inputPrice`/
 * `outputPrice` in types.ts) — every number here is either what the reviewer
 * typed for their target, or a heuristic token count, never a scraped price
 * list that goes stale the day a provider changes it.
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Null when either price is unset — never guessed. */
export function costOf(usage: TokenUsage, cfg: LlmConfig): number | null {
  if (cfg.inputPrice === undefined || cfg.outputPrice === undefined) return null
  return (usage.inputTokens * cfg.inputPrice + usage.outputTokens * cfg.outputPrice) / 1_000_000
}

export interface EstimateRunInput {
  papers: { pages: number }[]
  /** Answered fields expected per paper — one array entry per paper, or one
   *  number applied to all of them. */
  fieldsPerPaper: number[] | number
  mode: 'prompt' | 'agent'
  delivery: 'text' | 'pdf'
  /** Tokens added to every request's input for a few-shot block (fewshot.ts). */
  fewShotTokens?: number
}

export interface TokenEstimate {
  low: TokenUsage
  high: TokenUsage
  /** The judge-call share of `low`/`high` above (zero in prompt mode) — lets a
   *  caller with a separate judge target price that portion separately, see
   *  `estimateCostSplit`. */
  judge: { low: TokenUsage; high: TokenUsage }
  requests: { low: number; high: number }
}

// ponytail: hand-picked ranges, not measured against real traffic — the
// per-page/per-field constants below are the thing to recalibrate if actual
// usage diverges, not the formula shape.
const TEXT_TOKENS_PER_PAGE = { low: 600, high: 900 }
const PDF_TOKENS_PER_PAGE = { low: 1500, high: 3000 }
const OVERHEAD_TOKENS = { low: 2000, high: 4000 } // system prompt + schema
const OUTPUT_TOKENS_PER_FIELD = { low: 60, high: 150 }

// Agent mode re-sends the paper prefix on every tool-calling round. Real
// traffic likely hits prompt caching (Anthropic's cache_control, OpenAI's
// automatic prefix cache — see chat.ts's anthropicMessages), so `low` assumes
// the paper is billed once and later rounds only add a small per-round
// increment; `high` assumes no caching at all and re-bills the whole prefix
// every round — the honest uncached ceiling.
const AGENT_REQUESTS_PER_PAPER = { low: 5, high: 15 }
const AGENT_ROUND_INCREMENT_TOKENS = 300 // cached case: per extra round, tool-call back-and-forth only
const JUDGE_REQUESTS = { low: 2, high: 4 } // roughly one per revision round

function fieldsFor(fieldsPerPaper: number[] | number, index: number): number {
  return Array.isArray(fieldsPerPaper) ? (fieldsPerPaper[index] ?? 0) : fieldsPerPaper
}

export function estimateRun(input: EstimateRunInput): TokenEstimate {
  const perPage = input.delivery === 'pdf' ? PDF_TOKENS_PER_PAGE : TEXT_TOKENS_PER_PAGE
  const fewShot = input.fewShotTokens ?? 0

  let inputLow = 0
  let inputHigh = 0
  let outputLow = 0
  let outputHigh = 0
  let requestsLow = 0
  let requestsHigh = 0
  let judgeInputLow = 0
  let judgeInputHigh = 0
  let judgeOutputLow = 0
  let judgeOutputHigh = 0

  input.papers.forEach((paper, i) => {
    const fields = fieldsFor(input.fieldsPerPaper, i)
    const paperLow = paper.pages * perPage.low
    const paperHigh = paper.pages * perPage.high
    const promptInputLow = OVERHEAD_TOKENS.low + paperLow + fewShot
    const promptInputHigh = OVERHEAD_TOKENS.high + paperHigh + fewShot
    const outputPerFieldLow = fields * OUTPUT_TOKENS_PER_FIELD.low
    const outputPerFieldHigh = fields * OUTPUT_TOKENS_PER_FIELD.high

    if (input.mode === 'prompt') {
      inputLow += promptInputLow
      inputHigh += promptInputHigh
      outputLow += outputPerFieldLow
      outputHigh += outputPerFieldHigh
      requestsLow += 1
      requestsHigh += 1
      return
    }

    // agent mode
    const agentLow = AGENT_REQUESTS_PER_PAPER.low
    const agentHigh = AGENT_REQUESTS_PER_PAPER.high
    // Cached-ish lower bound: the paper prefix billed once, plus a small
    // increment per extra round.
    inputLow += promptInputLow + (agentLow - 1) * AGENT_ROUND_INCREMENT_TOKENS
    // Uncached upper bound: the whole prefix re-billed on every round.
    inputHigh += promptInputHigh * agentHigh
    outputLow += outputPerFieldLow
    outputHigh += outputPerFieldHigh
    requestsLow += agentLow
    requestsHigh += agentHigh

    // Judge calls: each judge call also reads the paper, but never few-shot
    // examples (the judge must not see them — see fewshot.ts).
    const judgeInLow = (OVERHEAD_TOKENS.low + paperLow) * JUDGE_REQUESTS.low
    const judgeInHigh = (OVERHEAD_TOKENS.high + paperHigh) * JUDGE_REQUESTS.high
    const judgeOutLow = JUDGE_REQUESTS.low * 200
    const judgeOutHigh = JUDGE_REQUESTS.high * 400
    inputLow += judgeInLow
    inputHigh += judgeInHigh
    outputLow += judgeOutLow
    outputHigh += judgeOutHigh
    judgeInputLow += judgeInLow
    judgeInputHigh += judgeInHigh
    judgeOutputLow += judgeOutLow
    judgeOutputHigh += judgeOutHigh
    requestsLow += JUDGE_REQUESTS.low
    requestsHigh += JUDGE_REQUESTS.high
  })

  return {
    low: { inputTokens: Math.round(inputLow), outputTokens: Math.round(outputLow) },
    high: { inputTokens: Math.round(inputHigh), outputTokens: Math.round(outputHigh) },
    judge: {
      low: { inputTokens: Math.round(judgeInputLow), outputTokens: Math.round(judgeOutputLow) },
      high: { inputTokens: Math.round(judgeInputHigh), outputTokens: Math.round(judgeOutputHigh) },
    },
    requests: { low: requestsLow, high: requestsHigh },
  }
}

/** Null when the target has no price set — see `costOf`. */
export function estimateCost(
  estimate: TokenEstimate,
  cfg: LlmConfig,
): { low: number; high: number } | null {
  const low = costOf(estimate.low, cfg)
  const high = costOf(estimate.high, cfg)
  if (low === null || high === null) return null
  return { low, high }
}

/**
 * Same as `estimateCost`, but for an agent-mode run split across two targets:
 * `agentCfg` prices everything except the judge calls, `judgeCfg` prices
 * those. Null unless both targets have prices set — see `costOf`.
 */
export function estimateCostSplit(
  estimate: TokenEstimate,
  agentCfg: LlmConfig,
  judgeCfg: LlmConfig,
): { low: number; high: number } | null {
  const agentLow: TokenUsage = {
    inputTokens: estimate.low.inputTokens - estimate.judge.low.inputTokens,
    outputTokens: estimate.low.outputTokens - estimate.judge.low.outputTokens,
  }
  const agentHigh: TokenUsage = {
    inputTokens: estimate.high.inputTokens - estimate.judge.high.inputTokens,
    outputTokens: estimate.high.outputTokens - estimate.judge.high.outputTokens,
  }
  const agentCostLow = costOf(agentLow, agentCfg)
  const agentCostHigh = costOf(agentHigh, agentCfg)
  const judgeCostLow = costOf(estimate.judge.low, judgeCfg)
  const judgeCostHigh = costOf(estimate.judge.high, judgeCfg)
  if (agentCostLow === null || agentCostHigh === null || judgeCostLow === null || judgeCostHigh === null) {
    return null
  }
  return { low: agentCostLow + judgeCostLow, high: agentCostHigh + judgeCostHigh }
}

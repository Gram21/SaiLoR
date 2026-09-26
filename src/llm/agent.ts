import type { ResolvedDef } from '../model/schema'
import type { Paper } from '../model/project'
import type { FieldTarget } from './fields'
import type { Delivery } from './prompt'
import { buildAgentSystemPrompt } from './prompt'
import type {
  LlmConfig,
  LlmHttpRequest,
  LlmHttpResponse,
  LlmAnswer,
  Suggestion,
  JudgeVerdict,
  WebFetchResult,
} from './types'
import type { PaperPart } from './providers'
import { extractError } from './providers'
import { buildChatRequest, parseChatResponse, type ChatMessage, type ToolCall } from './chat'
import { AGENT_TOOLS, executeTool, parseSubmitArgs, type SubmitPayload } from './tools'
import { checkSubmission, type CheckFailure } from './verify'
import {
  buildJudgeSystemPrompt,
  buildJudgeUserMessage,
  parseJudgeReply,
  type JudgeProposal,
} from './judge'
import { parseAnswer } from './parse'

/**
 * Agent mode's orchestration loop: a tool-using agent proposes values, a
 * separate judge critiques them, the agent reads the critique and redoes what
 * needs redoing, repeated until the judge accepts everything (or budgets run
 * out). See docs/requirements/llm-annotation.md REQ-LLM-330..370.
 */

const DEFAULT_MAX_ROUNDS = 3
const DEFAULT_MAX_TOOL_CALLS_PER_ROUND = 12

export interface AgentDeps {
  callLlm(req: LlmHttpRequest, signal?: AbortSignal): Promise<LlmHttpResponse>
  fetchWeb(url: string, signal?: AbortSignal): Promise<WebFetchResult>
}

export interface AgentEvent {
  round: number
  kind: 'tool' | 'submit' | 'check' | 'judge' | 'revise' | 'done'
  message: string
}

export interface AgentInput {
  config: LlmConfig
  /** Target the judge runs on; defaults to the agent's own `config`. */
  judgeConfig?: LlmConfig
  schema: ResolvedDef[]
  targets: FieldTarget[]
  paper: Paper
  paperText: string
  delivery: Delivery
  pdfBase64?: string
  pdfFilename?: string
  maxRounds?: number
  maxToolCallsPerRound?: number
  signal?: AbortSignal
  onEvent?: (e: AgentEvent) => void
  /** Pre-built few-shot block (see fewshot.ts). Goes into the agent's own
   *  system prompt only — the judge must not see the reviewer's examples. */
  examples?: string
}

export interface AgentResult {
  answer: LlmAnswer
  rounds: number
  usage: { inputTokens: number; outputTokens: number; calls: number }
  log: AgentEvent[]
}

function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

function fieldSignature(f: { value: unknown; evidence: string; source?: string }): string {
  return JSON.stringify([f.value, f.evidence, f.source ?? null])
}

function sameSubmission(a: SubmitPayload, b: SubmitPayload): boolean {
  const sortedFields = (p: SubmitPayload) => [...p.fields].sort((x, y) => x.path.localeCompare(y.path))
  const sortedSkipped = (p: SubmitPayload) => [...p.skipped].sort((x, y) => x.path.localeCompare(y.path))
  const fa = sortedFields(a)
  const fb = sortedFields(b)
  if (fa.length !== fb.length) return false
  for (let i = 0; i < fa.length; i++) {
    if (fa[i].path !== fb[i].path || fieldSignature(fa[i]) !== fieldSignature(fb[i])) return false
  }
  const sa = sortedSkipped(a)
  const sb = sortedSkipped(b)
  if (sa.length !== sb.length) return false
  for (let i = 0; i < sa.length; i++) {
    if (sa[i].path !== sb[i].path || sa[i].reason !== sb[i].reason) return false
  }
  return true
}

function describeToolCall(call: ToolCall): string {
  const a = (call.args ?? {}) as Record<string, unknown>
  switch (call.name) {
    case 'search_paper':
      return `Searching the paper for "${String(a.query ?? '')}"`
    case 'read_pages':
      return `Reading pages ${String(a.from ?? '?')}-${String(a.to ?? '?')}`
    case 'scholarly_search':
      return `Searching OpenAlex for "${String(a.query ?? '')}"`
    case 'lookup_doi':
      return `Looking up DOI ${String(a.doi ?? '')}`
    case 'fetch_url':
      return `Fetching ${String(a.url ?? '')}`
    default:
      return `Calling ${call.name}`
  }
}

export async function runAgent(input: AgentInput, deps: AgentDeps): Promise<AgentResult> {
  const {
    config,
    schema,
    targets,
    paper,
    paperText,
    delivery,
    signal,
    onEvent,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxToolCallsPerRound = DEFAULT_MAX_TOOL_CALLS_PER_ROUND,
  } = input
  const judgeConfig = input.judgeConfig ?? config

  const paperPart: PaperPart =
    delivery === 'pdf'
      ? { kind: 'pdf', base64: input.pdfBase64 ?? '', filename: input.pdfFilename ?? 'paper.pdf' }
      : { kind: 'text', text: paperText }
  if (delivery === 'pdf' && !input.pdfBase64) {
    throw new Error('Agent mode: PDF delivery requested but no PDF was provided.')
  }

  const textAvailable = delivery === 'text' ? paperText.trim().length > 0 : true
  const system = buildAgentSystemPrompt(schema, targets, delivery, input.examples)

  const authors = paper.authors.length > 0 ? paper.authors.join(', ') : 'unknown authors'
  const caption = `Paper: "${paper.title}" by ${authors}.\n\nExtract the annotations for the fields listed in the schema. Use your tools to search and read the paper, and end each round by calling submit_annotations.`

  const messages: ChatMessage[] = [{ role: 'user', content: caption }]
  const log: AgentEvent[] = []
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 }
  const emit = (e: AgentEvent) => {
    log.push(e)
    onEvent?.(e)
  }

  const fetchedUrls = new Set<string>()
  const fetchedExcerpts = new Map<string, string>()
  const verdictByPath = new Map<string, JudgeVerdict>()
  const signatureByPath = new Map<string, string>()

  let prevSubmission: SubmitPayload | null = null
  let lastAnswer: LlmAnswer = { fields: [], skipped: [], rejected: [] }
  let lastFailures: CheckFailure[] = []
  let lastMissed: { path: string; feedback: string }[] = []
  let round = 0

  async function callTool(call: ToolCall): Promise<string> {
    emit({ round, kind: 'tool', message: describeToolCall(call) })
    const result = await executeTool(
      call.name,
      call.args,
      {
        paperText,
        textAvailable,
        fetchWeb: (url, sig) => deps.fetchWeb(url, sig),
      },
      signal,
    )
    if (call.name === 'fetch_url') {
      const args = (call.args ?? {}) as Record<string, unknown>
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (url && result.startsWith('Fetched ')) {
        fetchedUrls.add(url)
        fetchedExcerpts.set(url, result)
      }
    }
    return result
  }

  // ---- one round: run the agent (with tools) until it submits ----
  async function runAgentTurn(): Promise<SubmitPayload> {
    let toolCallsUsed = 0
    // Slack beyond the tool-call cap for the forced-submit reminder round-trips.
    const maxIterations = maxToolCallsPerRound + 4

    for (let iter = 0; iter < maxIterations; iter++) {
      throwIfAborted(signal)
      const req = buildChatRequest(config, system, messages, AGENT_TOOLS, { paper: paperPart })
      const res = await deps.callLlm(req, signal)
      if (!res.ok) throw new Error(extractError(config.provider, res.status, res.body))
      const json = safeJson(res.body)
      const parsed = parseChatResponse(config.provider, json)
      usage.inputTokens += parsed.usage.inputTokens
      usage.outputTokens += parsed.usage.outputTokens
      usage.calls++

      if (parsed.toolCalls.length === 0) {
        // Plain-text fallback: the model answered directly instead of using
        // submit_annotations. Accept it if it parses as the prompt-mode JSON shape.
        if (parsed.text.trim()) {
          const answer = parseAnswer(schema, parsed.text)
          if (answer.fields.length > 0 || answer.skipped.length > 0) {
            return {
              fields: answer.fields.map((f) => ({
                path: f.path,
                value: f.value,
                evidence: f.evidence,
                source: 'paper',
                confidence: f.confidence ?? undefined,
              })),
              skipped: answer.skipped,
            }
          }
        }
        messages.push({ role: 'assistant', content: parsed.text || undefined, raw: parsed.raw })
        messages.push({
          role: 'user',
          content: 'Call submit_annotations to finish this round — it is required.',
        })
        continue
      }

      messages.push({
        role: 'assistant',
        content: parsed.text || undefined,
        toolCalls: parsed.toolCalls,
        raw: parsed.raw,
      })

      const submitCall = parsed.toolCalls.find((c) => c.name === 'submit_annotations')
      const otherCalls = parsed.toolCalls.filter((c) => c.name !== 'submit_annotations')

      for (const call of otherCalls) {
        throwIfAborted(signal)
        toolCallsUsed++
        const result =
          toolCallsUsed > maxToolCallsPerRound
            ? 'Error: tool call budget exceeded for this round. Call submit_annotations now with what you have.'
            : await callTool(call)
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result })
      }

      if (submitCall) return parseSubmitArgs(submitCall.args)

      if (toolCallsUsed >= maxToolCallsPerRound) {
        messages.push({
          role: 'user',
          content: 'Tool call budget for this round is used up. Call submit_annotations now with what you have.',
        })
      }
    }

    // Never submitted despite every nudge — proceed with nothing new rather than hang.
    return prevSubmission ?? { fields: [], skipped: [] }
  }

  while (round < maxRounds) {
    round++
    throwIfAborted(signal)

    const submission = await runAgentTurn()
    emit({
      round,
      kind: 'submit',
      message: `Submitted ${submission.fields.length} field(s), skipped ${submission.skipped.length}.`,
    })

    const { answer, failures } = checkSubmission(schema, submission, paperText, fetchedUrls)
    lastAnswer = answer
    lastFailures = failures
    emit({
      round,
      kind: 'check',
      message: failures.length
        ? `${failures.length} value(s) failed evidence/schema checks.`
        : 'All values passed evidence/schema checks.',
    })

    const failedPaths = new Set(failures.map((f) => f.path))
    for (const f of failures) verdictByPath.set(f.path, { verdict: 'revise', feedback: f.reason })

    const toJudge: JudgeProposal[] = []
    for (const s of answer.fields) {
      if (failedPaths.has(s.path)) continue
      const sig = fieldSignature(s)
      if (signatureByPath.get(s.path) === sig && verdictByPath.has(s.path)) continue
      toJudge.push({
        path: s.path,
        value: s.value,
        evidence: s.evidence,
        source: s.source,
        webExcerpt: s.source && fetchedExcerpts.has(s.source) ? fetchedExcerpts.get(s.source) : undefined,
      })
      signatureByPath.set(s.path, sig)
    }

    let missed: { path: string; feedback: string }[] = lastMissed
    if (toJudge.length > 0 || round === 1) {
      throwIfAborted(signal)
      const judgeSystem = buildJudgeSystemPrompt(schema, targets, delivery)
      const judgeUser = buildJudgeUserMessage(toJudge)
      const jreq = buildChatRequest(judgeConfig, judgeSystem, [{ role: 'user', content: judgeUser }], [], {
        paper: paperPart,
      })
      const jres = await deps.callLlm(jreq, signal)
      if (!jres.ok) throw new Error(extractError(judgeConfig.provider, jres.status, jres.body))
      const jjson = safeJson(jres.body)
      const jparsed = parseChatResponse(judgeConfig.provider, jjson)
      usage.inputTokens += jparsed.usage.inputTokens
      usage.outputTokens += jparsed.usage.outputTokens
      usage.calls++
      const reply = parseJudgeReply(jparsed.text)
      for (const v of reply.verdicts) {
        verdictByPath.set(v.path, { verdict: v.verdict, feedback: v.feedback })
      }
      missed = reply.missed
      lastMissed = missed
      const accepted = reply.verdicts.filter((v) => v.verdict === 'accept').length
      emit({
        round,
        kind: 'judge',
        message: `Judge: ${accepted} accepted, ${reply.verdicts.length - accepted} to revise, ${missed.length} missed field(s) noted.`,
      })
    }

    const allAccepted = answer.fields.every((s) => verdictByPath.get(s.path)?.verdict === 'accept')
    const allDone = allAccepted && failures.length === 0 && missed.length === 0

    if (allDone) {
      emit({ round, kind: 'done', message: 'All fields accepted; nothing missed.' })
      prevSubmission = submission
      break
    }

    if (round >= maxRounds) {
      emit({ round, kind: 'done', message: 'Stopping: round budget reached.' })
      prevSubmission = submission
      break
    }

    if (prevSubmission && sameSubmission(prevSubmission, submission)) {
      emit({ round, kind: 'done', message: 'Stopping: the agent made no further changes.' })
      prevSubmission = submission
      break
    }

    prevSubmission = submission

    // Build feedback for the next round.
    const feedbackLines: string[] = []
    for (const f of failures) feedbackLines.push(`- ${f.path}: ${f.reason}`)
    for (const v of verdictByPath) {
      if (v[1].verdict !== 'accept' && !failedPaths.has(v[0]) && answer.fields.some((s) => s.path === v[0])) {
        feedbackLines.push(`- ${v[0]}: [${v[1].verdict}] ${v[1].feedback}`)
      }
    }
    for (const m of missed) feedbackLines.push(`- ${m.path} (not yet answered): ${m.feedback}`)

    messages.push({
      role: 'user',
      content:
        'Review feedback on your last submission:\n' +
        feedbackLines.join('\n') +
        '\n\nFor each flagged field, either fix it (re-investigate with your tools), drop it ' +
        '(move it to "skipped" with a reason), or keep it unchanged and justify that in "notes" ' +
        '(evidence must stay a verbatim quote). ' +
        'Then call submit_annotations again with the COMPLETE updated set of fields and skipped fields.',
    })
    emit({ round, kind: 'revise', message: `Revising ${feedbackLines.length} flagged field(s).` })
  }

  // Final answer: last submission, annotated with judge verdicts; fields that
  // failed the deterministic check in the final round are moved to rejected.
  const finalFields: Suggestion[] = []
  const finalRejected = [...lastAnswer.rejected]
  for (const s of lastAnswer.fields) {
    const failure = lastFailures.find((f) => f.path === s.path)
    if (failure) {
      finalRejected.push({ path: s.path, raw: s.value, reason: failure.reason })
      continue
    }
    finalFields.push({ ...s, judge: verdictByPath.get(s.path) })
  }

  return {
    answer: { fields: finalFields, skipped: lastAnswer.skipped, rejected: finalRejected },
    rounds: round,
    usage,
    log,
  }
}

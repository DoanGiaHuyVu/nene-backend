import * as Sentry from "@sentry/node";
import type { Run } from "./model.js";
import { safeAttributes } from "./telemetry-privacy.js";

type Attributes = Record<string, string | number | boolean | undefined>;
type Category = "read" | "write" | "edit" | "execute" | "other";
export const DETAIL_LIMITS = { tools: 60, models: 20, pending: 64, errors: 5 };
const errorWindows = new Map<string, { count: number; until: number }>();
const captured = new WeakSet<object>();
function quiet<T>(callback: () => T): T | undefined { try { return callback(); } catch { return undefined; } }
export function runAttributes(run?: Run): Attributes {
  return { "service.name": "nene-backend", "nene.run.id": run?.id, "nene.project.id": run?.projectId,
    "gen_ai.conversation.id": run?.projectId, "nene.source_run.id": run?.sourceTaskId,
    "nene.run.type": run ? run.sourceTaskId ? "continuation" : "initial" : undefined, "nene.progress": run?.progress };
}
export function lifecycle(message: string, run?: Run, attributes: Attributes = {}) {
  quiet(() => Sentry.logger.info(message, safeAttributes({ ...runAttributes(run), ...attributes })));
}
export function captureFailure(operation: string, error: unknown, run?: Run) {
  if (!Sentry.getClient()) return;
  if (error && typeof error === "object" && captured.has(error)) return;
  // Rate-limit repeated polling failures, and bound the number of retained keys.
  const key = `${run?.id ?? "backend"}:${operation}`;
  const time = Date.now();
  let budget = errorWindows.get(key);
  if (!budget || budget.until <= time) {
    if (errorWindows.size >= 128) errorWindows.delete(errorWindows.keys().next().value!);
    budget = { count: 0, until: time + 15 * 60_000 }; errorWindows.set(key, budget);
  }
  if (budget.count++ >= DETAIL_LIMITS.errors) return;
  if (error && typeof error === "object") captured.add(error);
  quiet(() => Sentry.withScope(scope => {
    const code = (error as { status?: unknown; code?: unknown } | null)?.status ?? (error as { code?: unknown } | null)?.code;
    scope.setTags(safeAttributes({ ...runAttributes(run), "nene.operation": operation,
      "nene.error.kind": error instanceof Error ? error.name : "Error",
      "nene.error.code": typeof code === "number" ? code : undefined }));
    scope.setFingerprint(["ne-ne", operation]);
    Sentry.captureException(error instanceof Error ? error : new Error("Backend operation failed"));
  }));
}
export async function operation<T>(run: Run | undefined, name: string, op: string, callback: () => Promise<T>, attributes: Attributes = {}, independent = false,
  timing?: { startTime: number; endTime: () => number }): Promise<T> {
  if (independent && Sentry.getClient()) return Sentry.withIsolationScope(() => Sentry.startNewTrace(() => operation(run, name, op, callback, attributes, false, timing)));
  const span = quiet(() => Sentry.getClient() ? Sentry.startInactiveSpan({ name: `ne-ne ${name}`, op,
    attributes: safeAttributes({ ...runAttributes(run), "nene.operation": name, ...attributes }), startTime: timing?.startTime,
    parentSpan: independent ? null : undefined }) : undefined);
  const work = async () => {
    try {
      const result = await callback();
      const success = typeof attributes["nene.success"] === "boolean" ? attributes["nene.success"] : op === "gen_ai.invoke_agent" ? run?.status === "waiting_for_approval" : true;
      quiet(() => { span?.setAttribute("nene.success", success); span?.setStatus(success ? { code: 1 } : { code: 2, message: "agent_failed" }); });
      return result;
    } catch (error) {
      quiet(() => { span?.setAttribute("nene.success", false); span?.setStatus({ code: 2, message: "operation_failed" }); });
      captureFailure(name, error, run);
      throw error;
    } finally { quiet(() => span?.end(timing?.endTime())); }
  };
  // No retry/fallback around the callback: telemetry must never repeat a business operation.
  return span ? Sentry.withActiveSpan(span, work) : work();
}
export function currentAttributes(attributes: Attributes) { quiet(() => Sentry.getActiveSpan()?.setAttributes(safeAttributes(attributes))); }
export async function flushTelemetry() { await Sentry.flush(2000).catch(() => false); }

export function toolCategory(name: unknown): Category {
  if (typeof name !== "string") return "other";
  if (/execute|shell|bash|terminal/i.test(name)) return "execute";
  if (/edit|patch/i.test(name)) return "edit";
  if (/write/i.test(name) && !/todo/i.test(name)) return "write";
  if (/read|list|glob|grep|search/i.test(name)) return "read";
  return "other";
}
export function verificationCategory(command: unknown): string | undefined {
  if (typeof command !== "string") return;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(command)) return "build";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|\beslint\b|\bruff\s+check\b/.test(command)) return "lint";
  if (/\btsc\b|\btypecheck\b|\bmypy\b/.test(command)) return "typecheck";
  if (/\bnode\s+(?:-c|--check)\b|\bpython\S*\s+-m\s+py_compile\b/.test(command)) return "syntax";
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bvitest\b|\bjest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(command)) return "test";
}
function token(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function rate(key: string, fallback: number) {
  const value = Number(process.env[key] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
export function usageValues(usage: any) {
  if (!usage || typeof usage !== "object") return;
  const input = token(usage.inputTokens), output = token(usage.outputTokens), cached = token(usage.cachedTokens ?? 0);
  if (input === undefined || output === undefined || cached === undefined || cached > input || !Number.isSafeInteger(input + output)) return;
  const known = usage.provider === "digitalocean" && usage.model === "gemma-4-31B-it";
  const inputCost = known ? ((input - cached) * rate("SENTRY_MODEL_INPUT_USD_PER_MILLION", .18) + cached * rate("SENTRY_MODEL_CACHE_USD_PER_MILLION", .036)) / 1e6 : 0;
  const outputCost = known ? output * rate("SENTRY_MODEL_OUTPUT_USD_PER_MILLION", .5) / 1e6 : 0;
  return { input, output, cached, total: input + output, known, inputCost, outputCost, cost: inputCost + outputCost };
}
type PendingTool = { category: Category; verification?: string; span?: Sentry.Span };

// One observer per active worker. No prompts, file paths, raw events, or command output
// are retained here. Only bounded pending IDs and aggregate counters survive an event.
export class AgentTelemetry {
  private span?: Sentry.Span;
  private tools = new Map<string, PendingTool>();
  private requested = new Map<string, string>();
  private sequences = new Map<string, number>();
  private boundary?: number;
  private lastEnd?: number;
  private counts = { tools: 0, failed: 0, unmatched: 0, read: 0, write: 0, edit: 0, execute: 0, other: 0,
    verification: 0, passed: 0, verificationFailed: 0, unknown: 0, input: 0, output: 0, cached: 0,
    usage: 0, invalid: 0, unknownModel: 0, inputCost: 0, outputCost: 0, toolSpans: 0, modelSpans: 0, dropped: 0 };
  constructor(private run: Run, private clock: () => number = Date.now, private evidence: Attributes = {}) {}
  async trace<T>(callback: () => Promise<T>): Promise<T> {
    return operation(this.run, this.run.sourceTaskId ? "project update" : "initial build", "gen_ai.invoke_agent", async () => {
      this.span = Sentry.getActiveSpan();
      lifecycle("Agent run started", this.run, this.evidence);
      try { return await callback(); }
      finally {
        for (const tool of this.tools.values()) { quiet(() => { tool.span?.setStatus({ code: 2, message: "result_missing" }); tool.span?.end(this.clock() / 1000); }); this.counts.unmatched++; if (tool.verification) this.counts.unknown++; }
        this.tools.clear(); this.requested.clear();
        const summary = this.summary();
        currentAttributes({ ...summary, "nene.progress": this.run.progress, "nene.success": this.run.status === "waiting_for_approval",
          "nene.agent.write_count": this.run.writeCount, "nene.agent.duration_ms": Math.max(0, this.clock() - Date.parse(this.run.createdAt)) });
        if (["failed", "interrupted"].includes(this.run.status)) quiet(() => this.span?.setStatus({ code: 2, message: "agent_failed" }));
        lifecycle(this.run.status === "waiting_for_approval" ? "Agent ready for approval" : "Agent run failed", this.run, summary);
      }
    }, { "gen_ai.operation.name": "invoke_agent", "gen_ai.operation.type": "agent", "gen_ai.agent.name": "ne-ne coder",
      "gen_ai.request.model": "gemma-4-31B-it", "nene.recovered": false, ...this.evidence }, true,
      this.evidence["nene.evidence.kind"] === "historical_replay" ? { startTime: this.clock() / 1000, endTime: () => this.clock() / 1000 } : undefined);
  }
  observe(event: any, details = true): void {
    // Observability parsing is best-effort and cannot interrupt persistence/execution.
    quiet(() => this.consume(event, details));
  }
  private consume(event: any, details: boolean) {
    if (!event || typeof event !== "object") return;
    if (typeof event.session_id === "string" && typeof event.sequence === "number") {
      const id = event.session_id;
      if (event.sequence <= (this.sequences.get(id) ?? -1)) return;
      if (!this.sequences.has(id) && this.sequences.size >= 4) this.sequences.delete(this.sequences.keys().next().value!);
      this.sequences.set(id, event.sequence);
    }
    const payload = event.payload ?? {};
    const time = this.clock();
    if (event.type === "turn:start" || event.type === "assistant:delta" && this.boundary === undefined) this.boundary ??= time;
    if (event.type === "tool:requested" && Array.isArray(payload.calls)) {
      for (const call of payload.calls.slice(0, DETAIL_LIMITS.pending)) {
        const category = toolCategory(call?.name);
        const verification = category === "execute" ? verificationCategory(call?.input?.command) : undefined;
        if (typeof call?.id === "string" && verification && this.requested.size < DETAIL_LIMITS.pending) this.requested.set(call.id, verification);
      }
    }
    if (event.type === "tool:start") {
      const id = payload.toolCallId;
      if (typeof id !== "string" || this.tools.has(id)) return;
      const category = toolCategory(payload.name);
      const verification = this.requested.get(id) ?? (category === "execute" ? verificationCategory(payload.inputSummary) : undefined);
      this.requested.delete(id);
      this.counts.tools++; this.counts[category]++;
      if (verification) this.counts.verification++;
      if (this.tools.size >= DETAIL_LIMITS.pending) { this.counts.dropped++; this.counts.unmatched++; if (verification) this.counts.unknown++; return; }
      let span: Sentry.Span | undefined;
      if (details && this.counts.toolSpans < DETAIL_LIMITS.tools && this.span && Sentry.getClient()) {
        this.counts.toolSpans++;
        span = Sentry.startInactiveSpan({ name: `execute_tool ${verification ? `verify ${verification}` : category}`, op: "gen_ai.execute_tool", parentSpan: this.span,
          attributes: safeAttributes({ ...runAttributes(this.run), ...this.evidence, "gen_ai.operation.name": "execute_tool", "gen_ai.operation.type": "tool",
            "gen_ai.tool.name": verification ? `verify_${verification}` : category, "gen_ai.tool.type": "function", "nene.verification.category": verification }), startTime: time / 1000 });
      } else if (details) this.counts.dropped++;
      this.tools.set(id, { category, verification, span });
    }
    if (event.type === "tool:result" || event.type === "tool:error") {
      const tool = this.tools.get(payload.toolCallId);
      if (!tool) return;
      this.tools.delete(payload.toolCallId);
      const failed = event.type === "tool:error";
      // Ordinary ExecuteTool events omit agentOutput. Its exact "Success" title
      // means exitCode===0 && !timedOut; Failed/Timed out are explicit failures.
      // Agent/subagent output may also expose a dedicated numeric exit-code line.
      const match = typeof payload.agentOutput === "string" ? /^exit code: (-?\d+)\s*$/m.exec(payload.agentOutput) : null;
      const exit = match ? Number(match[1]) : undefined;
      const titleSuccess = tool.category === "execute" && payload.title === "Success";
      const titleFailure = tool.category === "execute" && typeof payload.title === "string" && /^(Failed|Timed out)(:|$)/.test(payload.title);
      const success = failed || exit !== undefined && exit !== 0 || titleFailure ? false : titleSuccess || exit === 0 ? true : tool.category === "execute" ? undefined : true;
      if (success === false) {
        this.counts.failed++;
        if (details) captureFailure(tool.verification ? `verify ${tool.verification}` : `tool ${tool.category}`, new Error("Agent tool failed"), this.run);
      }
      if (tool.verification) {
        if (success === undefined) this.counts.unknown++;
        else if (success) this.counts.passed++;
        else this.counts.verificationFailed++;
      }
      if (success !== undefined) tool.span?.setAttribute("nene.success", success);
      if (tool.verification) tool.span?.setAttribute("nene.verification.result_source", match ? "backboard_exit_code" : failed ? "tool_error" : titleSuccess || titleFailure ? "backboard_title" : "unknown");
      if (exit !== undefined) tool.span?.setAttribute("nene.agent.exit_code", exit);
      tool.span?.setStatus(success === false ? { code: 2, message: "tool_failed" } : { code: 1 });
      tool.span?.end(time / 1000);
      this.lastEnd = time;
      this.boundary = undefined;
    }
    if (event.type === "usage") {
      const usage = usageValues(payload.usage);
      if (!usage) { this.counts.invalid++; return; }
      this.counts.usage++; this.counts.input += usage.input; this.counts.output += usage.output; this.counts.cached += usage.cached;
      this.counts.inputCost += usage.inputCost; this.counts.outputCost += usage.outputCost;
      if (!usage.known) this.counts.unknownModel++;
      const start = this.lastEnd ?? this.boundary;
      if (details && start !== undefined && start <= time && this.counts.modelSpans < DETAIL_LIMITS.models && this.span && Sentry.getClient()) {
        this.counts.modelSpans++;
        const span = Sentry.startInactiveSpan({ name: "chat Gemma", op: "gen_ai.chat", parentSpan: this.span, startTime: start / 1000,
          attributes: safeAttributes({ ...runAttributes(this.run), ...this.evidence, "gen_ai.operation.name": "chat", "gen_ai.operation.type": "ai_client",
            "gen_ai.system": "digitalocean", "gen_ai.request.model": usage.known ? "gemma-4-31B-it" : "unknown",
            "gen_ai.response.model": usage.known ? "gemma-4-31B-it" : "unknown", "gen_ai.usage.input_tokens": usage.input,
            "gen_ai.usage.output_tokens": usage.output, "gen_ai.usage.total_tokens": usage.total, "gen_ai.usage.cache_read.input_tokens": usage.cached,
            "gen_ai.cost.input_tokens": usage.known ? usage.inputCost : undefined, "gen_ai.cost.output_tokens": usage.known ? usage.outputCost : undefined,
            "gen_ai.cost.total_tokens": usage.known ? usage.cost : undefined, "nene.cost.kind": "observed_usage_estimate",
            "nene.model.latency_kind": "observed_interval", "nene.model.request_index": this.counts.usage }) });
        span.end(time / 1000);
      } else if (details) this.counts.dropped++;
      this.boundary = undefined; this.lastEnd = undefined;
    }
  }
  summary(): Record<string, string | number | boolean> {
    const c = this.counts;
    return { "gen_ai.usage.input_tokens": c.input, "gen_ai.usage.output_tokens": c.output, "gen_ai.usage.total_tokens": c.input + c.output,
      "gen_ai.usage.cache_read.input_tokens": c.cached, "gen_ai.cost.input_tokens": c.inputCost, "gen_ai.cost.output_tokens": c.outputCost,
      "gen_ai.cost.total_tokens": c.inputCost + c.outputCost, "nene.cost.kind": "observed_usage_estimate", "nene.cost.currency": "USD",
      "nene.cost.rate_date": process.env.SENTRY_MODEL_RATE_DATE ?? "2026-10-04", "nene.usage.observed": true,
      "nene.usage.source": "backboard_usage_events", "nene.usage.events": c.usage, "nene.usage.invalid_events": c.invalid,
      "nene.usage.unknown_model_events": c.unknownModel, "nene.tools.total": c.tools, "nene.tools.failed": c.failed,
      "nene.tools.unmatched": c.unmatched, "nene.tools.read": c.read, "nene.tools.write": c.write, "nene.tools.edit": c.edit,
      "nene.tools.execute": c.execute, "nene.tools.other": c.other, "nene.verification.total": c.verification,
      "nene.verification.passed": c.passed, "nene.verification.failed": c.verificationFailed, "nene.verification.unknown": c.unknown,
      "nene.telemetry.tool_spans": c.toolSpans, "nene.telemetry.model_spans": c.modelSpans, "nene.telemetry.dropped_spans": c.dropped,
      "nene.telemetry.truncated": c.dropped > 0 };
  }
}

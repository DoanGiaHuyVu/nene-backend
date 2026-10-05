import type { Event, Log } from "@sentry/node";

const SECRET_KEYS = /(?:KEY|TOKEN|PASSWORD|SECRET|URI|DSN|RUN_CODE)$/i;
const secrets = Object.entries(process.env).filter(([key, value]) => SECRET_KEYS.test(key) && value && value.length >= 6).map(([, value]) => value!);
const ATTRIBUTES = new Set([
  "service.name", "sentry.op", "sentry.origin", "sentry.kind", "sentry.sample_rate", "sentry.segment.name", "sentry.segment.name.source",
  "sentry.environment", "sentry.release", "sentry.segment.id", "sentry.sdk.name", "sentry.sdk.version", "sentry.trace_lifecycle",
  "gen_ai.operation.name", "gen_ai.operation.type", "gen_ai.agent.name", "gen_ai.conversation.id", "gen_ai.system",
  "gen_ai.request.model", "gen_ai.response.model", "gen_ai.tool.name", "gen_ai.tool.type",
  "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.total_tokens", "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.cost.input_tokens", "gen_ai.cost.output_tokens", "gen_ai.cost.total_tokens",
  "http.request.method", "http.response.status_code", "http.route",
  "nene.run.id", "nene.project.id", "nene.source_run.id", "nene.run.type", "nene.progress", "nene.operation", "nene.success",
  "nene.recovered", "nene.usage.observed", "nene.usage.source", "nene.usage.events", "nene.usage.invalid_events", "nene.usage.unknown_model_events",
  "nene.tools.total", "nene.tools.failed", "nene.tools.unmatched", "nene.tools.read", "nene.tools.write", "nene.tools.edit", "nene.tools.execute", "nene.tools.other",
  "nene.verification.total", "nene.verification.passed", "nene.verification.failed", "nene.verification.unknown", "nene.verification.category",
  "nene.verification.result_source",
  "nene.telemetry.truncated", "nene.telemetry.tool_spans", "nene.telemetry.model_spans", "nene.telemetry.dropped_spans", "nene.telemetry.dropped_errors",
  "nene.agent.duration_ms", "nene.agent.write_count", "nene.agent.exit_code", "nene.container.name", "nene.artifact.exists",
  "nene.cost.kind", "nene.cost.rate_date", "nene.cost.currency", "nene.model.latency_kind", "nene.model.request_index",
  "nene.github.branch", "nene.github.commit", "nene.deployment.kind", "nene.deployment.service_id", "nene.deployment.deploy_id", "nene.deployment.status",
  "nene.deployment.elapsed_ms", "nene.approval.wait_ms", "nene.evidence.kind", "nene.evidence.id", "nene.error.kind", "nene.error.code",
]);

export function redact(value: string): string {
  let result = value;
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result.replace(/(?:Bearer\s+)[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(?:mongodb(?:\+srv)?|https?):\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, "[REDACTED URL]")
    .slice(0, 256);
}
export function safeAttributes(values: Record<string, unknown> = {}) {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ATTRIBUTES.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") result[key] = value as number | boolean;
    else if (typeof value === "string") result[key] = key === "sentry.segment.name" && !value.startsWith("ne-ne") && !/^(invoke_agent|execute_tool|chat) /.test(value)
      ? "ne-ne HTTP request" : redact(value);
  }
  return result;
}

// Keep backend stack locations, but never request bodies, user data, local variables,
// source context, arbitrary exception text, raw agent events, or filesystem attachments.
export function sanitizeEvent<T extends Event>(event: T): T {
  delete event.request; delete event.user; delete event.extra; delete event.breadcrumbs; delete event.server_name;
  delete event.modules; delete event.logentry; delete event.threads;
  event.message = event.message === "ne-ne Sentry setup test" ? event.message : undefined;
  const trace = event.contexts?.trace;
  event.contexts = trace ? { trace: { trace_id: trace.trace_id, span_id: trace.span_id, parent_span_id: trace.parent_span_id,
    op: trace.op, status: trace.status, data: safeAttributes(trace.data) } } : {};
  event.tags = safeAttributes(event.tags);
  for (const exception of event.exception?.values ?? []) {
    exception.value = "ne-ne operation failed; inspect the correlated operation and trace";
    exception.type = /^(Error|TypeError|RangeError|SyntaxError|TelemetryError)$/.test(exception.type ?? "") ? exception.type : "Error";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars; delete frame.pre_context; delete frame.post_context; delete frame.context_line;
      frame.filename = frame.filename?.split("?")[0];
      frame.abs_path = undefined;
    }
  }
  return event;
}
export function sanitizeLog(log: Log): Log {
  return { ...log, message: redact(String(log.message)), attributes: safeAttributes(log.attributes) };
}

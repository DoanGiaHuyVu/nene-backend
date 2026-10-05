import * as Sentry from "@sentry/node";
import { safeAttributes, sanitizeEvent, sanitizeLog } from "./telemetry-privacy.js";

export function sampleRate(value = process.env.SENTRY_TRACES_SAMPLE_RATE): number {
  const rate = Number(value ?? "1");
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: sampleRate(),
    traceLifecycle: "stream",
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
    includeServerName: false,
    attachStacktrace: false,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    transportOptions: { bufferSize: 16 },
    // Explicit integrations avoid instrumenting every database write, child-process
    // command, and console line in the raw agent stream on this small host.
    defaultIntegrations: false,
    integrations: [Sentry.httpIntegration({ breadcrumbs: false, ignoreOutgoingRequests: () => true,
      ignoreIncomingRequests: url => url.includes("/events") || url.includes("/health") }),
      // The existing final error middleware reports unexpected failures once.
      Sentry.expressIntegration({ ignoreLayersType: ["middleware"], shouldHandleError: () => false }),
      Sentry.spanStreamingIntegration(), Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
    tracePropagationTargets: [/^http:\/\/127\.0\.0\.1(?::\d+)?\//],
    beforeSend: event => sanitizeEvent(event),
    beforeSendSpan: span => ({ ...span, name: span.name.startsWith("ne-ne") || /^(invoke_agent|execute_tool|chat) /.test(span.name)
      ? span.name : "ne-ne HTTP request", attributes: safeAttributes(span.attributes), links: undefined }),
    beforeSendLog: sanitizeLog,
    initialScope: { tags: { "service.name": "nene-backend" } },
  });
}

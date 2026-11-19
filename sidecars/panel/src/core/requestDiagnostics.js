// Export only allowlisted timing and counts, never prompts, credentials or tool arguments.
export function buildRequestDiagnostics(step) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value) => typeof value === 'string' ? value.slice(0, 160) : null;
  const ttft = finite(step.nativeTtftSec ?? step.ttftSec);
  const total = finite(step.totalDurationSec);
  const raw = step.requestDiagnostics;
  const notes = [];
  if (ttft !== null && ttft >= 60) notes.push('long_first_token_wait');
  if (step.inputTokens > 0 && step.cacheReadTokens === 0) notes.push('zero_cache_read_recorded');
  if (ttft !== null && total !== null && total >= ttft && total - ttft < 0.5 && step.hasToolCalls) {
    notes.push('tool_call_returned_in_short_interval');
  }
  return {
    schemaVersion: 1,
    stepIndex: finite(step.stepIndex),
    model: text(step.responseModel || step.modelKey),
    timingSeconds: {
      timeToFirstToken: ttft,
      totalRequest: total,
      nativeStreaming: finite(step.nativeStreamSec),
      nativeThinking: finite(step.thinkingDurationSec),
      // This interval is not an independent network/GPU throughput measurement.
      afterFirstToken: total !== null && ttft !== null && total >= ttft
        ? +(total - ttft).toFixed(6) : null,
    },
    tokens: {
      input: finite(step.inputTokens), cacheRead: finite(step.cacheReadTokens),
      output: finite(step.outputTokens), thinking: finite(step.thinkingTokens),
    },
    rawMetadata: raw ? {
      createdAt: text(raw.createdAt), viewableAt: text(raw.viewableAt),
      finishedGeneratingAt: text(raw.finishedGeneratingAt), completedAt: text(raw.completedAt),
      status: text(raw.status), retryInfoCount: finite(raw.retryInfoCount),
      toolNames: Array.isArray(raw.toolNames) ? raw.toolNames.slice(0, 32).map(text) : [],
    } : null,
    anomalySummary: step.anomaly ? {
      primaryKind: text(step.anomaly.primaryKind), severity: text(step.anomaly.severity),
      count: finite(step.anomaly.count), totalDelaySec: finite(step.anomaly.totalDelaySec),
    } : null,
    notes,
    limitations: [
      'Native timing intervals may overlap; do not add them or infer causality from matching durations.',
      'DNS, TCP, TLS, server queue and prefill timings are unavailable.',
      'Missing retry metadata means unknown; entry counts are not necessarily retry attempts.',
      'Tool execution errors are separate from model request failures.',
      'The 60-second warning threshold is not an asserted service timeout.',
    ],
  };
}

/** Métricas HTTP en memoria por proceso (exportadas en /metrics). */
const durations: number[] = [];
const counters = { requests: 0, errors4xx: 0, errors5xx: 0 };

export const metrics = {
  record(ms: number, status: number) {
    counters.requests++;
    if (status >= 500) counters.errors5xx++;
    else if (status >= 400) counters.errors4xx++;
    durations.push(ms);
    if (durations.length > 5000) durations.shift();
  },
  snapshot() {
    const sorted = [...durations].sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
    return { ...counters, p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99), sample: sorted.length };
  },
};

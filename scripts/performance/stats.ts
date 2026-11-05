export function summarize(samples: readonly number[]) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Expected finite nonnegative timing samples.");
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]!;
  return {
    samples: sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1)!,
  };
}

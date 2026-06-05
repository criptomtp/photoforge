// Trigger background worker invocations. On Vercel a bare fire-and-forget fetch is
// DROPPED when the handler returns (the instance freezes), which silently breaks
// the chain. So we AWAIT each kick but with a timeout: long enough to deliver the
// request AND survive a cold start (3-5s) so a worker actually spawns, short
// enough not to wait for that worker's full run. MUST be awaited by callers
// (all run under a 30-60s maxDuration, so 8s worst-case is safe).
export async function kickWorker(times = 1): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) return;
  await Promise.all(
    Array.from({ length: times }, () =>
      fetch(`${base}/api/worker`, {
        method: "POST",
        headers: { "x-worker-secret": secret },
        signal: AbortSignal.timeout(8000),
      }).catch(() => {})
    )
  );
}

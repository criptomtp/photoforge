// Trigger background worker invocations. On Vercel a bare fire-and-forget fetch is
// DROPPED when the handler returns (the instance freezes), which silently breaks
// the chain. So we AWAIT each kick but with a short timeout: long enough to
// deliver the request (which spawns an independent worker invocation), short
// enough not to wait for that worker's full run. MUST be awaited by callers.
export async function kickWorker(times = 1): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) return;
  await Promise.all(
    Array.from({ length: times }, () =>
      fetch(`${base}/api/worker`, {
        method: "POST",
        headers: { "x-worker-secret": secret },
        signal: AbortSignal.timeout(2500),
      }).catch(() => {})
    )
  );
}

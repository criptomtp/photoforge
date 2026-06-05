// Fire-and-forget trigger for the background generation worker. Server-to-server
// (carries WORKER_SECRET), so it can be called from API routes and the worker's
// own self-re-trigger. Never awaited — it just spawns independent invocations.
export function kickWorker(times = 1): void {
  const base = process.env.NEXT_PUBLIC_APP_URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret) return;
  for (let i = 0; i < times; i++) {
    fetch(`${base}/api/worker`, {
      method: "POST",
      headers: { "x-worker-secret": secret },
    }).catch(() => {});
  }
}

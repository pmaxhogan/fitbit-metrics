import { LOOKBACK_DAYS, MAX_CONCURRENCY } from "./consts";

export function dateChunks(startDate: string, endDate: string, maxDays: number): [string, string][] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const chunks: [string, string][] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + (maxDays - 1) * 86400000, end.getTime()));
    chunks.push([cursor.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

export function dateRange(): { start: string; end: string } {
  const now = new Date();
  // Use yesterday as end date to avoid incomplete/future days from UTC offset
  const yesterday = new Date(now.getTime() - 86400000);
  const end = yesterday.toISOString().slice(0, 10);
  const start = new Date(yesterday.getTime() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

// --- Concurrency-limited pool ---

export async function pooled<T>(tasks: (() => Promise<T>)[], concurrency = MAX_CONCURRENCY): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

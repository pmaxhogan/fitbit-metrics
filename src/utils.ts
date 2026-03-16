import { LOOKBACK_DAYS } from "./consts";

export function dateChunks(startDate: string, endDate: string, maxDays: number): [string, string][] {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const chunks: [string, string][] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(
      Math.min(cursor.getTime() + (maxDays - 1) * 86400000, end.getTime())
    );
    chunks.push([cursor.toISOString().slice(0, 10), chunkEnd.toISOString().slice(0, 10)]);
    cursor = new Date(chunkEnd.getTime() + 86400000);
  }
  return chunks;
}

export function dateRange(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - LOOKBACK_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}
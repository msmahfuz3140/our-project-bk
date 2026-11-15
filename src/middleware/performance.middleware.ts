import { Request, Response, NextFunction } from 'express';
import { memoryCache } from '../utils/cache';

interface RequestSample {
  durationMs: number;
  method: string;
  path: string;
  status: number;
  at: number;
}

class PerformanceMetrics {
  private totalRequests = 0;
  private totalDurationMs = 0;
  private slowRequests = 0;
  private recent: RequestSample[] = [];
  private readonly maxSamples = 1000;
  private readonly startedAt = Date.now();

  record(sample: RequestSample): void {
    this.totalRequests += 1;
    this.totalDurationMs += sample.durationMs;
    if (sample.durationMs >= 500) this.slowRequests += 1;
    this.recent.push(sample);
    if (this.recent.length > this.maxSamples) {
      this.recent.splice(0, this.recent.length - this.maxSamples);
    }
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[index] * 100) / 100;
  }

  snapshot() {
    const durations = this.recent.map((sample) => sample.durationMs);
    const statusCounts: Record<string, number> = {};
    const pathCounts: Record<string, number> = {};

    for (const sample of this.recent) {
      const statusGroup = `${Math.floor(sample.status / 100)}xx`;
      statusCounts[statusGroup] = (statusCounts[statusGroup] || 0) + 1;
      pathCounts[sample.path] = (pathCounts[sample.path] || 0) + 1;
    }

    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      processUptimeSeconds: Math.floor(process.uptime()),
      requests: {
        total: this.totalRequests,
        sampled: this.recent.length,
        slow: this.slowRequests,
        avgMs: this.totalRequests > 0 ? Math.round((this.totalDurationMs / this.totalRequests) * 100) / 100 : 0,
        p50Ms: this.percentile(durations, 50),
        p95Ms: this.percentile(durations, 95),
        p99Ms: this.percentile(durations, 99),
        maxMs: durations.length ? Math.max(...durations) : 0,
        statusCounts
      },
      topPaths: Object.entries(pathCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([path, count]) => ({ path, count })),
      cache: memoryCache.getStats(),
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      generatedAt: new Date().toISOString()
    };
  }
}

export const performanceMetrics = new PerformanceMetrics();

function normalizePath(originalUrl: string): string {
  return originalUrl
    .split('?')[0]
    .replace(/\/[a-f0-9]{24}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

export function performanceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    performanceMetrics.record({
      durationMs,
      method: req.method,
      path: normalizePath(req.originalUrl),
      status: res.statusCode,
      at: Date.now()
    });
  });
  next();
}

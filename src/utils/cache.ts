import { env } from '../config/env';
import { logger } from './logger';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  memoryEntries: number;
  redisConfigured: boolean;
  redisHealthy: boolean;
  redisLastError: string | null;
  hitRate: number;
}

/**
 * Canonical cache keys. Keeping them in one place prevents silent
 * invalidation misses when a writer and reader disagree on the key.
 */
export const cacheKeys = {
  publicSettings: 'public:settings:v1',
  publicPlans: 'public:plans:v1',
  publicToolStatus: 'public:toolStatus:v1',
  adminDashboard: 'admin:dashboardMetrics:v2',
  adminFinancial: 'admin:financialSummary:v2',
  adminPaymentSummary: 'admin:paymentSummary:v1',
  adminAllPlans: 'admin:allPlans:v1',
  adminUserSummary: 'admin:userSummary:v1',
  adminSystemHealth: 'admin:systemHealth:v1',
  userDashboard: (userId: string) => `user:${userId}:dashboard:v1`,
  userNotifications: (userId: string) => `user:${userId}:notifications:v1`,
  authContext: (userId: string) => `auth:${userId}:context:v1`,
  moderatorDashboard: (userId: string) => `moderator:${userId}:dashboard:v1`
} as const;

const REDIS_KEY_PREFIX = 'ra:';
const REDIS_CIRCUIT_OPEN_MS = 60_000;

/**
 * Multi-layer cache:
 * - Process memory for sub-millisecond repeated reads.
 * - Optional Redis REST (Upstash / Vercel KV) for cross-instance consistency.
 * - Automatic memory fallback when Redis is absent, slow, or failing.
 *
 * All private data must use user-scoped keys. Public keys are limited to
 * settings/plans/tool status and never contain user or payment information.
 */
class CacheService {
  private store = new Map<string, CacheEntry<any>>();
  private inFlight = new Map<string, Promise<any>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;

  private redisFailures = 0;
  private redisDisabledUntil = 0;
  private redisLastError: string | null = null;

  private readonly redisUrl = (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').replace(/\/+$/, '');
  private readonly redisToken = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';

  constructor() {
    this.cleanupInterval = setInterval(() => this.prune(), 60_000);
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  get redisConfigured(): boolean {
    return Boolean(this.redisUrl && this.redisToken);
  }

  private get redisHealthy(): boolean {
    return this.redisConfigured && Date.now() >= this.redisDisabledUntil;
  }

  private memoryKey(key: string): string {
    return REDIS_KEY_PREFIX + key;
  }

  private async redisCommand(command: unknown[]): Promise<any> {
    if (!this.redisHealthy) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.CACHE_REDIS_TIMEOUT_MS);

    try {
      const response = await fetch(this.redisUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Redis REST returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as { result?: unknown; error?: string };
      if (data.error) throw new Error(data.error);
      this.redisFailures = 0;
      return data.result;
    } catch (error: any) {
      this.redisFailures += 1;
      this.redisLastError = error?.name === 'AbortError' ? 'Redis request timed out' : (error?.message || 'Redis error');
      if (this.redisFailures >= 3) {
        this.redisDisabledUntil = Date.now() + REDIS_CIRCUIT_OPEN_MS;
        logger.warn('Redis cache circuit opened after repeated failures; using memory fallback', {
          error: this.redisLastError
        });
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number = 30): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000
    });
    this.sets += 1;

    if (this.redisHealthy) {
      void this.redisCommand([
        'SET',
        this.memoryKey(key),
        JSON.stringify(value),
        'PX',
        String(Math.max(1, ttlSeconds) * 1000)
      ]);
    }
  }

  /**
   * Deduplicates concurrent cache misses so only one database query is made
   * for the same key even under a burst of traffic.
   */
  async getOrSet<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.hits += 1;
      return pending as Promise<T>;
    }

    const promise = (async () => {
      if (this.redisHealthy) {
        const remote = await this.redisCommand(['GET', this.memoryKey(key)]);
        if (typeof remote === 'string' && remote.length > 0) {
          try {
            const parsed = JSON.parse(remote) as T;
            this.store.set(key, {
              value: parsed,
              expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000
            });
            this.hits += 1;
            return parsed;
          } catch {
            // Corrupt cache entry: fall through to the database.
          }
        }
      }

      this.misses += 1;
      const fresh = await fetcher();
      this.set(key, fresh, ttlSeconds);
      return fresh;
    })().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  del(key: string): void {
    this.store.delete(key);
    this.deletes += 1;
    if (this.redisHealthy) {
      void this.redisCommand(['DEL', this.memoryKey(key)]);
    }
  }

  /**
   * Memory-only cache for user-private authorization context. Never written to
   * Redis or any shared/public store.
   */
  async getOrSetLocal<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.hits += 1;
      return pending as Promise<T>;
    }

    this.misses += 1;
    const promise = fetcher()
      .then((fresh) => {
        this.store.set(key, {
          value: fresh,
          expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000
        });
        this.sets += 1;
        return fresh;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  async delAsync(key: string): Promise<void> {
    this.del(key);
  }

  delByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
    this.deletes += 1;

    if (this.redisHealthy) {
      void this.redisDeleteByPrefix(this.memoryKey(prefix));
    }
  }

  private async redisDeleteByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    let guard = 0;

    do {
      const result = await this.redisCommand([
        'SCAN',
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        '100'
      ]);

      if (!Array.isArray(result) || result.length < 2) return;
      cursor = String(result[0]);
      const keys = Array.isArray(result[1]) ? result[1] : [];
      if (keys.length > 0) {
        await this.redisCommand(['DEL', ...keys]);
      }

      guard += 1;
    } while (cursor !== '0' && guard < 50);
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
    this.deletes += 1;
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      memoryEntries: this.store.size,
      redisConfigured: this.redisConfigured,
      redisHealthy: this.redisHealthy,
      redisLastError: this.redisLastError,
      hitRate: total > 0 ? Math.round((this.hits / total) * 1000) / 10 : 0
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

export const memoryCache = new CacheService();

/**
 * Invalidate all caches affected by a payment/subscription transition.
 * This is deliberately broader than the minimum to avoid stale revenue or
 * Premium state after a verified webhook.
 */
export function invalidatePaymentCaches(userId?: string): void {
  memoryCache.del(cacheKeys.adminDashboard);
  memoryCache.del(cacheKeys.adminFinancial);
  memoryCache.del(cacheKeys.adminPaymentSummary);
  memoryCache.del(cacheKeys.adminSystemHealth);
  memoryCache.del(cacheKeys.adminUserSummary);
  if (userId) {
    memoryCache.del(cacheKeys.userDashboard(userId));
    memoryCache.delByPrefix(cacheKeys.userNotifications(userId));
    memoryCache.del(cacheKeys.authContext(userId));
  }
}

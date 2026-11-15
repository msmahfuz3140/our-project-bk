import crypto from 'node:crypto';
import { env } from '../config/env';
import { toolSettingsService } from './toolSettings.service';
import { logger } from '../utils/logger';

const EMPTY_BODY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const REQUEST_TIMEOUT_MS = 12_000;
// Shared across all website users. This prevents N browsers polling the same
// table from producing N upstream requests (and blowing the per-key quota).
const GET_CACHE_TTL_MS = 4_000;

export interface DsApiEnvelope {
  success: boolean;
  data?: any;
  error?: {
    code?: string;
    message?: string;
    details?: any;
  };
  meta?: any;
  request_id?: string;
}

interface DsCredentials {
  apiKey: string;
  baseUrl: string;
}

interface RawResult {
  json: DsApiEnvelope;
  status: number;
  requestId?: string;
  latencyMs: number;
}

export class DsProxyError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;
  public readonly details?: any;
  public readonly upstreamStatus?: number;
  public readonly requestId?: string;

  constructor(options: {
    httpStatus: number;
    code: string;
    message: string;
    details?: any;
    upstreamStatus?: number;
    requestId?: string;
  }) {
    super(options.message);
    this.name = 'DsProxyError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
    this.details = options.details;
    this.upstreamStatus = options.upstreamStatus;
    this.requestId = options.requestId;
  }
}

function normalizeBaseUrl(raw: string): string {
  let value = (raw || '').trim().replace(/\/+$/, '');
  if (value.endsWith('/api/v1')) value = value.slice(0, -'/api/v1'.length);
  else if (value.endsWith('/api')) value = value.slice(0, -'/api'.length);
  return value.replace(/\/+$/, '');
}

/**
 * Normalize an exact browser origin (scheme + host + port). The provider's
 * DOMAIN-mode keys compare this against the key's authorized origin exactly.
 */
function normalizeClientOrigin(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function resolveClientOrigin(requested?: string): string {
  return (
    normalizeClientOrigin(requested) ||
    normalizeClientOrigin(env.PUBLIC_WEBSITE_URL) ||
    normalizeClientOrigin(env.CORS_ORIGIN.split(',')[0]) ||
    ''
  );
}

function upstreamHttpStatus(status: number): number {
  if (status === 404) return 404;
  if (status === 422 || status === 400) return 422;
  if (status === 429) return 429;
  if (status === 503) return 503;
  if (status >= 400 && status < 500) return 502;
  return 502;
}

function upstreamCode(status: number, envelope?: DsApiEnvelope): string {
  const code = envelope?.error?.code;
  if (code) return code;
  if (status === 401 || status === 403) return 'DS_AUTH_FAILED';
  if (status === 429) return 'DS_RATE_LIMITED';
  if (status === 503) return 'DS_FEED_UNAVAILABLE';
  return 'DS_UPSTREAM_ERROR';
}

export class DsProxyService {
  private getCache = new Map<string, { expiresAt: number; value: DsApiEnvelope }>();
  private inFlight = new Map<string, Promise<DsApiEnvelope>>();

  /**
   * Build HMAC-SHA256 signed headers for the DS API.
   */
  private signRequest(
    apiKey: string,
    method: string,
    requestTarget: string,
    bodyBytes: string,
    clientOrigin: string
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('base64url');
    const bodyHash = bodyBytes
      ? crypto.createHash('sha256').update(bodyBytes).digest('hex')
      : EMPTY_BODY_HASH;

    const canonical = `${timestamp}\n${method.toUpperCase()}\n${requestTarget}\n${bodyHash}\n${nonce}`;

    const signature = crypto
      .createHmac('sha256', apiKey)
      .update(canonical)
      .digest('hex');

    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    // Server keys in DOMAIN mode require the exact authorized website origin.
    // The API guide documents x-client-origin; some provider builds also read
    // the standard Origin header, so both are sent. Neither is part of the
    // HMAC canonical string.
    if (clientOrigin) {
      headers['x-client-origin'] = clientOrigin;
      headers.Origin = clientOrigin;
    }

    return headers;
  }

  async invalidateCache(): Promise<void> {
    this.getCache.clear();
    this.inFlight.clear();
  }

  /**
   * Ensure DS API credentials are configured and normalize the base URL.
   */
  private async getCredentials(overrides?: {
    apiKey?: string;
    baseUrl?: string;
  }): Promise<DsCredentials> {
    const stored = await toolSettingsService.getDsApiCredentials();
    const apiKey = (overrides?.apiKey || stored.dsApiKey || '').trim();
    const rawBase = (overrides?.baseUrl || stored.dsApiUrl || '').trim();
    const baseUrl = normalizeBaseUrl(rawBase);

    if (!apiKey || !baseUrl) {
      throw new DsProxyError({
        httpStatus: 503,
        code: 'DS_NOT_CONFIGURED',
        message:
          'Dealer Signature API is not configured. An administrator must save the Public API URL and Server SK Key under Admin → Settings → API Settings.'
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new DsProxyError({
        httpStatus: 503,
        code: 'DS_INVALID_CONFIG',
        message: 'The saved API Public URL is invalid. It must be an absolute http:// or https:// URL.'
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new DsProxyError({
        httpStatus: 503,
        code: 'DS_INVALID_CONFIG',
        message: 'The saved API Public URL must use http:// or https://.'
      });
    }

    return { apiKey, baseUrl };
  }

  private buildQuery(params: Record<string, string | number | undefined>): string {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
    if (entries.length === 0) return '';
    return (
      '?' +
      entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    );
  }

  /**
   * Low-level signed request with a hard timeout and one bounded retry.
   */
  private async executeSigned(
    creds: DsCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    allowRetry = true,
    clientOrigin?: string
  ): Promise<RawResult> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const url = `${creds.baseUrl}${path}`;
    const startedAt = Date.now();
    const origin = resolveClientOrigin(clientOrigin);

    logger.debug(`DS Proxy ${method}: ${url} (origin: ${origin || 'none'})`);

    const attempt = async (isRetry: boolean): Promise<RawResult> => {
      // HMAC nonces are single-use. Every retry must be freshly signed with a
      // new timestamp, nonce and signature.
      const headers = this.signRequest(creds.apiKey, method, path, bodyStr, origin);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers,
          body: bodyStr || undefined,
          signal: controller.signal
        });
      } catch (err: any) {
        if (!isRetry && allowRetry) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return attempt(true);
        }
        const timedOut = err?.name === 'AbortError';
        throw new DsProxyError({
          httpStatus: timedOut ? 504 : 502,
          code: timedOut ? 'DS_API_TIMEOUT' : 'DS_NETWORK_ERROR',
          message: timedOut
            ? `The provider API did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
            : `Could not reach the provider API: ${err?.message || 'network failure'}`
        });
      } finally {
        clearTimeout(timer);
      }

      const latencyMs = Date.now() - startedAt;
      const requestId = response.headers.get('x-request-id') || undefined;
      const rawText = await response.text().catch(() => '');

      let json: DsApiEnvelope;
      try {
        json = rawText ? (JSON.parse(rawText) as DsApiEnvelope) : ({} as DsApiEnvelope);
      } catch {
        throw new DsProxyError({
          httpStatus: 502,
          code: 'DS_INVALID_RESPONSE',
          message: `The provider API returned a non-JSON response (HTTP ${response.status}).`,
          details: { preview: rawText.slice(0, 240) },
          upstreamStatus: response.status,
          requestId
        });
      }

      const resolvedRequestId =
        requestId || json?.request_id || json?.meta?.request_id || undefined;

      const hasProviderError = !!json?.error && json?.success !== true;
      if (!response.ok || json?.success === false || hasProviderError) {
        // Retry only transient server-side failures, never auth/permission
        // failures or rate limits (which have their own retry-after contract).
        if (!isRetry && allowRetry && response.status >= 500 && response.status !== 503) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return attempt(true);
        }

        throw new DsProxyError({
          httpStatus: upstreamHttpStatus(response.status),
          code: upstreamCode(response.status, json),
          message:
            json?.error?.message ||
            `The provider API returned HTTP ${response.status} ${response.statusText}`.trim(),
          details: json?.error?.details,
          upstreamStatus: response.status,
          requestId: resolvedRequestId
        });
      }

      return { json, status: response.status, requestId: resolvedRequestId, latencyMs };
    };

    return attempt(false);
  }

  /**
   * Cached + deduplicated public request used by website proxies.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: any,
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const cacheKey = `${method}:${path}`;

    if (method === 'GET') {
      const cached = this.getCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }

      const pending = this.inFlight.get(cacheKey);
      if (pending) return pending;
    }

    const promise = (async () => {
      try {
        const creds = await this.getCredentials();
        const result = await this.executeSigned(
          creds,
          method,
          path,
          body,
          true,
          clientOrigin
        );
        await toolSettingsService.recordDsRequest({
          ok: true,
          statusCode: result.status,
          requestId: result.requestId
        });
        if (method === 'GET') {
          this.getCache.set(cacheKey, {
            expiresAt: Date.now() + GET_CACHE_TTL_MS,
            value: result.json
          });
        }
        return result.json;
      } catch (err: any) {
        const proxyError =
          err instanceof DsProxyError
            ? err
            : new DsProxyError({
                httpStatus: 502,
                code: 'DS_PROXY_ERROR',
                message: err?.message || 'Failed to communicate with the provider API'
              });

        await toolSettingsService.recordDsRequest({
          ok: false,
          statusCode: proxyError.upstreamStatus,
          requestId: proxyError.requestId,
          error: `${proxyError.code}: ${proxyError.message}`
        });
        throw proxyError;
      }
    })();

    if (method === 'GET') {
      this.inFlight.set(cacheKey, promise);
    }

    try {
      return await promise;
    } finally {
      if (method === 'GET' && this.inFlight.get(cacheKey) === promise) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  // ─── Public API Methods ───────────────────────────────────────────

  async getStatus(clientOrigin?: string): Promise<DsApiEnvelope> {
    return this.request('GET', '/api/v1/status', undefined, clientOrigin);
  }

  async getTables(
    query?: {
      provider?: string;
      search?: string;
      filter?: string;
      sort?: string;
      window?: number;
      limit?: number;
    },
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const qs = this.buildQuery(query || {});
    return this.request('GET', `/api/v1/tables${qs}`, undefined, clientOrigin);
  }

  async getTable(tableId: string, clientOrigin?: string): Promise<DsApiEnvelope> {
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}`,
      undefined,
      clientOrigin
    );
  }

  async getTablePrediction(
    tableId: string,
    direction?: string,
    window?: number,
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const qs = this.buildQuery({ direction, window });
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}/prediction${qs}`,
      undefined,
      clientOrigin
    );
  }

  async getTableRhythm(
    tableId: string,
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}/rhythm`,
      undefined,
      clientOrigin
    );
  }

  async getTableTravelChart(
    tableId: string,
    direction?: string,
    window?: number,
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const qs = this.buildQuery({ direction, window });
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}/travel-chart${qs}`,
      undefined,
      clientOrigin
    );
  }

  async getTablePattern(
    tableId: string,
    direction?: string,
    window?: number,
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const qs = this.buildQuery({ direction, window });
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}/pattern${qs}`,
      undefined,
      clientOrigin
    );
  }

  async getTableHistory(
    tableId: string,
    query?: {
      period?: string;
      page?: number;
      limit?: number;
      window?: number;
    },
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    const qs = this.buildQuery(query || {});
    return this.request(
      'GET',
      `/api/v1/tables/${encodeURIComponent(tableId)}/history${qs}`,
      undefined,
      clientOrigin
    );
  }

  async scanTables(
    body?: {
      min_spins?: number;
      min_accuracy?: number;
      min_rhythm?: number;
      direction?: string;
      sort?: string;
      window?: number;
    },
    clientOrigin?: string
  ): Promise<DsApiEnvelope> {
    return this.request('POST', '/api/v1/scanner', body || {}, clientOrigin);
  }

  async isConfigured(): Promise<{ configured: boolean; apiUrl: string }> {
    const creds = await toolSettingsService.getDsApiCredentials();
    return {
      configured: !!(creds.dsApiKey && creds.dsApiUrl),
      apiUrl: creds.dsApiUrl || ''
    };
  }

  /**
   * Explicit admin connection test. Optionally tests unsaved form values before
   * they are persisted. The secret key is never echoed in the response.
   */
  async testConnection(
    overrides?: {
      apiKey?: string;
      baseUrl?: string;
    },
    requestedOrigin?: string
  ): Promise<{
    success: boolean;
    testedAt: string;
    latencyMs: number;
    apiUrl: string;
    clientOrigin: string;
    keyConfigured: boolean;
    checks: Array<{ name: string; ok: boolean; message: string }>;
    service?: string;
    version?: string;
    feed?: any;
    tableCount?: number;
    sampleTables?: string[];
    statusCode?: number;
    requestId?: string;
    error?: { code: string; message: string; details?: any };
  }> {
    const startedAt = Date.now();
    const testedAt = new Date().toISOString();
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    const clientOrigin = resolveClientOrigin(requestedOrigin);

    let creds: DsCredentials;
    try {
      creds = await this.getCredentials(overrides);
    } catch (err: any) {
      const message =
        err instanceof DsProxyError
          ? err.message
          : 'API credentials are missing or invalid.';
      checks.push({ name: 'credentials', ok: false, message });

      const stored = await toolSettingsService
        .getDsApiCredentials()
        .catch(() => ({ dsApiKey: '', dsApiUrl: '' }));
      const result = {
        success: false,
        testedAt,
        latencyMs: Date.now() - startedAt,
        apiUrl: normalizeBaseUrl(overrides?.baseUrl || stored.dsApiUrl || ''),
        clientOrigin,
        keyConfigured: !!(overrides?.apiKey || stored.dsApiKey),
        checks,
        error: {
          code: err instanceof DsProxyError ? err.code : 'DS_NOT_CONFIGURED',
          message
        }
      };
      await toolSettingsService.saveDsTestResult({
        success: false,
        message,
        latencyMs: result.latencyMs
      });
      return result;
    }

    checks.push({
      name: 'credentials',
      ok: true,
      message: `API URL and Server SK Key are present. Client origin: ${clientOrigin || 'not set'}.`
    });

    let statusJson: DsApiEnvelope | null = null;
    let statusCode: number | undefined;
    let requestId: string | undefined;
    let service: string | undefined;
    let version: string | undefined;
    let feed: any;

    try {
      const status = await this.executeSigned(
        creds,
        'GET',
        '/api/v1/status',
        undefined,
        true,
        clientOrigin
      );
      statusJson = status.json;
      statusCode = status.status;
      requestId = status.requestId;
      service = status.json?.data?.service;
      version = status.json?.data?.version;
      feed = status.json?.data?.feed;
      checks.push({
        name: 'status',
        ok: true,
        message: `Signed request accepted${service ? ` (${service}${version ? ` v${version}` : ''})` : ''}.`
      });
      checks.push({
        name: 'feed',
        ok: status.json?.data?.feed?.connected !== false,
        message:
          status.json?.data?.feed?.connected === false
            ? 'The provider reports that its live feed is disconnected.'
            : status.json?.data?.feed?.stale === true
              ? 'The provider reports that its live feed is stale.'
              : 'Provider live feed is connected.'
      });
    } catch (err: any) {
      const proxyError =
        err instanceof DsProxyError
          ? err
          : new DsProxyError({
              httpStatus: 502,
              code: 'DS_PROXY_ERROR',
              message: err?.message || 'Connection test failed'
            });
      statusCode = proxyError.upstreamStatus;
      requestId = proxyError.requestId;
      checks.push({ name: 'status', ok: false, message: proxyError.message });

      const latencyMs = Date.now() - startedAt;
      await toolSettingsService.saveDsTestResult({
        success: false,
        message: `${proxyError.code}: ${proxyError.message}`,
        latencyMs,
        statusCode
      });
      return {
        success: false,
        testedAt,
        latencyMs,
        apiUrl: creds.baseUrl,
        clientOrigin,
        keyConfigured: true,
        checks,
        statusCode,
        requestId,
        error: {
          code: proxyError.code,
          message: proxyError.message,
          details: proxyError.details
        }
      };
    }

    let tableCount: number | undefined;
    let sampleTables: string[] = [];
    let tablesOk = false;

    try {
      const tables = await this.executeSigned(
        creds,
        'GET',
        '/api/v1/tables?limit=5',
        undefined,
        true,
        clientOrigin
      );
      const payload = tables.json?.data || {};
      tableCount = typeof payload.total === 'number' ? payload.total : payload.tables?.length;
      sampleTables = Array.isArray(payload.tables)
        ? payload.tables.slice(0, 5).map((t: any) => t?.name || t?.id).filter(Boolean)
        : [];
      tablesOk = true;
      checks.push({
        name: 'tables.list',
        ok: true,
        message: `Table list permission confirmed${
          typeof tableCount === 'number' ? ` (${tableCount} live tables)` : ''
        }.`
      });
    } catch (err: any) {
      const proxyError =
        err instanceof DsProxyError
          ? err
          : new DsProxyError({
              httpStatus: 502,
              code: 'DS_PROXY_ERROR',
              message: err?.message || 'Table list test failed'
            });
      checks.push({
        name: 'tables.list',
        ok: false,
        message:
          proxyError.code === 'ENDPOINT_NOT_ALLOWED'
            ? 'The API key does not have the tables.list permission.'
            : proxyError.message
      });
    }

    const latencyMs = Date.now() - startedAt;
    const success = checks.every((check) => check.ok);
    const message = success
      ? `Connected successfully${service ? ` to ${service}` : ''}.`
      : checks
          .filter((check) => !check.ok)
          .map((check) => check.message)
          .join(' ');

    await toolSettingsService.saveDsTestResult({ success, message, latencyMs, statusCode });

    return {
      success,
      testedAt,
      latencyMs,
      apiUrl: creds.baseUrl,
      clientOrigin,
      keyConfigured: true,
      checks,
      service,
      version,
      feed,
      tableCount,
      sampleTables,
      statusCode,
      requestId,
      error: success
        ? undefined
        : {
            code: tablesOk ? 'DS_TEST_WARNING' : 'DS_TEST_FAILED',
            message
          }
    };
  }
}

export const dsProxyService = new DsProxyService();

import crypto from 'crypto';
import { env, isLivePaymentsEnabled } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';

export interface CreateNowPaymentsInvoiceInput {
  priceAmount: number;
  priceCurrency: string;
  orderId: string;
  orderDescription: string;
  ipnCallbackUrl: string;
  successUrl: string;
  cancelUrl: string;
  partiallyPaidUrl?: string;
}

export interface CreateNowPaymentsPaymentInput {
  priceAmount: number;
  priceCurrency: string;
  payAmount?: number;
  payCurrency: string;
  ipnCallbackUrl: string;
  orderId: string;
  orderDescription: string;
}

export class NowPaymentsApiError extends Error {
  public readonly statusCode: number;
  public readonly providerBody?: string;

  constructor(statusCode: number, message: string, providerBody?: string) {
    super(message);
    this.name = 'NowPaymentsApiError';
    this.statusCode = statusCode;
    this.providerBody = providerBody;
  }
}

export class NowPaymentsService {
  private get baseUrl(): string {
    return env.NOWPAYMENTS_API_URL.replace(/\/+$/, '');
  }

  get mode(): 'sandbox' | 'production' {
    return env.NOWPAYMENTS_ENV;
  }

  get isConfigured(): boolean {
    return env.NOWPAYMENTS_API_KEY.trim().length > 0;
  }

  /**
   * Recursively sorts all keys in an object alphabetically.
   * This is required by the official NOWPayments IPN signature algorithm.
   */
  sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.sortObjectKeys(item));
    }
    return Object.keys(obj)
      .sort()
      .reduce((acc: Record<string, any>, key: string) => {
        acc[key] = this.sortObjectKeys(obj[key]);
        return acc;
      }, {});
  }

  canonicalizePayload(payload: Record<string, unknown>): string {
    return JSON.stringify(this.sortObjectKeys(payload));
  }

  /**
   * Deterministic event identifier used for webhook idempotency.
   * Exact replays produce the same id and are rejected by a unique index.
   */
  buildEventId(payload: Record<string, unknown>): string {
    return crypto
      .createHash('sha256')
      .update(this.canonicalizePayload(payload))
      .digest('hex');
  }

  /**
   * Verifies the x-nowpayments-sig header using HMAC-SHA512 over the
   * recursively sorted JSON payload. Comparison is timing-safe.
   */
  verifyIpnSignature(payload: any, signature: string | undefined, customSecret?: string): boolean {
    const secret = (customSecret ?? env.NOWPAYMENTS_IPN_SECRET).trim();
    if (!signature || !secret || !payload || typeof payload !== 'object') {
      return false;
    }

    try {
      const candidate = signature.trim().toLowerCase();
      if (!/^[a-f0-9]{128}$/.test(candidate)) {
        return false;
      }

      const calculatedSig = crypto
        .createHmac('sha512', secret)
        .update(this.canonicalizePayload(payload))
        .digest('hex');

      const candidateBuffer = Buffer.from(candidate, 'hex');
      const calculatedBuffer = Buffer.from(calculatedSig, 'hex');

      if (candidateBuffer.length !== calculatedBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(candidateBuffer, calculatedBuffer);
    } catch (err) {
      logger.error('Error during NOWPayments IPN signature verification', err);
      return false;
    }
  }

  /**
   * Helper used by automated tests / internal diagnostics only.
   * Never expose this through an unauthenticated endpoint.
   */
  generateIpnSignature(payload: any, secret: string): string {
    return crypto
      .createHmac('sha512', secret.trim())
      .update(this.canonicalizePayload(payload))
      .digest('hex');
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: Record<string, unknown> } = {}
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new NowPaymentsApiError(503, 'NOWPayments API key is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.NOWPAYMENTS_API_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers: {
          'x-api-key': env.NOWPAYMENTS_API_KEY,
          ...(options.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
    } catch (error: any) {
      const timedOut = error?.name === 'AbortError';
      logger.error('NOWPayments API request failed', {
        path,
        timedOut,
        message: error?.message
      });
      throw new NowPaymentsApiError(
        502,
        timedOut
          ? 'NOWPayments API request timed out'
          : 'NOWPayments API is temporarily unreachable'
      );
    } finally {
      clearTimeout(timeout);
    }

    const rawText = await response.text().catch(() => '');
    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      // Do not log full provider responses: they are not needed for debugging
      // and could contain merchant-specific account metadata.
      logger.error('NOWPayments API returned an error', {
        path,
        status: response.status,
        providerCode: data?.code || data?.statusCode || undefined
      });
      throw new NowPaymentsApiError(
        response.status,
        `NOWPayments API returned HTTP ${response.status}`,
        rawText.slice(0, 1000)
      );
    }

    return data as T;
  }

  /**
   * Check NOWPayments API operational status (GET /v1/status).
   */
  async getStatus(): Promise<{ message: string }> {
    return this.request<{ message: string }>('/status');
  }

  /**
   * Get supported currencies list (GET /v1/currencies).
   */
  async getCurrencies(): Promise<string[]> {
    if (!this.isConfigured) {
      return [];
    }

    try {
      const data = await this.request<{ currencies: string[] }>('/currencies');
      return data.currencies || [];
    } catch (error: any) {
      logger.warn('Failed to fetch currencies from NOWPayments', { message: error?.message });
      return [];
    }
  }

  /**
   * Create a hosted invoice (POST /v1/invoice).
   * The invoice is always denominated in the server-side plan currency.
   */
  async createInvoice(input: CreateNowPaymentsInvoiceInput): Promise<any> {
    if (!isLivePaymentsEnabled()) {
      throw new NowPaymentsApiError(
        503,
        'Live payments are disabled until provider eligibility and legal authorization are confirmed'
      );
    }

    const payload: Record<string, unknown> = {
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency.toLowerCase(),
      order_id: input.orderId,
      order_description: input.orderDescription,
      ipn_callback_url: input.ipnCallbackUrl,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl
    };

    if (input.partiallyPaidUrl) {
      payload.partially_paid_url = input.partiallyPaidUrl;
    }

    return this.request<any>('/invoice', {
      method: 'POST',
      body: payload
    });
  }

  /**
   * Create a direct crypto payment with a fixed pay currency (POST /v1/payment).
   * Retained for future provider adapters; the hosted invoice flow is preferred.
   */
  async createPayment(input: CreateNowPaymentsPaymentInput): Promise<any> {
    if (!isLivePaymentsEnabled()) {
      throw new NowPaymentsApiError(
        503,
        'Live payments are disabled until provider eligibility and legal authorization are confirmed'
      );
    }

    const payload: Record<string, unknown> = {
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency.toLowerCase(),
      pay_currency: input.payCurrency.toLowerCase(),
      ipn_callback_url: input.ipnCallbackUrl,
      order_id: input.orderId,
      order_description: input.orderDescription
    };

    if (input.payAmount !== undefined) {
      payload.pay_amount = input.payAmount;
    }

    return this.request<any>('/payment', {
      method: 'POST',
      body: payload
    });
  }

  /**
   * Independently retrieve payment details from NOWPayments
   * (GET /v1/payment/{payment_id}). Used before granting Premium access.
   */
  async getPayment(paymentId: string): Promise<any> {
    if (!paymentId || !String(paymentId).trim()) {
      throw new NowPaymentsApiError(400, 'A NOWPayments payment id is required');
    }
    return this.request<any>(`/payment/${encodeURIComponent(String(paymentId).trim())}`);
  }

  /**
   * Safe, secret-free configuration summary for health checks.
   */
  getConfigurationStatus() {
    let apiHost = 'invalid';
    try {
      apiHost = new URL(this.baseUrl).host;
    } catch {
      apiHost = 'invalid';
    }

    return {
      provider: 'NOWPAYMENTS',
      mode: this.mode,
      apiHost,
      apiKeyConfigured: this.isConfigured,
      ipnSecretConfigured: env.NOWPAYMENTS_IPN_SECRET.trim().length > 0,
      liveEnabled: isLivePaymentsEnabled(),
      requireApiVerification: Boolean(env.NOWPAYMENTS_REQUIRE_API_VERIFICATION),
      webhookUrl: env.PAYMENT_IPN_CALLBACK_URL,
      successUrl: env.PAYMENT_SUCCESS_URL,
      cancelUrl: env.PAYMENT_CANCEL_URL
    };
  }
}

export const nowPaymentsService = new NowPaymentsService();

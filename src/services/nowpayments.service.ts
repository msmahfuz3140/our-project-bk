import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';

export interface CreateNowPaymentsInvoiceInput {
  priceAmount: number;
  priceCurrency: string;
  payCurrency?: string;
  orderId: string;
  orderDescription: string;
  ipnCallbackUrl: string;
  successUrl: string;
  cancelUrl: string;
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

export class NowPaymentsService {
  private baseUrl = env.NOWPAYMENTS_API_URL || 'https://api.nowpayments.io/v1';

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

  /**
   * Verifies the x-nowpayments-sig HMAC-SHA512 signature against the incoming payload.
   * Uses timing-safe equality to prevent timing attacks.
   */
  verifyIpnSignature(payload: any, signature: string | undefined, customSecret?: string): boolean {
    const secret = customSecret || env.NOWPAYMENTS_IPN_SECRET;
    if (!signature || !secret || secret.trim() === '') {
      return false;
    }

    try {
      const sortedPayload = this.sortObjectKeys(payload);
      const jsonString = JSON.stringify(sortedPayload);

      const calculatedSig = crypto
        .createHmac('sha512', secret.trim())
        .update(jsonString)
        .digest('hex');

      const sigBuffer = Buffer.from(signature.trim(), 'utf8');
      const calcBuffer = Buffer.from(calculatedSig.trim(), 'utf8');

      if (sigBuffer.length !== calcBuffer.length) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuffer, calcBuffer);
    } catch (err) {
      logger.error('Error during IPN signature verification', err);
      return false;
    }
  }

  /**
   * Helper to generate a valid signature for automated testing / simulation.
   */
  generateIpnSignature(payload: any, secret: string): string {
    const sortedPayload = this.sortObjectKeys(payload);
    const jsonString = JSON.stringify(sortedPayload);
    return crypto
      .createHmac('sha512', secret.trim())
      .update(jsonString)
      .digest('hex');
  }

  /**
   * Check NOWPayments API operational status (GET /v1/status)
   */
  async getStatus(): Promise<{ message: string }> {
    if (!env.NOWPAYMENTS_API_KEY) {
      return { message: 'SIMULATION_MODE_OK' };
    }

    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        headers: {
          'x-api-key': env.NOWPAYMENTS_API_KEY
        }
      });

      if (!response.ok) {
        throw new Error(`NOWPayments status returned ${response.status}`);
      }

      return (await response.json()) as { message: string };
    } catch (error) {
      logger.error('Failed to get NOWPayments status', error);
      throw ApiError.internal('Payment provider service is temporarily unreachable');
    }
  }

  /**
   * Get supported currencies list (GET /v1/currencies)
   */
  async getCurrencies(): Promise<string[]> {
    if (!env.NOWPAYMENTS_API_KEY) {
      return ['usdttrc20', 'usdterc20', 'usdtbep20', 'btc', 'eth', 'trx', 'ltc', 'sol', 'doge', 'usdc'];
    }

    try {
      const response = await fetch(`${this.baseUrl}/currencies`, {
        headers: {
          'x-api-key': env.NOWPAYMENTS_API_KEY
        }
      });

      if (!response.ok) {
        throw new Error(`NOWPayments currencies returned ${response.status}`);
      }

      const data = (await response.json()) as any;
      return data.currencies || [];
    } catch (error: any) {
      logger.warn('Failed to fetch currencies from NOWPayments, returning standard fallback list', { error: error?.message });
      return ['usdttrc20', 'usdterc20', 'usdtbep20', 'btc', 'eth', 'trx', 'ltc', 'sol', 'doge', 'usdc'];
    }
  }

  /**
   * Create an invoice with hosted checkout link (POST /v1/invoice)
   */
  async createInvoice(input: CreateNowPaymentsInvoiceInput): Promise<any> {
    if (!env.NOWPAYMENTS_API_KEY || env.NOWPAYMENTS_API_KEY.trim() === '') {
      return null;
    }

    const payload = {
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency.toLowerCase(),
      pay_currency: input.payCurrency ? input.payCurrency.toLowerCase() : undefined,
      order_id: input.orderId,
      order_description: input.orderDescription,
      ipn_callback_url: input.ipnCallbackUrl,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl
    };

    const response = await fetch(`${this.baseUrl}/invoice`, {
      method: 'POST',
      headers: {
        'x-api-key': env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error('NOWPayments createInvoice API error', { status: response.status, errText });
      throw new Error(`NOWPayments error ${response.status}: ${errText}`);
    }

    return await response.json();
  }

  /**
   * Create direct payment with wallet address (POST /v1/payment)
   */
  async createPayment(input: CreateNowPaymentsPaymentInput): Promise<any> {
    if (!env.NOWPAYMENTS_API_KEY || env.NOWPAYMENTS_API_KEY.trim() === '') {
      return null;
    }

    const payload = {
      price_amount: input.priceAmount,
      price_currency: input.priceCurrency.toLowerCase(),
      pay_amount: input.payAmount,
      pay_currency: input.payCurrency.toLowerCase(),
      ipn_callback_url: input.ipnCallbackUrl,
      order_id: input.orderId,
      order_description: input.orderDescription
    };

    const response = await fetch(`${this.baseUrl}/payment`, {
      method: 'POST',
      headers: {
        'x-api-key': env.NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error('NOWPayments createPayment API error', { status: response.status, errText });
      throw new Error(`NOWPayments error ${response.status}: ${errText}`);
    }

    return await response.json();
  }

  /**
   * Get payment details and live status (GET /v1/payment/{id})
   */
  async getPayment(paymentId: string): Promise<any> {
    if (!env.NOWPAYMENTS_API_KEY || env.NOWPAYMENTS_API_KEY.trim() === '') {
      return null;
    }

    const response = await fetch(`${this.baseUrl}/payment/${paymentId}`, {
      headers: {
        'x-api-key': env.NOWPAYMENTS_API_KEY
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`NOWPayments getPayment error ${response.status}: ${errText}`);
    }

    return await response.json();
  }
}

export const nowPaymentsService = new NowPaymentsService();

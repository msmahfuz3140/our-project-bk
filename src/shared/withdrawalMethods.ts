/**
 * Explicit withdrawal payout configuration.
 *
 * A method is listed here only when the platform is able to pay it out
 * manually through the admin approval workflow. Deposit support at the
 * payment provider is NOT sufficient by itself.
 */
export interface WithdrawalMethod {
  id: string;
  currency: string;
  network: string;
  label: string;
  addressPattern: string;
  addressHint: string;
}

export const WITHDRAWAL_METHODS: WithdrawalMethod[] = [
  {
    id: 'USDT_TRC20',
    currency: 'USDT',
    network: 'TRON (TRC20)',
    label: 'USDT · TRON (TRC20)',
    addressPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$',
    addressHint: 'TRON addresses start with T and contain 34 characters.'
  },
  {
    id: 'USDT_ERC20',
    currency: 'USDT',
    network: 'Ethereum (ERC20)',
    label: 'USDT · Ethereum (ERC20)',
    addressPattern: '^0x[a-fA-F0-9]{40}$',
    addressHint: 'Ethereum addresses start with 0x followed by 40 hexadecimal characters.'
  },
  {
    id: 'USDT_BEP20',
    currency: 'USDT',
    network: 'BNB Smart Chain (BEP20)',
    label: 'USDT · BNB Smart Chain (BEP20)',
    addressPattern: '^0x[a-fA-F0-9]{40}$',
    addressHint: 'BNB Smart Chain addresses start with 0x followed by 40 hexadecimal characters.'
  },
  {
    id: 'BTC',
    currency: 'BTC',
    network: 'Bitcoin',
    label: 'BTC · Bitcoin',
    addressPattern: '^(bc1[a-zA-HJ-NP-Z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    addressHint: 'Bitcoin addresses start with bc1, 1 or 3.'
  },
  {
    id: 'ETH',
    currency: 'ETH',
    network: 'Ethereum',
    label: 'ETH · Ethereum',
    addressPattern: '^0x[a-fA-F0-9]{40}$',
    addressHint: 'Ethereum addresses start with 0x followed by 40 hexadecimal characters.'
  },
  {
    id: 'TRX',
    currency: 'TRX',
    network: 'TRON',
    label: 'TRX · TRON',
    addressPattern: '^T[1-9A-HJ-NP-Za-km-z]{33}$',
    addressHint: 'TRON addresses start with T and contain 34 characters.'
  },
  {
    id: 'LTC',
    currency: 'LTC',
    network: 'Litecoin',
    label: 'LTC · Litecoin',
    addressPattern: '^(ltc1[a-z0-9]{25,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$',
    addressHint: 'Litecoin addresses start with ltc1, L, M or 3.'
  }
];

const METHOD_BY_ID = new Map(WITHDRAWAL_METHODS.map((method) => [method.id, method]));

export function getWithdrawalMethod(methodId: string): WithdrawalMethod | undefined {
  return METHOD_BY_ID.get(String(methodId || '').trim().toUpperCase());
}

/**
 * Legacy requests stored a free-text network such as `USDT_TRC20` or `BTC`.
 * Resolve it to an explicitly supported payout method, otherwise reject it.
 */
export function resolveWithdrawalMethod(input: {
  methodId?: string;
  network?: string;
}): WithdrawalMethod | undefined {
  if (input.methodId) {
    return getWithdrawalMethod(input.methodId);
  }

  const network = String(input.network || '').trim().toUpperCase();
  if (!network) return undefined;

  if (METHOD_BY_ID.has(network)) return METHOD_BY_ID.get(network);

  if (network === 'USDT' || network === 'USDT-TRC20' || network === 'USDTTRC20') {
    return METHOD_BY_ID.get('USDT_TRC20');
  }
  if (network === 'USDT-ERC20' || network === 'USDTERC20') {
    return METHOD_BY_ID.get('USDT_ERC20');
  }
  if (network === 'USDT-BEP20' || network === 'USDTBEP20') {
    return METHOD_BY_ID.get('USDT_BEP20');
  }
  if (network === 'BITCOIN') return METHOD_BY_ID.get('BTC');
  if (network === 'ETHEREUM') return METHOD_BY_ID.get('ETH');
  if (network === 'TRON') return METHOD_BY_ID.get('TRX');
  if (network === 'LITECOIN') return METHOD_BY_ID.get('LTC');

  return undefined;
}

export function validateWithdrawalAddress(method: WithdrawalMethod, address: string): boolean {
  const clean = String(address || '').trim();
  if (!clean) return false;
  try {
    return new RegExp(method.addressPattern).test(clean);
  } catch {
    return false;
  }
}

export function publicWithdrawalMethods(): Array<Omit<WithdrawalMethod, never>> {
  return WITHDRAWAL_METHODS.map((method) => ({ ...method }));
}

export interface PayAmountViewModel {
  isValid: boolean;
  expired: boolean;
  status: string;
  isPaid: boolean;
  headerLabel: 'Invoice Amount' | 'Amount to Pay' | 'Payment Details';
  formattedAmount: string;
  assetCode: string;
  description: string | null;
  sellerName: string | null;
  sellerEmail: string | null;
  hasSellerInfo: boolean;
  paymentTxHash: string | null;
  expiryRemaining: string | null;
  formattedPaidAt: string | null;
  fallbackMessage?: string;
  retryable?: boolean;
  isDegraded?: boolean;
}

export function formatAmount(amount: number | string, decimals?: number): string;
export function formatDate(date: string | Date): string | null;
export function getTimeRemaining(expiresAt: string | Date, now?: Date | string | number): string | null;

export function clampDecimals(amount: number | string, min?: number, max?: number): string;
export function safeInvoiceAmount(amount: any, defaultAmount = 0): number;
export function resolvePayAmountViewModel(
  invoice: any,
  now?: Date | string | number
): PayAmountViewModel;

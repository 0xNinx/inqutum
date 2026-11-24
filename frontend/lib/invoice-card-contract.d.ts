export interface InvoiceCardToast {
  kind: 'success' | 'error';
  message: string;
  description?: string;
}

export interface InvoiceCardActionViewModel {
  status: string;
  paymentUrl: string | null;
  canCopyLink: boolean;
  canDownloadProof: boolean;
  canEmailProof: boolean;
  emailProofLabel: string;
}

export interface InvoiceCardExportResult {
  ok: boolean;
  code?: string;
  message?: string;
  retryable?: boolean;
  recoveryAction?: string;
}

export const INVOICE_CARD_COPY: {
  readonly copySuccess: string;
  readonly copyFailure: string;
  readonly proofSuccess: string;
  readonly emailSuccess: string;
  readonly noEmail: string;
  readonly emailProof: string;
  readonly unknownStatus: string;
  readonly degradedExport: string;
  readonly degradedRecovery: string;
};

export function resolvePaymentUrl(invoiceId: unknown, origin?: unknown): string | null;
export function resolveEmailRecipient(email: unknown): string | null;
export function resolveInvoiceCardViewModel(
  invoice: unknown,
  options?: { status?: string; origin?: string }
): InvoiceCardActionViewModel;
export function resolveCopyToast(success: boolean): InvoiceCardToast;
export function resolveExportToast(
  result: InvoiceCardExportResult | null | undefined,
  successMessage?: string
): InvoiceCardToast;

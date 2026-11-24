'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatAmount, formatDate, getStatusColor, getTimeRemaining } from '@/lib/utils';
import { Clock, ExternalLink, Copy, Check, Mail, Download } from 'lucide-react';
import { copyToClipboard } from '@/lib/utils';
import { toast } from 'sonner';
import AssetLogo from './AssetLogo';
import { openInvoicePDF, shareInvoiceByEmail } from '@/lib/export';
import { effectiveInvoiceStatus } from '@/lib/invoice-lifecycle';
import {
  INVOICE_CARD_COPY,
  resolveCopyToast,
  resolveExportToast,
  resolveInvoiceCardViewModel,
  type InvoiceCardToast,
} from '@/lib/invoice-card-contract';

interface Invoice {
  id: string;
  amount: number;
  assetCode: string;
  description?: string;
  customerName?: string;
  customerEmail?: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  memo: string;
  sellerPublicKey?: string;
  sellerName?: string;
  sellerEmail?: string;
  payerPublicKey?: string;
  payerName?: string;
  payerEmail?: string;
  paymentTxHash?: string;
  paidAt?: string;
}

interface InvoiceCardProps {
  invoice: Invoice;
}

export default function InvoiceCard({ invoice }: InvoiceCardProps) {
  const [linkCopied, setLinkCopied] = useState(false);
  const status = effectiveInvoiceStatus(invoice) || invoice.status;
  const statusColor = getStatusColor(status);
  const view = resolveInvoiceCardViewModel(invoice, {
    status,
    origin: typeof window === 'undefined' ? undefined : window.location.origin,
  });

  const report = (feedback: InvoiceCardToast) => {
    if (feedback.kind === 'success') {
      toast.success(feedback.message);
      return;
    }
    toast.error(feedback.message, { description: feedback.description });
  };

  const handleCopyLink = async () => {
    if (!view.paymentUrl) return;
    const feedback = resolveCopyToast(await copyToClipboard(view.paymentUrl));
    report(feedback);
    if (feedback.kind === 'success') {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  };

  const handleDownloadPDF = () =>
    report(resolveExportToast(openInvoicePDF(invoice as any), INVOICE_CARD_COPY.proofSuccess));

  const handleEmailShare = () =>
    report(resolveExportToast(shareInvoiceByEmail(invoice as any), INVOICE_CARD_COPY.emailSuccess));

  return (
    <div className="card hover:shadow-xl group">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <AssetLogo code={invoice.assetCode} size={24} showName={false} />
            <h3 className="text-lg font-bold text-gray-900">
              {formatAmount(invoice.amount)} <span className="text-cyan-600">{invoice.assetCode}</span>
            </h3>
          </div>
          {invoice.customerName && (
            <p className="text-sm text-gray-600">{invoice.customerName}</p>
          )}
        </div>
        <span className={`px-3 py-1 rounded-lg text-xs font-semibold ${statusColor}`}>
          {status}
        </span>
      </div>

      {invoice.description && (
        <p className="text-sm text-gray-600 mb-4 line-clamp-2">
          {invoice.description}
        </p>
      )}

      <div className="space-y-2 mb-4">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Clock className="w-4 h-4" />
          <span>Created: {formatDate(invoice.createdAt)}</span>
        </div>
        {status === 'PENDING' && (
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <Clock className="w-4 h-4" />
            <span>Expires: {getTimeRemaining(invoice.expiresAt)}</span>
          </div>
        )}
        {status === 'EXPIRED' && (
          <div className="flex items-center gap-2 text-xs text-red-600">
            <Clock className="w-4 h-4" />
            <span>Expired: {formatDate(invoice.expiresAt)}</span>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Link
          href={`/invoice/${invoice.id}`}
          className="btn btn-outline flex-1 flex items-center justify-center gap-2 text-sm"
        >
          <ExternalLink className="w-4 h-4" />
          View
        </Link>
        {view.canCopyLink && (
          <button
            type="button"
            onClick={handleCopyLink}
            className="btn btn-secondary flex items-center justify-center gap-2 px-3"
            aria-label={linkCopied ? 'Invoice link copied' : 'Copy invoice link'}
            title={linkCopied ? 'Invoice link copied' : 'Copy invoice link'}
          >
            {linkCopied ? (
              <Check className="w-4 h-4 text-green-700" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        )}
        {view.canDownloadProof && (
          <button
            type="button"
            onClick={handleDownloadPDF}
            className="btn btn-primary flex-1 flex items-center justify-center gap-2 text-sm focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2" aria-label="Download Payment Proof PDF" aria-haspopup="dialog"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            Download Proof
          </button>
        )}
        {status === 'PAID' && (
          <button
            type="button"
            onClick={view.canEmailProof ? handleEmailShare : undefined}
            disabled={!view.canEmailProof}
            title={view.emailProofLabel}
            aria-label={view.emailProofLabel}
            className={`btn btn-outline flex items-center justify-center gap-2 px-3 ${
              !view.canEmailProof ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            <Mail className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

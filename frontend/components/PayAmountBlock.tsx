'use client';

import AssetLogo from './AssetLogo';
import PaymentStatus from './PaymentStatus';
import type { PayPageInvoice } from './pay-page.types';
import { resolvePayAmountViewModel } from '@/lib/pay-amount-block-contract';
import { Boundary } from './Boundary';
import { RefreshCw } from 'lucide-react';

export interface PayAmountBlockProps {
  invoice?: PayPageInvoice | null | undefined;
  onRetry?: () => void;
}

export function PayAmountBlock({ invoice, onRetry }: PayAmountBlockProps) {
  const vm = resolvePayAmountViewModel(invoice);

  if (!vm.isValid) {
    return (
      <section aria-labelledby="payment-details-title" className="card text-center" data-testid="pay-amount-block-invalid">
        <h2 id="payment-details-title" className="text-3xl font-bold text-gray-900 mb-8">
          Payment Details
        </h2>
        <p className="text-gray-500 py-4 text-center">{vm.fallbackMessage || 'Invoice details are unavailable.'}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            type="button"
            className="btn btn-outline border-cyan-200 text-cyan-700 hover:bg-cyan-50 mx-auto mt-2 flex items-center justify-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
        )}
      </section>
    );
  }

  return (
    <section aria-labelledby="payment-details-title" className="card">
      <h2 id="payment-details-title" className="text-3xl font-bold text-gray-900 mb-8">
        Payment Details
      </h2>
      <div className="space-y-5">
        <div className="pay-amount-panel">
          <p className="text-sm text-gray-600 mb-4 font-semibold uppercase tracking-wide">
            {vm.headerLabel}
          </p>
          <div className="flex items-center justify-center gap-4">
            <AssetLogo code={vm.assetCode} size={50} showName={false} />
            <div>
              <p className="text-5xl sm:text-6xl font-bold text-cyan-700">{vm.formattedAmount}</p>
              <p className="text-xl font-bold text-cyan-600 mt-2">{vm.assetCode}</p>
            </div>
          </div>
        </div>
        {vm.description && (
          <p className="pay-detail-panel">
            <span>Payment for</span>
            {vm.description}
          </p>
        )}
        {vm.hasSellerInfo && (
          <div className="pay-detail-panel">
            <span>Seller</span>
            {vm.sellerName && <p>{vm.sellerName}</p>}
            {vm.sellerEmail && <p>{vm.sellerEmail}</p>}
          </div>
        )}
        <PaymentStatus
          status={vm.status as any}
          txHash={vm.paymentTxHash ?? undefined}
          compact
        />
        {vm.expiryRemaining && (
          <p className="pay-detail-panel">
            <span>Expires in</span>
            {vm.expiryRemaining}
          </p>
        )}
        {vm.isPaid && vm.formattedPaidAt && (
          <p className="pay-detail-panel">
            <span>Payment completed</span>
            {vm.formattedPaidAt}
          </p>
        )}
      </div>
    </section>
  );
}

export default function BoundaryWrappedPayAmountBlock(props: PayAmountBlockProps) {
  return (
    <Boundary name="PayAmountBlock" fallbackMessage="Payment details unavailable" onRetry={props.onRetry}>
      <PayAmountBlock {...props} />
    </Boundary>
  );
}

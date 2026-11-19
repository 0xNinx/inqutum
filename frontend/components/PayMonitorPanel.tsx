'use client';

import { Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { resolvePayMonitorViewModel, type PayMonitorPanelProps } from '@/lib/pay-monitor-panel-contract';
import { Boundary } from './Boundary';

export function PayMonitorPanel({
  active,
  intervalMs,
  status,
  error,
  onRetry,
}: PayMonitorPanelProps) {
  const vm = resolvePayMonitorViewModel({ active, intervalMs, status, error });

  return (
    <aside
      aria-live="polite"
      className="card flex items-center justify-between gap-3"
      data-monitor-state={vm.status}
    >
      <div className="flex items-center gap-3">
        {vm.active && <Loader2 className="w-4 h-4 animate-spin text-cyan-600" aria-hidden="true" />}
        {vm.isDegraded && <Loader2 className="w-4 h-4 animate-spin text-amber-500" aria-hidden="true" />}
        {vm.hasError && <AlertCircle className="w-4 h-4 text-red-500" aria-hidden="true" />}
        <div>
          <p className="font-semibold text-gray-900">{vm.title}</p>
          <p className="text-sm text-gray-600">
            {vm.description}
            {vm.intervalText && ` ${vm.intervalText}`}
          </p>
        </div>
      </div>
      {onRetry && (vm.isDegraded || vm.hasError) && (
        <button
          onClick={onRetry}
          type="button"
          className="btn btn-outline border-gray-200 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 text-xs px-2.5 py-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reconnect
        </button>
      )}
    </aside>
  );
}

export default function BoundaryWrappedPayMonitorPanel(props: PayMonitorPanelProps) {
  return (
    <Boundary name="PayMonitorPanel" fallbackMessage="Payment monitor unavailable" onRetry={props.onRetry}>
      <PayMonitorPanel {...props} />
    </Boundary>
  );
}

'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useReducer } from 'react';

import {
  API_ERROR_STATE_COPY,
  nextApiErrorRetryState,
  resolveApiErrorViewModel,
} from '@/lib/api-error-state-contract';
import type { ClientRejectionExplanation } from '@/lib/rejection-explanation';

interface ApiErrorStateProps {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
  error?: unknown;
  explanation?: Partial<ClientRejectionExplanation>;
}

export default function ApiErrorState({
  message,
  onRetry,
  compact = false,
  error,
  explanation,
}: ApiErrorStateProps) {
  const [retryState, dispatchRetry] = useReducer(nextApiErrorRetryState, { retrying: false });
  const retrying = retryState.retrying;
  const view = resolveApiErrorViewModel({ message, error, explanation });

  const handleRetry = () => {
    if (!onRetry || retrying) return;

    dispatchRetry({ type: 'RETRY_STARTED' });
    try {
      Promise.resolve(onRetry())
        .catch(() => undefined)
        .finally(() => dispatchRetry({ type: 'RETRY_SETTLED' }));
    } catch {
      dispatchRetry({ type: 'RETRY_SETTLED' });
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`border border-red-200 bg-red-50 text-red-950 rounded-2xl ${compact ? 'p-4' : 'card py-10 text-center'}`}
    >
      <AlertTriangle className={`${compact ? 'w-5 h-5 inline mr-2' : 'w-12 h-12 mx-auto mb-4'} text-red-600`} />
      <p className="font-semibold">{view.title}</p>
      <p className="text-sm text-red-800 mt-1">{view.summary}</p>
      {view.reasonCode && (
        <p className="text-xs font-mono text-red-700 mt-2" data-testid="rejection-reason-code">
          Code: {view.reasonCode}
        </p>
      )}
      {view.recoveryHints.length > 0 && (
        <ul className="text-xs text-red-900 mt-2 space-y-1" data-testid="rejection-recovery-hints">
          {view.recoveryHints.map((hint) => (
            <li key={hint.step}>{hint.action}</li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button type="button" onClick={handleRetry} disabled={retrying} className="btn btn-outline mt-4 inline-flex items-center gap-2">
          <RefreshCw className={`w-4 h-4 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? API_ERROR_STATE_COPY.retrying : API_ERROR_STATE_COPY.retry}
        </button>
      )}
    </div>
  );
}

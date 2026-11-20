'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, ServerOff, X } from 'lucide-react';
import { API_CONFIG, apiErrorMessage, getPublicStatus, healthCheck } from '@/lib/api';
import { publicStatusBanner, type PublicStatusBanner } from '@/lib/public-status';

const STATUS_TONE_CLASSES: Record<PublicStatusBanner['tone'], string> = {
  critical: 'bg-amber-950 text-white',
  warning: 'bg-amber-100 text-amber-950',
  info: 'bg-slate-900 text-white',
};

export default function ApiStatusBanner() {
  const [error, setError] = useState<string | null>(API_CONFIG.error);
  const [checking, setChecking] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<PublicStatusBanner | null>(null);
  const [statusDismissed, setStatusDismissed] = useState(false);
  const lastStatusState = useRef<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await healthCheck();
      setError(null);
      // Status is best effort: an older backend without /status shows no banner.
      try {
        const next = publicStatusBanner(await getPublicStatus());
        setServiceStatus(next);
        // A new state re-shows a banner the user dismissed for the previous one.
        if ((next?.state ?? null) !== lastStatusState.current) {
          lastStatusState.current = next?.state ?? null;
          setStatusDismissed(false);
        }
      } catch {
        setServiceStatus(null);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    const offline = () => setError('Your browser is offline. Reconnect, then retry.');
    const online = () => void check();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [check]);

  if (!error) {
    if (!serviceStatus || statusDismissed) return null;
    return (
      <aside
        role={serviceStatus.role}
        aria-live={serviceStatus.role === 'alert' ? 'assertive' : 'polite'}
        className={`fixed bottom-4 left-4 right-4 sm:left-auto sm:max-w-lg z-[100] rounded-2xl shadow-2xl p-4 ${STATUS_TONE_CLASSES[serviceStatus.tone]}`}
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-semibold">{serviceStatus.title}</p>
            {serviceStatus.message && <p className="text-sm mt-1 opacity-90">{serviceStatus.message}</p>}
            {serviceStatus.unavailable.length > 0 && (
              <p className="text-sm mt-2">Unavailable right now: {serviceStatus.unavailable.join(', ')}.</p>
            )}
            {serviceStatus.limited.length > 0 && (
              <p className="text-sm mt-1">Limited: {serviceStatus.limited.join(', ')}.</p>
            )}
            {serviceStatus.expectedResolutionAt && (
              <p className="text-sm mt-1">
                Expected back by {new Date(serviceStatus.expectedResolutionAt).toLocaleString()}.
              </p>
            )}
            <button
              type="button"
              onClick={() => void check()}
              disabled={checking}
              className="mt-3 text-sm underline underline-offset-4 inline-flex items-center gap-2 disabled:opacity-60"
            >
              <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
              {checking ? 'Checking…' : 'Check status again'}
            </button>
          </div>
          <button type="button" onClick={() => setStatusDismissed(true)} aria-label="Dismiss service status">
            <X className="w-4 h-4" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      role="alert"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:max-w-lg z-[100] bg-red-950 text-white rounded-2xl shadow-2xl p-4"
    >
      <div className="flex items-start gap-3">
        <ServerOff className="w-5 h-5 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">Backend connection problem</p>
          <p className="text-sm text-red-100 mt-1">{error}</p>
          <button
            type="button"
            onClick={() => void check()}
            disabled={checking}
            className="mt-3 text-sm underline underline-offset-4 inline-flex items-center gap-2 disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'Checking…' : 'Retry connection'}
          </button>
        </div>
        <button type="button" onClick={() => setError(null)} aria-label="Dismiss backend warning">
          <X className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}

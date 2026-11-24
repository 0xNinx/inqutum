'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, ServerOff, X } from 'lucide-react';
import { API_CONFIG, apiErrorMessage, getPublicStatus, healthCheck } from '@/lib/api';
import {
  API_STATUS_BANNER_COPY,
  resolveApiStatusViewModel,
  resolveStatusBanner,
} from '@/lib/api-status-banner-contract';
import { initialApiStatusAnnouncement, nextApiStatusAnnouncement } from '@/lib/api-status-announcement';
import type { PublicStatusBanner } from '@/lib/public-status';

const STATUS_TONE_CLASSES: Record<PublicStatusBanner['tone'], string> = {
  critical: 'bg-amber-950 text-white',
  warning: 'bg-amber-100 text-amber-950',
  info: 'bg-slate-900 text-white',
};

export default function ApiStatusBanner() {
  const [error, setError] = useState<string | null>(API_CONFIG.error);
  const [checking, setChecking] = useState(false);
  const [statusPayload, setStatusPayload] = useState<unknown>(null);
  const [statusDismissed, setStatusDismissed] = useState(false);
  const lastStatusState = useRef<string | null>(null);
  // A ref, not state: a second press during a check is ignored before React re-renders.
  const inFlight = useRef(false);
  // Persistent polite region, mounted in every branch below, so the outcome of a
  // check is spoken even though the banner itself unmounts when the check succeeds.
  const [announcement, announce] = useReducer(
    nextApiStatusAnnouncement,
    API_CONFIG.error,
    initialApiStatusAnnouncement
  );

  const check = useCallback(async (manual = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    announce({ type: 'CHECK_STARTED', manual });
    try {
      await healthCheck();
      setError(null);
      announce({ type: 'CHECK_SUCCEEDED', manual });
      // Status is best effort: an older backend without /status shows no banner.
      try {
        const payload: unknown = await getPublicStatus();
        setStatusPayload(payload);
        // A new state re-shows a banner the user dismissed for the previous one.
        const nextState = resolveStatusBanner(payload)?.state ?? null;
        if (nextState !== lastStatusState.current) {
          lastStatusState.current = nextState;
          setStatusDismissed(false);
        }
      } catch {
        setStatusPayload(null);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause));
      announce({ type: 'CHECK_FAILED', manual });
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    const offline = () => {
      setError(API_STATUS_BANNER_COPY.offline);
      announce({ type: 'CHECK_FAILED', manual: false });
    };
    const online = () => void check();
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [check]);

  const region = (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement.polite}
    </div>
  );
  const banner = resolveApiStatusViewModel({ error, statusPayload });

  if (!banner.hasError) {
    const serviceStatus = banner.status;
    if (!serviceStatus || statusDismissed) return region;
    return (
      <>
        {region}
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
              {/* aria-disabled, not disabled: a disabled button drops focus in some browsers. */}
              <button
                type="button"
                onClick={() => void check(true)}
                aria-disabled={checking}
                className="mt-3 text-sm underline underline-offset-4 inline-flex items-center gap-2 aria-disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
                {checking ? API_STATUS_BANNER_COPY.checking : API_STATUS_BANNER_COPY.checkStatus}
              </button>
            </div>
            <button type="button" onClick={() => setStatusDismissed(true)} aria-label="Dismiss service status">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      {region}
      <aside
        role="alert"
        className="fixed bottom-4 left-4 right-4 sm:left-auto sm:max-w-lg z-[100] bg-red-950 text-white rounded-2xl shadow-2xl p-4"
      >
        <div className="flex items-start gap-3">
          <ServerOff className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-semibold">{API_STATUS_BANNER_COPY.connectionTitle}</p>
            <p className="text-sm text-red-100 mt-1">{banner.message}</p>
            <button
              type="button"
              onClick={() => void check(true)}
              aria-disabled={checking}
              className="mt-3 text-sm underline underline-offset-4 inline-flex items-center gap-2 aria-disabled:opacity-60"
            >
                  <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {checking ? API_STATUS_BANNER_COPY.checking : API_STATUS_BANNER_COPY.retry}
            </button>
          </div>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss backend warning">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </>
  );
}

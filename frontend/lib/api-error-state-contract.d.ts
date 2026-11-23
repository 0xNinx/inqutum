import type { ClientRejectionExplanation } from './rejection-explanation';

export interface ApiErrorRecoveryHint {
  step: number;
  action: string;
}

export interface ApiErrorStateViewModel {
  title: string;
  summary: string;
  reasonCode: string | null;
  recoveryHints: ApiErrorRecoveryHint[];
}

export interface ApiErrorRetryState {
  retrying: boolean;
}

export type ApiErrorRetryEvent =
  | { type: 'RETRY_STARTED' }
  | { type: 'RETRY_SETTLED' };

export const API_ERROR_STATE_COPY: {
  readonly title: string;
  readonly summary: string;
  readonly retry: string;
  readonly retrying: string;
};

export function resolveApiErrorViewModel(input: {
  message?: string;
  error?: unknown;
  explanation?: Partial<ClientRejectionExplanation>;
}): ApiErrorStateViewModel;

export function nextApiErrorRetryState(
  previous: ApiErrorRetryState,
  event: ApiErrorRetryEvent | null | undefined
): ApiErrorRetryState;

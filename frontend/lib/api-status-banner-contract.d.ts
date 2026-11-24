import type { PublicStatusBanner } from './public-status';

export interface ApiStatusBannerCopy {
  readonly connectionTitle: string;
  readonly connectionFallback: string;
  readonly offline: string;
  readonly retry: string;
  readonly checking: string;
  readonly checkStatus: string;
}

export interface ApiStatusBannerViewModel {
  hasError: boolean;
  message: string | null;
  status: PublicStatusBanner | null;
}

export const API_STATUS_BANNER_COPY: ApiStatusBannerCopy;

export function resolveConnectionMessage(raw: unknown): string;
export function resolveStatusBanner(payload: unknown): PublicStatusBanner | null;
export function resolveApiStatusViewModel(input: {
  error?: string | null;
  statusPayload?: unknown;
}): ApiStatusBannerViewModel;

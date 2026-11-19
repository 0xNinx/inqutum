export type PublicStatusState = 'operational' | 'degraded' | 'paused' | 'maintenance';
export type CapabilityAvailability = 'available' | 'limited' | 'unavailable';
export type StatusCapability =
  | 'invoice_creation'
  | 'invoice_viewing'
  | 'invoice_cancellation'
  | 'payment_verification'
  | 'exports'
  | 'email_notifications';

export interface PublicStatus {
  state: PublicStatusState;
  title: string;
  message: string;
  since: string | null;
  expectedResolutionAt: string | null;
  retryAfterSeconds: number;
  capabilities: Partial<Record<StatusCapability, CapabilityAvailability>>;
}

export interface PublicStatusBanner {
  state: Exclude<PublicStatusState, 'operational'>;
  tone: 'warning' | 'critical' | 'info';
  role: 'status' | 'alert';
  title: string;
  message: string;
  unavailable: string[];
  limited: string[];
  expectedResolutionAt: string | null;
  retryAfterSeconds: number;
}

export declare const CAPABILITY_LABELS: Readonly<Record<StatusCapability, string>>;
export declare const PUBLIC_STATES: readonly PublicStatusState[];
export function normalizePublicStatus(payload: unknown): PublicStatus | null;
export function publicStatusBanner(payload: unknown): PublicStatusBanner | null;
export function isCapabilityAvailable(payload: unknown, capability: StatusCapability): boolean;

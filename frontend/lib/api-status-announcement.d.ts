export type ApiStatusEvent =
  | { type: 'CHECK_STARTED'; manual: boolean }
  | { type: 'CHECK_SUCCEEDED'; manual: boolean }
  | { type: 'CHECK_FAILED'; manual: boolean };

export interface ApiStatusAnnouncement {
  status: 'unknown' | 'up' | 'down';
  polite: string;
  failures: number;
}

export declare const API_STATUS_COPY: {
  readonly checking: string;
  readonly restored: string;
  readonly available: string;
  readonly stillDown: (attempt: number) => string;
};

export declare function initialApiStatusAnnouncement(configError: string | null | undefined): ApiStatusAnnouncement;

export declare function nextApiStatusAnnouncement(
  prev: ApiStatusAnnouncement | undefined,
  event: ApiStatusEvent
): ApiStatusAnnouncement;

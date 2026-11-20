import { Response } from 'express';
import type { VerificationCode } from '../services/payment-verification';
import {
  ErrorCategory,
  DOMAIN_ERROR_TAXONOMY,
  classifyError,
} from '../errors/error-taxonomy';
import { redactErrorMessage } from '../security/redaction';
import {
  PROBLEM_CONTENT_TYPE,
  toProblemDetails,
  sendProblemDetails,
  problemTypeUri,
  type ProblemDetails,
} from '../errors/problem-details';

export {
  PROBLEM_CONTENT_TYPE,
  toProblemDetails,
  sendProblemDetails,
  problemTypeUri,
  type ProblemDetails,
};

// Shared response envelope used by both the MVP and the Postgres server.
// Both servers send the same success/failure shape so clients stay
// storage-agnostic: a frontend pointed at server-mvp.ts behaves exactly the
// same against server.ts (only persistence duration changes).
// sendSuccess / sendFailure wrap this envelope; they are shared helpers, so
// HTTP status codes and envelope keys are also pinned across backends.
export interface ApiPagination {
  limit: number;
  offset: number;
  total: number;
  /** Keyset cursor for the next page; null when this is the last page. */
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  message?: string;
  pagination?: ApiPagination;
  correlationId?: string;
  /** Schema version of the data payload, when applicable. */
  apiVersion?: string;
}

export interface ApiFailure {
  success: false;
  error: string;
  code?: VerificationCode | string;
  category?: ErrorCategory;
  retryable?: boolean;
  recoveryAction?: string;
  /** Ordered remediation steps for the code (issue #303); see docs/ERRORS.md. */
  remediation?: string[];
  correlationId?: string;
  timestamp?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function apiSuccess<T>(
  data: T,
  extra?: { message?: string; pagination?: ApiPagination; correlationId?: string; apiVersion?: string }
): ApiSuccess<T> {
  const body: ApiSuccess<T> = { success: true, data };

  if (extra?.message) {
    body.message = extra.message;
  }
  if (extra?.pagination) {
    body.pagination = extra.pagination;
  }
  if (extra?.correlationId) {
    body.correlationId = extra.correlationId;
  }
  if (extra?.apiVersion) {
    body.apiVersion = extra.apiVersion;
  }

  return body;
}

export function apiFailure(
  error: string,
  extra?: {
    code?: string;
    category?: ErrorCategory;
    retryable?: boolean;
    recoveryAction?: string;
    correlationId?: string;
  }
): ApiFailure {
  const code = extra?.code;
  const taxonomy = code ? DOMAIN_ERROR_TAXONOMY[code] : undefined;

  return {
    success: false,
    error: redactErrorMessage(error),
    ...(code ? { code: code as VerificationCode } : {}),
    category: extra?.category || taxonomy?.category,
    retryable: extra?.retryable !== undefined ? extra.retryable : taxonomy?.retryable,
    recoveryAction: extra?.recoveryAction || taxonomy?.recoveryAction,
    ...(taxonomy?.remediation?.length ? { remediation: taxonomy.remediation } : {}),
    ...(extra?.correlationId ? { correlationId: extra.correlationId } : {}),
    timestamp: new Date().toISOString(),
  };
}

export function sendSuccess<T>(
  res: Response,
  status: number,
  data: T,
  extra?: { message?: string; pagination?: ApiPagination; correlationId?: string; apiVersion?: string }
): void {
  const corrId = extra?.correlationId || (res.req as any)?.correlationId;
  res.status(status).json(apiSuccess(data, { ...extra, correlationId: corrId }));
}

export function sendFailure(
  res: Response,
  status: number,
  error: string | any,
  extra?: {
    code?: string;
    category?: ErrorCategory;
    retryable?: boolean;
    recoveryAction?: string;
    correlationId?: string;
  }
): void {
  const corrId = extra?.correlationId || (res.req as any)?.correlationId;

  if (typeof error === 'object' && error !== null) {
    const classified = classifyError(error);
    const message =
      classified.customMessage ||
      (typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : classified.userSafeMessage);

    const body = apiFailure(message, {
      code: classified.code,
      category: classified.category,
      retryable: classified.retryable,
      recoveryAction: classified.recoveryAction,
      correlationId: corrId,
    });
    // RFC 7807: failures use application/problem+json
    sendProblemDetails(res, status || classified.httpStatus, body);
    return;
  }

  const body = apiFailure(error, { ...extra, correlationId: corrId });
  sendProblemDetails(res, status, body);
}

export function sendVerificationFailure(
  res: Response,
  status: number,
  code: VerificationCode,
  error: string,
  correlationId?: string
): void {
  const corrId = correlationId || (res.req as any)?.correlationId;
  const taxonomy = DOMAIN_ERROR_TAXONOMY[code];

  const body = {
    success: false as const,
    code,
    error: redactErrorMessage(error),
    ...(taxonomy
      ? {
          category: taxonomy.category,
          retryable: taxonomy.retryable,
          recoveryAction: taxonomy.recoveryAction,
          ...(taxonomy.remediation?.length ? { remediation: taxonomy.remediation } : {}),
        }
      : {}),
    ...(corrId ? { correlationId: corrId } : {}),
    timestamp: new Date().toISOString(),
  };

  // RFC 7807: set application/problem+json and include full ProblemDetails fields
  sendProblemDetails(res, status, body);
}

export default {
  apiSuccess,
  apiFailure,
  sendSuccess,
  sendFailure,
  sendVerificationFailure,
};

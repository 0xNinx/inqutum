import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { stellarPublicKeySchema } from '../utils/validation';
import { apiFailure, sendFailure, sendSuccess } from '../types/api';
import type { InvoiceStorage } from '../storage/invoice-storage';
import {
  ExportCancelledError,
  ExportFieldError,
  ExportFieldForbiddenError,
  ExportForbiddenError,
  ExportIdempotencyConflictError,
  ExportService,
  MAX_SELECTED_FIELDS,
  OWNER_ACCESS,
} from '../exports/export-service';
import { PublicStatusService, publicStatusService } from '../ops/public-status';

export interface ExportRouterOptions {
  storage: InvoiceStorage;
  service?: ExportService;
  /** Server-side deadline for generating one export (#288). Defaults to 30 s. */
  timeoutMs?: number;
  /** Maintenance gate (#254). Defaults to the process status. */
  publicStatus?: PublicStatusService;
}

export const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;

/** Header that carries the requester on GET /exports/:id (#444). Lower-case, as Node exposes it. */
export const REQUESTER_HEADER = 'x-requester' as const;

const requestSchema = z.object({
  requester: stellarPublicKeySchema,
  /** Optional explicit scope. Must equal `requester`; anything else is denied. */
  sellerPublicKey: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
  status: z.enum(['PENDING', 'PAID', 'EXPIRED', 'CANCELLED']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Field selection (#308). Omit for the default v1 field set. */
  fields: z.array(z.string().max(64)).min(1).max(MAX_SELECTED_FIELDS).optional(),
  /** Same as the Idempotency-Key header; the header wins when both are sent. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/**
 * Data export routes. Mount under `/api`.
 *
 *   POST /exports                 { requester, format?, status?, from?, to?, fields? }
 *                                 optional Idempotency-Key header
 *   GET  /exports/:id?requester=  download while the artifact is retained
 */
export function createExportRouter(options: ExportRouterOptions): Router {
  const service = options.service ?? new ExportService(options.storage);
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive safe integer');
  const router = Router();

  const status = options.publicStatus ?? publicStatusService;

  router.post('/exports', status.requireCapability('exports'), async (req: Request, res: Response) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendFailure(res, 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), {
        code: 'INVALID_EXPORT_REQUEST',
        correlationId: req.correlationId,
      });
    }
    const { requester, sellerPublicKey, format, status, from, to, fields } = parsed.data;
    const header = req.headers?.['idempotency-key'];
    if (header !== undefined && (typeof header !== 'string' || header.length === 0 || header.length > 200)) {
      return sendFailure(res, 400, 'Idempotency-Key must be 1-200 characters', {
        code: 'INVALID_EXPORT_REQUEST',
        correlationId: req.correlationId,
      });
    }
    const idempotencyKey = (header as string | undefined) ?? parsed.data.idempotencyKey;

    // Cancellation (#288): a client that disconnects, or a run past the
    // deadline, stops generation at the next storage page. `res` (not `req`)
    // emits 'close' when the socket goes away before the response is written.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);

    try {
      const artifact = await service.create(
        requester,
        { format, status, from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined, fields, idempotencyKey },
        sellerPublicKey ?? requester,
        controller.signal,
        // The requester is caller-asserted, so the public route never grants more than owner access.
        OWNER_ACCESS
      );

      if (options.storage.recordAuditEvent) {
        await options.storage
          .recordAuditEvent({
            action: 'PROOF_EXPORTED',
            actor: { type: 'seller', id: requester, ip: req.ip },
            scope: { entityType: 'system', entityId: artifact.meta.exportId },
            reason: 'Invoice data export generated',
            metadata: {
              schemaVersion: artifact.meta.schemaVersion,
              recordCount: artifact.meta.recordCount,
              format,
              ...(fields ? { fields: artifact.meta.fields } : {}),
            },
            correlationId: req.correlationId,
          })
          .catch((err) => console.error('Audit log error on export:', err?.message ?? err));
      }

      sendSuccess(res, 201, {
        ...artifact.meta,
        format,
        // downloadPath keeps the legacy query form for existing clients.
        downloadPath: `/api/exports/${artifact.meta.exportId}?requester=${requester}`,
        // Preferred form (#444): fetch downloadPath without the query and send this header.
        downloadPathNoQuery: `/api/exports/${artifact.meta.exportId}`,
        downloadHeaders: { 'X-Requester': requester },
      });
    } catch (error) {
      if (error instanceof ExportForbiddenError) {
        return sendFailure(res, 403, error.message, { code: 'EXPORT_FORBIDDEN', correlationId: req.correlationId });
      }
      if (error instanceof ExportFieldForbiddenError) {
        return res.status(403).json({
          ...apiFailure(error.message, { code: 'EXPORT_FIELD_FORBIDDEN', correlationId: req.correlationId }),
          deniedFields: error.denied,
        });
      }
      if (error instanceof ExportFieldError) {
        return sendFailure(res, 400, error.message, { code: 'INVALID_EXPORT_FIELDS', correlationId: req.correlationId });
      }
      if (error instanceof ExportIdempotencyConflictError) {
        return sendFailure(res, 409, error.message, { code: 'EXPORT_IDEMPOTENCY_CONFLICT', correlationId: req.correlationId });
      }
      if (error instanceof ExportCancelledError) {
        // Nothing was stored. A disconnected client has nobody to answer.
        if (res.destroyed) return;
        return sendFailure(res, 503, 'Export took too long and was cancelled. Narrow the filters and try again.', {
          code: 'EXPORT_TIMED_OUT',
          retryable: true,
          correlationId: req.correlationId,
        });
      }
      console.error('Export error:', (error as Error)?.stack ?? error);
      sendFailure(res, 500, 'Failed to generate export', { code: 'EXPORT_FAILED', correlationId: req.correlationId });
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
    }
  });

  router.get('/exports/:id', (req: Request, res: Response) => {
    // Preferred: `X-Requester` header, so the wallet key stays out of URLs,
    // proxy logs and browser history (#444). `?requester=` is still accepted
    // for existing clients. Sending both with different values is refused.
    const headerValue = req.headers[REQUESTER_HEADER];
    const queryValue = req.query.requester;
    if (headerValue !== undefined && typeof headerValue !== 'string') {
      return sendFailure(res, 400, `${REQUESTER_HEADER} must be a single valid Stellar public key`, {
        code: 'REQUESTER_REQUIRED',
        correlationId: req.correlationId,
      });
    }
    if (headerValue !== undefined && queryValue !== undefined && headerValue !== queryValue) {
      return sendFailure(res, 400, 'requester in the header and the query string differ', {
        code: 'REQUESTER_MISMATCH',
        correlationId: req.correlationId,
      });
    }

    const requester = stellarPublicKeySchema.safeParse(headerValue ?? queryValue);
    if (!requester.success) {
      return sendFailure(res, 400, `requester must be a valid Stellar public key (send it in the ${REQUESTER_HEADER} header)`, {
        code: 'REQUESTER_REQUIRED',
        correlationId: req.correlationId,
      });
    }

    const found = service.get(requester.data, req.params.id);
    if (found.state === 'expired') {
      return sendFailure(res, 410, 'This export has expired and was deleted. Generate a new one.', {
        code: 'EXPORT_EXPIRED',
        correlationId: req.correlationId,
      });
    }
    if (found.state === 'not_found') {
      return sendFailure(res, 404, 'Export not found', { code: 'EXPORT_NOT_FOUND', correlationId: req.correlationId });
    }

    const { artifact } = found;
    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="quittance-invoices-v${artifact.meta.schemaVersion}.${artifact.format}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(artifact.body);
  });

  return router;
}

export default createExportRouter;

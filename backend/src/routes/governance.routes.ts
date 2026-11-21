import type { RequestHandler, Router } from 'express';
import { apiFailure } from '../types/api';
import type { CapabilityTokenService } from '../security/capability-tokens';
import { CapabilityError } from '../security/capability-tokens';
import { EventLedger, LedgerCapacityError, LedgerIntegrityError } from '../audit/event-ledger';
import { FeatureRolloutController, RolloutError } from '../config/feature-rollout';

export interface GovernanceRouteOptions {
  admin: RequestHandler;
  needCapabilities: RequestHandler;
  capabilities: CapabilityTokenService | null;
  ledger: EventLedger;
  rollout: FeatureRolloutController;
}

const sequenceParam = (value: unknown): number | undefined | null => {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * Event ledger (#250) and feature rollout (#309) routes, registered on the ops
 * router (mounted under `/api`, admin token required on every route).
 *
 *   GET    /ops/ledger                         status: head, anchor, compromised, deferred
 *   GET    /ops/ledger/verify                  verify the chain (409 when broken)
 *   GET    /ops/ledger/export?format=&fromSequence=&toSequence=
 *   POST   /ops/ledger/prune   { throughSequence, confirmHash }
 *   POST   /ops/ledger/reseal  { actorId, reason }
 *
 *   GET    /ops/rollouts
 *   PUT    /ops/rollouts/:flag                    { percentage, expectedVersion, reason, requestId? } + X-Capability-Token
 *   POST   /ops/rollouts/:flag/emergency-disable  { actorId, reason }   (no capability: never delayed)
 *   DELETE /ops/rollouts/:flag/kill-switch        { expectedVersion, reason, requestId? } + X-Capability-Token
 *   POST   /ops/rollouts/evidence/flush
 */
export function registerGovernanceRoutes(router: Router, options: GovernanceRouteOptions): void {
  const { admin, needCapabilities, ledger, rollout } = options;

  const fail = (req: any, res: any, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    res.status(status).json({ ...apiFailure(message, { code, correlationId: req.correlationId }), ...extra });

  const handle = (req: any, res: any, next: any, err: unknown) => {
    if (err instanceof RolloutError || err instanceof CapabilityError) return fail(req, res, err.httpStatus, err.code, err.message);
    if (err instanceof LedgerIntegrityError) return fail(req, res, err.httpStatus, err.code, err.message, { data: err.verification });
    if (err instanceof LedgerCapacityError) return fail(req, res, err.httpStatus, err.code, err.message);
    return next(err);
  };

  // -- Tamper-evident ledger (#250) ------------------------------------------

  router.get('/ops/ledger', admin, (req, res) => {
    res.json({ success: true, data: ledger.status(), correlationId: req.correlationId });
  });

  router.get('/ops/ledger/verify', admin, (req, res) => {
    const result = ledger.verify();
    if (!result.valid) return fail(req, res, 409, 'LEDGER_COMPROMISED', 'Ledger failed verification; appends are refused until it is resealed', { data: result });
    res.json({ success: true, data: result, correlationId: req.correlationId });
  });

  router.get('/ops/ledger/export', admin, (req, res) => {
    const format = req.query.format ?? 'json';
    const fromSequence = sequenceParam(req.query.fromSequence);
    const toSequence = sequenceParam(req.query.toSequence);
    if ((format !== 'json' && format !== 'ndjson') || fromSequence === null || toSequence === null) {
      return fail(req, res, 400, 'INVALID_LEDGER_EXPORT', 'format must be json or ndjson; sequences must be non-negative integers');
    }
    const range = { fromSequence, toSequence };
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (format === 'ndjson') {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      return res.status(200).send(ledger.exportNdjson(range));
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(ledger.export(range)));
  });

  // Pruning demands the hash of the last entry being dropped, which only an
  // operator holding the export of that range knows: nothing is pruned unarchived.
  router.post('/ops/ledger/prune', admin, (req, res, next) => {
    try {
      const through = sequenceParam(req.body?.throughSequence);
      if (through === null || through === undefined) {
        return fail(req, res, 400, 'INVALID_LEDGER_PRUNE', 'throughSequence must be a non-negative integer');
      }
      const target = ledger.export({ fromSequence: through, toSequence: through }).entries[0];
      if (!target || target.hash !== req.body?.confirmHash) {
        return fail(req, res, 409, 'LEDGER_PRUNE_UNCONFIRMED', 'confirmHash must equal the hash of the entry at throughSequence (export it first)');
      }
      const pruned = ledger.prune(through);
      const drained = ledger.drainDeferred();
      res.json({ success: true, data: { ...pruned, drained }, correlationId: req.correlationId });
    } catch (err) {
      handle(req, res, next, err);
    }
  });

  router.post('/ops/ledger/reseal', admin, (req, res, next) => {
    try {
      if (!ledger.status().compromised) return fail(req, res, 409, 'LEDGER_NOT_COMPROMISED', 'Ledger verifies; nothing to reseal');
      const actorId = typeof req.body?.actorId === 'string' ? req.body.actorId.trim() : '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      if (!actorId || reason.trim().length < 10) {
        return fail(req, res, 400, 'INVALID_LEDGER_RESEAL', 'actorId and a reason of at least 10 characters are required');
      }
      const entry = ledger.reseal({ actorId, reason });
      const drained = ledger.drainDeferred();
      res.json({ success: true, data: { entry, drained, status: ledger.status() }, correlationId: req.correlationId });
    } catch (err) {
      handle(req, res, next, err);
    }
  });

  // -- Feature rollout guardrails (#309) -------------------------------------

  router.get('/ops/rollouts', admin, (req, res) => {
    res.json({ success: true, data: rollout.snapshot(), correlationId: req.correlationId });
  });

  router.put('/ops/rollouts/:flag', admin, needCapabilities, async (req, res, next) => {
    try {
      const result = await options.capabilities!.use(
        req.header('x-capability-token'),
        { action: 'config.feature_flag.rollout', target: req.params.flag },
        (claims) =>
          rollout.advance({
            flag: req.params.flag,
            percentage: req.body?.percentage,
            expectedVersion: req.body?.expectedVersion,
            reason: req.body?.reason,
            requestId: req.body?.requestId,
            actor: { id: claims.subject, role: 'maintainer', capabilityId: claims.id, ip: req.ip, userAgent: req.get('user-agent') },
            correlationId: req.correlationId,
          })
      );
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      handle(req, res, next, err);
    }
  });

  router.post('/ops/rollouts/:flag/emergency-disable', admin, (req, res, next) => {
    try {
      const result = rollout.emergencyDisable({
        flag: req.params.flag,
        reason: req.body?.reason,
        actor: { id: typeof req.body?.actorId === 'string' ? req.body.actorId : '', role: 'operator', ip: req.ip, userAgent: req.get('user-agent') },
        correlationId: req.correlationId,
      });
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      handle(req, res, next, err);
    }
  });

  router.delete('/ops/rollouts/:flag/kill-switch', admin, needCapabilities, async (req, res, next) => {
    try {
      const result = await options.capabilities!.use(
        req.header('x-capability-token'),
        { action: 'config.feature_flag.rollout', target: req.params.flag },
        (claims) =>
          rollout.clearKillSwitch({
            flag: req.params.flag,
            expectedVersion: req.body?.expectedVersion,
            reason: req.body?.reason,
            requestId: req.body?.requestId,
            actor: { id: claims.subject, role: 'maintainer', capabilityId: claims.id, ip: req.ip, userAgent: req.get('user-agent') },
            correlationId: req.correlationId,
          })
      );
      res.json({ success: true, data: result, correlationId: req.correlationId });
    } catch (err) {
      handle(req, res, next, err);
    }
  });

  router.post('/ops/rollouts/evidence/flush', admin, (req, res) => {
    const result = rollout.flushPendingEvidence();
    res.status(result.remaining > 0 ? 503 : 200).json({ success: result.remaining === 0, data: result, correlationId: req.correlationId });
  });
}

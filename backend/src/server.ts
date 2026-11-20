import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import routes from './routes';
import { pool } from './config/database';
import { validateStellarConfig, SELLER_PUBLIC_KEY } from './config/stellar';
import paymentMonitorService from './services/payment-monitor.service';
import { configuredFrontendOrigins, corsOptions } from './config/runtime';
import postgresInvoiceStorage from './storage/postgres-invoice-storage';
import { securityHeaders } from './security/content-safety';
import { correlationMiddleware } from './observability/telemetry';
import invoiceService from './services/invoice.service';
import { JobQueue, JobWorker } from './jobs/worker';
import { PostgresJobStore } from './jobs/postgres-job-store';
import { registerJobHandlers, scheduleReconciliation, startExpiryScheduler } from './jobs/runtime';
import { ReconciliationService } from './ops/reconciliation';
import { publicStatusService } from './ops/public-status';
import { buildUserSafeErrorResponse, classifyError } from './errors/error-taxonomy';
import { validateEnvironment } from './config/env-validator';
import { strictInputLimitsMiddleware } from './security/input-limits';

dotenv.config();

const envCheck = validateEnvironment(process.env, { strict: process.env.NODE_ENV === 'production' });
if (envCheck.issues.length > 0 && process.env.NODE_ENV !== 'test') {
  console.warn(`⚠️ Configuration warnings detected:\n  - ${envCheck.issues.join('\n  - ')}`);
}

const app: Application = express();
const PORT = envCheck.validated.PORT || process.env.PORT || 3001;

// Background jobs: the expiry sweep runs through the worker framework. Set
// JOBS_EMBEDDED_WORKER=false to run workers only via `npm run worker`.
const jobStore = new PostgresJobStore(pool);
const jobWorker = registerJobHandlers(new JobWorker({ store: jobStore, gate: (type) => publicStatusService.backgroundGate(type).run }), {
  expirePendingInvoices: () => invoiceService.markExpiredInvoices(),
  // Detect-only: the job reports drift, repair stays a reviewed /ops/reconciliation apply.
  reconcileProjections: () =>
    new ReconciliationService({
      storage: postgresInvoiceStorage,
      auditLookup: (id) => postgresInvoiceStorage.getAuditEventsByInvoice(id),
    }).scheduledCheck(),
});
let stopExpiryScheduler: (() => void) | null = null;
let stopReconciliationScheduler: (() => void) | null = null;

// Correlation ID & Latency Tracking
app.use(correlationMiddleware());

// Restrictive security headers on every API response
app.use(securityHeaders());

app.use(cors(corsOptions()));

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb', parameterLimit: 20 }));
app.use(strictInputLimitsMiddleware());

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} [${req.correlationId}] - ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'Quittance API',
    version: '1.0.0',
    status: 'running',
    mode: postgresInvoiceStorage.mode,
    documentation: '/api/health',
  });
});

// User-Safe Error handling middleware with taxonomy and correlation tracking
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Unhandled error:', err);
  const classified = classifyError(err);
  const status = (err as any).code === 'CORS_ORIGIN_DENIED' ? 403 : classified.httpStatus || 500;
  const payload = buildUserSafeErrorResponse(err, req.correlationId);

  res.status(status).json(payload);
});

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    error: 'Endpoint not found',
    correlationId: req.correlationId,
  });
});

async function initialize() {
  try {
    console.log('Starting server...');
    await pool.query('SELECT NOW()');
    console.log('Database connected');

    if (SELLER_PUBLIC_KEY) {
      validateStellarConfig();
      paymentMonitorService.start();
    } else {
      console.log('Wallet-scoped mode: no SELLER_PUBLIC_KEY, payment monitor disabled');
    }

    if (process.env.JOBS_EMBEDDED_WORKER !== 'false') {
      jobWorker.start();
      stopExpiryScheduler = startExpiryScheduler(new JobQueue(jobStore));
      // Opt-in: set RECONCILIATION_INTERVAL_MS (e.g. 900000) to schedule detect-only runs.
      const reconcileEvery = Number(process.env.RECONCILIATION_INTERVAL_MS);
      if (Number.isFinite(reconcileEvery) && reconcileEvery > 0) {
        const queue = new JobQueue(jobStore);
        const tick = () => scheduleReconciliation(queue, new Date(), reconcileEvery).catch((err) => console.error('[jobs] failed to schedule reconciliation:', err));
        void tick();
        const timer = setInterval(tick, reconcileEvery);
        timer.unref?.();
        stopReconciliationScheduler = () => clearInterval(timer);
      }
    }
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
}

export function startServer(port: number | string = PORT) {
  return app.listen(port, async () => {
    await initialize();
    console.log('\n🚀 Quittance Backend (Postgres Mode)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Server running on port ${port}`);
    console.log(`📍 API: http://localhost:${port}/api`);
    console.log(`🏥 Health: http://localhost:${port}/api/health`);
    console.log(`💾 Storage: PostgreSQL`);
    console.log(`💰 Dynamic Seller: Each user uses their own wallet!`);
    console.log(`🌐 Frontends: ${configuredFrontendOrigins().join(', ') || 'not configured'}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
}

const entryPoint = process.argv[1] ?? '';
if (/server(\.[cm]?[jt]s)?$/.test(entryPoint)) {
  startServer();
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  paymentMonitorService.stop();
  jobWorker.stop();
  stopExpiryScheduler?.();
  stopReconciliationScheduler?.();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  paymentMonitorService.stop();
  jobWorker.stop();
  stopExpiryScheduler?.();
  stopReconciliationScheduler?.();
  await pool.end();
  process.exit(0);
});

export default app;

import { Router } from 'express';
import { createInvoiceHandlers, InvoiceHandlerOptions } from './invoice.handlers';
import { PublicStatusService, publicStatusService } from '../ops/public-status';

export interface InvoiceRouterOptions extends InvoiceHandlerOptions {
  /** Paused/maintenance gate (#254). Defaults to the process status; operational passes everything. */
  publicStatus?: PublicStatusService;
}

/**
 * Invoice routes shared by both servers. Mount under `/api`.
 *
 * Route list is kept identical between server.ts (Postgres) and
 * server-mvp.ts (in-memory):
 *   POST   /invoices
 *   GET    /invoices/stats
 *   GET    /invoices
 *   GET    /invoices/:id
 *   GET    /invoices/:id/payment-info
 *   POST   /invoices/:id/cancel
 *   POST   /invoices/:id/verify
 *   POST   /invoices/:id/simulate-payment
 * If a route is added here, wire it into the same shared handlers so parity
 * tests in invoice-handlers.test.ts cover both storage backends.
 */
export function createInvoiceRouter(options: InvoiceRouterOptions): Router {
  const handlers = createInvoiceHandlers(options);
  const status = options.publicStatus ?? publicStatusService;
  const router = Router();

  router.post('/invoices', status.requireCapability('invoice_creation'), handlers.createInvoice);
  // Must stay before the dynamic /invoices/:id route to avoid shadowing.
  router.get('/invoices/stats', handlers.getStats);
  router.get('/invoices', handlers.getInvoices);
  router.get('/invoices/:id', handlers.getInvoice);
  router.get('/invoices/:id/payment-info', handlers.getPaymentInfo);
  router.post('/invoices/:id/cancel', status.requireCapability('invoice_cancellation'), handlers.cancelInvoice);
  router.post('/invoices/:id/verify', status.requireCapability('payment_verification'), handlers.verifyPayment);
  router.post('/invoices/:id/simulate-payment', status.requireCapability('payment_verification'), handlers.simulatePayment);
  router.get('/invoices/:id/email-preview', handlers.getEmailPreview);
  router.post('/invoices/:id/send-email', status.requireCapability('email_notifications'), handlers.sendInvoiceEmail);

  return router;
}

export default createInvoiceRouter;

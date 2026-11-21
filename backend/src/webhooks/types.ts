import 'express';

declare global {
  namespace Express {
    interface Request {
      webhookEventId?: string;
      /**
       * Set by the webhook middleware. Call it when handling the verified event
       * fails, so the provider's redelivery of the same event ID is accepted (#430).
       */
      releaseWebhookEvent?: () => void;
    }
  }
}

export interface WebhookConfig {
  signingSecret: string;
  toleranceSeconds: number;
  replayWindowMs: number;
}

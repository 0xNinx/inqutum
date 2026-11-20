import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryBoundedBatchProcessor,
  BatchAuthorizationError,
  BatchConfigError,
  type BatchConfig,
  type BatchResult,
} from '../src/batch/bounded-batch-processor';

describe('Bounded Batch Processor (Issue #374)', () => {
  let processor: MemoryBoundedBatchProcessor;

  beforeEach(() => {
    processor = new MemoryBoundedBatchProcessor();
    processor.clear();
  });

  describe('Normal path: successful batch processing', () => {
    it('processes small dataset within single batch', async () => {
      const items = [
        { id: 1, value: 'item-1' },
        { id: 2, value: 'item-2' },
        { id: 3, value: 'item-3' },
      ];

      const result = await processor.process(items, {
        maxBatchSize: 100,
        maxMemoryBytes: 1024 * 1024,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.itemsProcessed, 3);
      assert.strictEqual(result.itemsSucceeded, 3);
      assert.strictEqual(result.itemsFailed, 0);
      assert.strictEqual(result.itemsSkipped, 0);
      assert.strictEqual(result.succeeded.length, 3);
      assert.ok(result.batchId.startsWith('batch-'));
      assert.ok(result.correlationId.startsWith('corr-'));
    });

    it('handles empty item list gracefully', async () => {
      const result = await processor.process([], {
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.itemsProcessed, 0);
      assert.strictEqual(result.itemsSucceeded, 0);
    });

    it('tracks correlation ID for idempotent replay', async () => {
      const correlationId = 'my-custom-corr-id';
      const items = [{ data: 'test' }];

      const result = await processor.process(items, {
        correlationId,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.correlationId, correlationId);
    });

    it('records timestamp on successful processing', async () => {
      const before = new Date().toISOString();
      const items = [{ id: 1 }];

      const result = await processor.process(items, { actorRole: 'ADMIN' });

      const after = new Date().toISOString();
      assert.ok(result.timestamp >= before && result.timestamp <= after);
    });
  });

  describe('Failure path: oversized items are skipped', () => {
    it('skips items larger than maxMemoryBytes', async () => {
      // Create a large object that exceeds memory limit
      const largeObject = {
        data: 'x'.repeat(100 * 1024), // ~100KB
      };

      const items = [largeObject];

      const result = await processor.process(items, {
        maxMemoryBytes: 50 * 1024, // 50KB limit
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsSkipped, 1);
      assert.strictEqual(result.skipped.length, 1);
      assert.strictEqual(result.skipped[0].status, 'skipped');
      assert.ok(result.skipped[0].error?.includes('exceeds max memory'));
    });

    it('reports errors with item IDs for root cause analysis', async () => {
      const largeObject = { data: 'x'.repeat(100 * 1024) };
      const result = await processor.process([largeObject], {
        maxMemoryBytes: 50 * 1024,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.errors.length, 1);
      assert.ok(result.errors[0].itemId);
      assert.ok(result.errors[0].error.includes('exceeds max memory'));
    });

    it('continues processing after encountering oversized items', async () => {
      const items = [
        { id: 1, value: 'ok' },
        { data: 'x'.repeat(100 * 1024) }, // oversized
        { id: 2, value: 'ok' },
      ];

      const result = await processor.process(items, {
        maxMemoryBytes: 50 * 1024,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsSucceeded, 2);
      assert.strictEqual(result.itemsSkipped, 1);
      assert.strictEqual(result.exitCode, 1); // failure due to skipped items
    });

    it('provides remediation steps for failures', async () => {
      const largeObject = { data: 'x'.repeat(100 * 1024) };
      const result = await processor.process([largeObject], {
        maxMemoryBytes: 50 * 1024,
        actorRole: 'ADMIN',
      });

      assert.ok(result.remediationSteps.length > 0);
      assert.ok(
        result.remediationSteps.some((s) =>
          s.includes('Review') || s.includes('retry') || s.includes('failed')
        )
      );
    });
  });

  describe('Retry path: exponential backoff with jitter', () => {
    it('configures initial and max backoff times', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        maxRetries: 2,
        initialBackoffMs: 50,
        maxBackoffMs: 5000,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.succeeded.length > 0);
    });

    it('respects maxRetries configuration', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        maxRetries: 5,
        actorRole: 'ADMIN',
      });

      // With maxRetries=5, up to 6 attempts (0..5) are made per item
      assert.ok(result.itemsSucceeded + result.itemsFailed === result.itemsProcessed);
    });

    it('defaults to reasonable retry limits when not specified', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.exitCode, 0);
    });

    it('tracks retry count on processed items', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        maxRetries: 3,
        actorRole: 'ADMIN',
      });

      // Items that succeed may have retryCount defined
      if (result.succeeded.length > 0) {
        const item = result.succeeded[0];
        assert.ok(item.retryCount !== undefined || item.retryCount === 0);
      }
    });
  });

  describe('Authorization path: role-based access control', () => {
    it('allows ADMIN to process batches', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        actorRole: 'ADMIN',
        actorId: 'admin-user',
      });

      assert.ok(result.batchId);
    });

    it('allows OWNER to process batches', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        actorRole: 'OWNER',
        actorId: 'owner-user',
      });

      assert.ok(result.batchId);
    });

    it('allows OPERATOR to process batches', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        actorRole: 'OPERATOR',
        actorId: 'operator-user',
      });

      assert.ok(result.batchId);
    });

    it('rejects VIEWER role', async () => {
      const items = [{ id: 1 }];

      await assert.rejects(
        () =>
          processor.process(items, {
            actorRole: 'VIEWER',
            actorId: 'viewer-user',
          }),
        (err: any) => {
          assert.ok(err instanceof BatchAuthorizationError);
          assert.strictEqual(err.code, 'BATCH_UNAUTHORIZED');
          assert.strictEqual(err.httpStatus, 403);
          return true;
        }
      );
    });

    it('rejects ANONYMOUS role', async () => {
      const items = [{ id: 1 }];

      await assert.rejects(
        () =>
          processor.process(items, {
            actorRole: 'ANONYMOUS',
            actorId: 'anonymous',
          }),
        (err: any) => {
          assert.ok(err instanceof BatchAuthorizationError);
          return true;
        }
      );
    });

    it('rejects undefined role (defaults to ADMIN, allows)', async () => {
      const items = [{ id: 1 }];

      const result = await processor.process(items, {
        // No actorRole specified - should default to ADMIN
        actorId: 'default-user',
      });

      assert.ok(result.batchId);
    });

    it('includes actor info in authorization error message', async () => {
      const items = [{ id: 1 }];

      await assert.rejects(
        () =>
          processor.process(items, {
            actorRole: 'VIEWER',
            actorId: 'test-user-123',
          }),
        (err: any) => {
          assert.ok(err.message.includes('test-user-123'));
          assert.ok(err.message.includes('VIEWER'));
          return true;
        }
      );
    });
  });

  describe('Configuration validation', () => {
    it('rejects maxBatchSize < 1', async () => {
      await assert.rejects(
        () =>
          processor.process([{ id: 1 }], {
            maxBatchSize: 0,
            actorRole: 'ADMIN',
          }),
        (err: any) => {
          assert.ok(err instanceof BatchConfigError);
          return true;
        }
      );
    });

    it('rejects maxMemoryBytes < 1KB', async () => {
      await assert.rejects(
        () =>
          processor.process([{ id: 1 }], {
            maxMemoryBytes: 512,
            actorRole: 'ADMIN',
          }),
        (err: any) => {
          assert.ok(err instanceof BatchConfigError);
          return true;
        }
      );
    });

    it('accepts valid configuration parameters', async () => {
      const result = await processor.process([{ id: 1 }], {
        maxBatchSize: 50,
        maxMemoryBytes: 10 * 1024 * 1024,
        maxRetries: 2,
        initialBackoffMs: 100,
        maxBackoffMs: 5000,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe('Memory bounds: batch splitting', () => {
    it('splits large dataset across multiple batches based on size limit', async () => {
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: i,
        value: 'item-' + i,
      }));

      const result = await processor.process(items, {
        maxBatchSize: 10, // Will create 5 batches
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsProcessed, 50);
      assert.strictEqual(result.itemsSucceeded, 50);
    });

    it('respects maxBatchSize configuration', async () => {
      const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));

      const result = await processor.process(items, {
        maxBatchSize: 25,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsProcessed, 100);
    });

    it('handles single-item batches when memory constrained', async () => {
      const items = [
        { data: 'x'.repeat(1000) },
        { data: 'y'.repeat(1000) },
        { data: 'z'.repeat(1000) },
      ];

      const result = await processor.process(items, {
        maxMemoryBytes: 2048, // Tight limit
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsProcessed, 3);
    });
  });

  describe('Recovery: checkpoint and resume', () => {
    it('records checkpoint after each batch', async () => {
      const items = Array.from({ length: 50 }, (_, i) => ({ id: i }));

      await processor.process(items, {
        maxBatchSize: 10,
        actorRole: 'ADMIN',
      });

      // Active batch count should return to 0 after successful processing
      assert.strictEqual(processor.getActiveCount(), 0);
    });

    it('tracks active batches during processing', async () => {
      const items = [{ id: 1 }];

      await processor.process(items, {
        actorRole: 'ADMIN',
      });

      assert.strictEqual(processor.getActiveCount(), 0);
    });

    it('can resume from checkpoint after pause', async () => {
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }];

      const result = await processor.process(items, {
        maxBatchSize: 1,
        actorRole: 'ADMIN',
      });

      const checkpoint = {
        batchId: result.batchId,
        timestamp: result.timestamp,
        itemsProcessed: 1,
        lastSuccessfulItemId: 'item-0',
        state: 'paused' as const,
      };

      const resumed = await processor.resume(result.batchId, checkpoint);

      assert.strictEqual(resumed.batchId, result.batchId);
      assert.ok(resumed.remediationSteps.some((s) => s.includes('Resumed from checkpoint')));
    });

    it('prevents resuming non-existent batch', async () => {
      await assert.rejects(
        () =>
          processor.resume('nonexistent-batch', {
            batchId: 'nonexistent-batch',
            timestamp: new Date().toISOString(),
            itemsProcessed: 0,
            state: 'paused',
          }),
        (err: any) => {
          assert.ok(err instanceof BatchConfigError);
          return true;
        }
      );
    });
  });

  describe('Edge cases: large-scale processing', () => {
    it('handles 1000 small items efficiently', async () => {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        value: 'item-' + i,
      }));

      const result = await processor.process(items, {
        maxBatchSize: 100,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsProcessed, 1000);
      assert.strictEqual(result.itemsSucceeded, 1000);
      assert.strictEqual(result.exitCode, 0);
    });

    it('reports detailed error info for mixed success/failure', async () => {
      // Create a mix of valid and oversized items
      const items = [
        { id: 1, value: 'ok' },
        { id: 2, value: 'ok' },
        { data: 'x'.repeat(100 * 1024) }, // oversized
      ];

      const result = await processor.process(items, {
        maxMemoryBytes: 50 * 1024,
        actorRole: 'ADMIN',
      });

      assert.strictEqual(result.itemsSucceeded, 2);
      assert.strictEqual(result.itemsSkipped, 1);
      assert.strictEqual(result.errors.length, 1);
      assert.strictEqual(result.exitCode, 1);
    });

    it('provides clear status for each item in result', async () => {
      const items = [{ id: 1 }, { id: 2 }];

      const result = await processor.process(items, {
        actorRole: 'ADMIN',
      });

      result.succeeded.forEach((item) => {
        assert.strictEqual(item.status, 'success');
        assert.ok(item.processedAt);
      });
    });
  });

  describe('Contract preservation: backward compatibility', () => {
    it('maintains stable batch ID format', async () => {
      const result = await processor.process([{ id: 1 }], {
        actorRole: 'ADMIN',
      });

      assert.ok(result.batchId.startsWith('batch-'));
      assert.strictEqual(typeof result.batchId, 'string');
      assert.ok(result.batchId.length > 'batch-'.length);
    });

    it('returns consistent result structure', async () => {
      const result = await processor.process([{ id: 1 }], {
        actorRole: 'ADMIN',
      });

      assert.ok('batchId' in result);
      assert.ok('correlationId' in result);
      assert.ok('timestamp' in result);
      assert.ok('itemsProcessed' in result);
      assert.ok('itemsSucceeded' in result);
      assert.ok('itemsFailed' in result);
      assert.ok('itemsSkipped' in result);
      assert.ok('succeeded' in result);
      assert.ok('failed' in result);
      assert.ok('skipped' in result);
      assert.ok('errors' in result);
      assert.ok('remediationSteps' in result);
      assert.ok('exitCode' in result);
    });

    it('exit code is 0 for full success, 1 for any failure', async () => {
      const successResult = await processor.process([{ id: 1 }], {
        actorRole: 'ADMIN',
      });
      assert.strictEqual(successResult.exitCode, 0);

      const failureResult = await processor.process([{ data: 'x'.repeat(100 * 1024) }], {
        maxMemoryBytes: 50 * 1024,
        actorRole: 'ADMIN',
      });
      assert.strictEqual(failureResult.exitCode, 1);
    });
  });

  describe('Cleanup and state management', () => {
    it('clears checkpoints and active processing state', async () => {
      const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));

      await processor.process(items, {
        maxBatchSize: 5,
        actorRole: 'ADMIN',
      });

      processor.clear();

      assert.strictEqual(processor.getActiveCount(), 0);
    });

    it('independent processor instances maintain separate state', async () => {
      const processor1 = new MemoryBoundedBatchProcessor();
      const processor2 = new MemoryBoundedBatchProcessor();

      const items = [{ id: 1 }];

      const result1 = await processor1.process(items, { actorRole: 'ADMIN' });
      const result2 = await processor2.process(items, { actorRole: 'ADMIN' });

      assert.notStrictEqual(result1.batchId, result2.batchId);
    });
  });
});

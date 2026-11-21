/**
 * Projection replay cancellation (#424).
 *
 * A cancelled replay must leave the live search index untouched, must not keep
 * the service stuck in the running state, and must allow a retry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NothingToRollBackError,
  ProjectionReplayService,
  ReplayCancelledError,
} from '../src/ops/projection-replay';
import { PermissionAwareSearchIndex } from '../src/services/search-index.service';
import { MemoryStorage } from '../src/storage/memory-storage';

function build(events: () => never[] = () => []) {
  const index = new PermissionAwareSearchIndex();
  const service = new ProjectionReplayService({
    storage: new MemoryStorage({ maxEntries: 100 }),
    index,
    events,
  });
  return { index, service };
}

describe('projection replay cancellation (#424)', () => {
  it('normal path: a run without a signal completes', async () => {
    const { service } = build();
    const report = await service.replay({ dryRun: true });
    assert.equal(report.outcome, 'dry_run');
  });

  it('pre-aborted signal: throws ReplayCancelledError and leaves the index unchanged', async () => {
    const { index, service } = build();
    const before = index.exportRecords().length;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.replay({ dryRun: false, signal: controller.signal }),
      ReplayCancelledError
    );
    assert.equal(index.exportRecords().length, before);
  });

  it('abort during the run: the swap never happens and rollback has nothing to restore', async () => {
    const controller = new AbortController();
    const { index, service } = build(() => {
      controller.abort();
      return [];
    });
    const before = index.exportRecords().length;
    await assert.rejects(
      service.replay({ dryRun: false, signal: controller.signal }),
      ReplayCancelledError
    );
    assert.equal(index.exportRecords().length, before);
    assert.throws(() => service.rollback(), NothingToRollBackError);
  });

  it('retry after cancellation: the service is not left running and a new run completes', async () => {
    const { service } = build();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.replay({ signal: controller.signal }), ReplayCancelledError);
    const report = await service.replay({ dryRun: true });
    assert.equal(report.outcome, 'dry_run');
  });
});

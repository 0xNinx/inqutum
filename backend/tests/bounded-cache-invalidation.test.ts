import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoundedProjectionCache } from '../src/ops/stale-projections.service.ts';

describe('bounded cache invalidation and stale detection (#490)', () => {
  it('evicts the least recently used entry and rejects stale versions', () => {
    const cache = new BoundedProjectionCache<string, string>(2);
    cache.set('a', 'old', 1);
    cache.set('b', 'b', 1);
    assert.equal(cache.get('a', 1), 'old');
    cache.set('c', 'c', 1);
    assert.equal(cache.get('b', 1), undefined);
    assert.equal(cache.isStale('a', 2), true);
    assert.equal(cache.get('a', 2), undefined);
    assert.equal(cache.size, 1);
  });

  it('coalesces concurrent loads and retries after failure', async () => {
    const cache = new BoundedProjectionCache<string, string>(2);
    let calls = 0;
    const load = async () => { calls++; return 'loaded'; };
    assert.deepEqual(await Promise.all([cache.getOrLoad('a', 1, load), cache.getOrLoad('a', 1, load)]), ['loaded', 'loaded']);
    assert.equal(calls, 1);
    await assert.rejects(cache.getOrLoad('bad', 1, async () => { throw new Error('unavailable'); }), /unavailable/);
    assert.equal(await cache.getOrLoad('bad', 1, async () => 'recovered'), 'recovered');
  });

  it('does not resurrect an invalidated entry when an older load completes', async () => {
    const cache = new BoundedProjectionCache<string, string>(2);
    let release!: (value: string) => void;
    const pending = cache.getOrLoad('a', 1, () => new Promise<string>((resolve) => { release = resolve; }));
    await Promise.resolve();
    cache.invalidate('a');
    release('outdated');
    assert.equal(await pending, 'outdated');
    assert.equal(cache.get('a', 1), undefined);
    assert.equal(await cache.getOrLoad('a', 2, async () => 'fresh'), 'fresh');
  });

  it('clears all entries and refuses invalid bounds', () => {
    assert.throws(() => new BoundedProjectionCache(0), RangeError);
    const cache = new BoundedProjectionCache<string, number>(1);
    cache.set('a', 1, 1);
    cache.invalidateAll();
    assert.equal(cache.size, 0);
  });
});

# Cache invalidation hardening (#490)

The existing `BoundedProjectionCache` remains an in-process, size-bounded LRU. Reads with a mismatched version evict stale data. Concurrent cache misses for the same key and version share a loader; loader rejection is returned to all waiters without caching a failure, so a later request can retry.

An explicit single-key or full invalidation increments the cache generation. A loader started before invalidation may still return its result to its original caller, but **cannot reinsert that result** into the cache. Callers requiring strict post-invalidation freshness must re-read after invalidating, or coordinate writes with their authoritative storage. This does not replace authorization: enforce access control before returning any cached value, and include tenant/authorization scope in cache keys.

No persisted schema, API envelope, or migration is changed. Rollback: revert the cache implementation commit; stale detection continues to use version comparisons. Verify with `cd backend && node --import tsx --test tests/bounded-cache-invalidation.test.ts`.

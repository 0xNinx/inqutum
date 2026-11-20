# Bounded Batch Processing for Large Datasets (Issue #374)

## Overview

The Bounded Batch Processor is a production-grade service for safely processing large datasets in memory-bounded batches. It handles normal operations, transient failures with exponential backoff retry, permanent failures with rollback guidance, and enforces role-based authorization controls.

**Key properties:**
- **Memory-bounded**: Batches are split to stay within configured memory limits
- **Deterministic retry**: Exponential backoff with jitter and configurable limits
- **Failure recovery**: Checkpoints enable paused/failed batch resumption
- **Authorized**: Role-gated (ADMIN, OPERATOR, OWNER only)
- **Idempotent**: Correlation IDs track replay attempts
- **Observable**: Detailed error reports with per-item status

---

## Architecture & Invariants

### Time Complexity
- O(N) where N is the total number of items to process
- Each item is processed exactly once per retry attempt

### Space Complexity
- O(B) where B is the batch size (bounded by `maxMemoryBytes`)
- Checkpoints store O(1) metadata per batch

### Design Principles

1. **Normal Path**: Items are grouped into batches and processed sequentially.
2. **Failure Path**: Oversized items are skipped; continues processing remaining items.
3. **Retry Path**: Failed batches use exponential backoff with configurable limits.
4. **Recovery Path**: Checkpoints allow resuming from last successful item.
5. **Authorization**: Requires ADMIN, OPERATOR, or OWNER role (gated at entry).

---

## Normal Path: Successful Batch Processing

### Single Batch
```typescript
const processor = new MemoryBoundedBatchProcessor();

const result = await processor.process(items, {
  maxBatchSize: 100,
  maxMemoryBytes: 50 * 1024 * 1024, // 50MB
  actorRole: 'ADMIN',
  actorId: 'admin-user@example.com',
});

console.log(`Processed ${result.itemsSucceeded}/${result.itemsProcessed}`);
// Output: Processed 100/100
```

### Result Structure
```typescript
interface BatchResult<T> {
  batchId: string;                    // Unique batch identifier
  correlationId: string;              // For idempotent replay
  timestamp: string;                  // ISO 8601 processing time
  itemsProcessed: number;             // Total items received
  itemsSucceeded: number;             // Successfully processed
  itemsFailed: number;                // Permanently failed
  itemsSkipped: number;               // Oversized or excluded
  succeeded: BatchItem<T>[];          // Processed items
  failed: BatchItem<T>[];             // Failed items (with errors)
  skipped: BatchItem<T>[];            // Skipped items
  errors: Array<{
    itemId: string;
    error: string;
  }>;                                 // Detailed error list
  remediationSteps: string[];         // Suggested fixes
  exitCode: 0 | 1;                    // 0 = success, 1 = any failure
}
```

### Multiple Batches (Auto-Split)
Large datasets are automatically split into memory-bounded batches:

```typescript
const largeDataset = Array.from({ length: 100000 }, (_, i) => ({
  id: i,
  data: JSON.stringify({ /* large object */ }),
}));

const result = await processor.process(largeDataset, {
  maxBatchSize: 1000,          // Max items per batch
  maxMemoryBytes: 50 * 1024 * 1024,  // Max 50MB per batch
  actorRole: 'OPERATOR',
});

// Internally splits into ~50 batches, processes sequentially
console.log(`${result.itemsSucceeded} items succeeded across ${result.batchId}`);
```

---

## Failure Path: Handling Oversized Items

### Item Size Limits

Items larger than `maxMemoryBytes` are skipped (not processed) to prevent OOM:

```typescript
const oversizedItem = {
  data: 'x'.repeat(100 * 1024 * 1024), // 100MB object
};

const result = await processor.process([oversizedItem], {
  maxMemoryBytes: 50 * 1024 * 1024, // 50MB limit
  actorRole: 'ADMIN',
});

console.log(result.itemsSkipped); // 1
console.log(result.skipped[0].error);
// "Item size 104857600 bytes exceeds max memory 52428800 bytes"
```

### Partial Failure Recovery

Processing continues despite oversized items:

```typescript
const mixedItems = [
  { id: 1, value: 'ok' },
  { data: 'x'.repeat(100 * 1024 * 1024) }, // oversized
  { id: 2, value: 'ok' },
];

const result = await processor.process(mixedItems, {
  maxMemoryBytes: 50 * 1024 * 1024,
  actorRole: 'ADMIN',
});

console.log(`Succeeded: ${result.itemsSucceeded}, Skipped: ${result.itemsSkipped}`);
// Output: Succeeded: 2, Skipped: 1

console.log(result.remediationSteps);
// [
//   "Review and retry 1 skipped items. Inspect error details above.",
//   "To replay: Pass skipped item IDs to process() with a fresh batch.",
//   "Consider increasing maxMemoryBytes if items legitimately exceed current limit."
// ]
```

---

## Retry Path: Exponential Backoff with Jitter

### Configuration

```typescript
const result = await processor.process(items, {
  maxRetries: 3,              // Up to 3 retries per item (4 attempts total: 0..3)
  initialBackoffMs: 100,      // Start with 100ms backoff
  maxBackoffMs: 10000,        // Cap at 10 seconds
  actorRole: 'ADMIN',
});
```

### Backoff Algorithm

Backoff is computed as:
```
backoff = min(
  initialBackoffMs * 2^attempt + random(0, 1000),
  maxBackoffMs
)
```

**Example timing for `initialBackoffMs=100`, `maxBackoffMs=10000`:**
- Attempt 0: Immediate (no backoff)
- Attempt 1: ~100ms + jitter
- Attempt 2: ~200ms + jitter
- Attempt 3: ~400ms + jitter
- Attempt 4 (if maxRetries=3): ~800ms + jitter

### Tracking Retry Counts

Each item in the result includes `retryCount`:

```typescript
result.failed.forEach(item => {
  if (item.error) {
    console.log(`${item.id}: failed after ${item.retryCount || 0} retries`);
  }
});
```

### Edge Case: Transient Failures

If a failure is transient (e.g., temporary network issue), the item may succeed on retry:

```typescript
// First attempt: network error
// Wait 100ms + jitter
// Second attempt: success
// Result: item appears in succeeded[], not failed[]
```

---

## Authorization Path: Role-Based Access Control

### Allowed Roles

| Role | Allowed | Notes |
|------|---------|-------|
| ADMIN | ✅ | Full access; can process any batch |
| OWNER | ✅ | Org owner; can process any batch |
| OPERATOR | ✅ | Service operator; can process batches |
| VIEWER | ❌ | Read-only; cannot modify |
| ANONYMOUS | ❌ | Unauthenticated; cannot access |

### Authorization Check

```typescript
const result = await processor.process(items, {
  actorRole: 'VIEWER',  // ❌ Not allowed
  actorId: 'user123',
});
// Throws: BatchAuthorizationError
// Code: BATCH_UNAUTHORIZED
// HTTP Status: 403
```

### Error Details

```typescript
try {
  await processor.process(items, { actorRole: 'VIEWER' });
} catch (err) {
  console.log(err.code);      // "BATCH_UNAUTHORIZED"
  console.log(err.httpStatus);  // 403
  console.log(err.message);
  // "Actor 'user123' with role 'VIEWER' is not authorized..."
}
```

---

## Recovery: Checkpoints and Resumption

### Pausing a Batch

If a batch fails partway through, a checkpoint is recorded:

```typescript
const result = await processor.process(items, {
  maxBatchSize: 100,
  actorRole: 'ADMIN',
});

// If processing was paused at item 150 of 1000:
// A checkpoint exists for resumption
```

### Resuming from Checkpoint

```typescript
const checkpoint = {
  batchId: result.batchId,
  timestamp: result.timestamp,
  itemsProcessed: 150,
  lastSuccessfulItemId: 'item-150',
  state: 'paused' as const,
};

const resumed = await processor.resume(result.batchId, checkpoint);

console.log(resumed.remediationSteps);
// ["Resumed from checkpoint at item item-150"]
```

### Prevention of Double-Processing

Attempting to resume an already-active batch raises an error:

```typescript
// First process
const result1 = processor.process(items1, { actorRole: 'ADMIN' });

// Before it finishes, attempt to resume same batch
await assert.rejects(
  () => processor.resume(result1.batchId, checkpoint),
  (err) => err.code === 'BATCH_CONFIG_ERROR'
);
// "Batch batch-123 is already in progress"
```

---

## Edge Cases and Recovery Behavior

### Case 1: Mixed Success and Failure

```typescript
const result = await processor.process([
  { id: 1 },                              // ✅ succeeds
  { id: 2 },                              // ✅ succeeds
  { data: 'x'.repeat(100 * 1024 * 1024) }, // ⏭️ skipped (oversized)
], {
  maxMemoryBytes: 50 * 1024 * 1024,
  actorRole: 'ADMIN',
});

console.log(result.exitCode);        // 1 (failure due to skipped)
console.log(result.itemsSucceeded);  // 2
console.log(result.itemsSkipped);    // 1
console.log(result.errors.length);   // 1
```

### Case 2: Idempotent Replay

Using a stable `correlationId` enables safe replay:

```typescript
const correlationId = 'invoice-import-wave-11';

const result1 = await processor.process(items, {
  correlationId,
  actorRole: 'ADMIN',
});

// If the caller is unsure if the batch succeeded, they can replay:
const result2 = await processor.process(items, {
  correlationId,  // Same ID
  actorRole: 'ADMIN',
});

// Caller can use the correlation ID to detect duplicates upstream
console.log(result1.correlationId === result2.correlationId); // true
```

### Case 3: Large-Scale Processing

Processing 1 million items in memory-bounded batches:

```typescript
const largeDataset = generateMillionItems(); // Array<Item>

const result = await processor.process(largeDataset, {
  maxBatchSize: 10000,
  maxMemoryBytes: 100 * 1024 * 1024,  // 100MB per batch
  maxRetries: 2,
  actorRole: 'OPERATOR',
});

// Internally splits into ~100 batches
// Processes sequentially: batch 1, batch 2, ..., batch 100
// Each batch is independent; failure in batch 50 does not affect batch 51

console.log(`
  Processed: ${result.itemsProcessed}
  Succeeded: ${result.itemsSucceeded}
  Failed: ${result.itemsFailed}
  Skipped: ${result.itemsSkipped}
`);
```

---

## Migration & Contracts

### No Breaking Changes

The bounded batch processor is **additive** — it does not modify existing APIs or data structures. Existing invoice, payment, and audit systems remain unchanged.

### Preservation of Existing Contracts

- **Invoices**: No schema changes
- **Payments**: Verification logic unchanged
- **Audit Trail**: AuditService continues to work independently
- **Migrations**: Migration safety (`migration-safety.ts`) remains the source of truth

### Integration Points

The batch processor can be used by:
1. **Invoice Import** (`backend/src/imports/import-service.ts`)
2. **Data Retention** (`backend/src/retention/retention-service.ts`)
3. **Bulk Operations** (future OPS endpoints)

---

## Configuration Reference

```typescript
interface BatchConfig {
  maxBatchSize?: number;              // Default: 100
  maxMemoryBytes?: number;            // Default: 50MB
  maxRetries?: number;                // Default: 3
  initialBackoffMs?: number;          // Default: 100ms
  maxBackoffMs?: number;              // Default: 10s
  correlationId?: string;             // Default: auto-generated
  actorRole?: BatchActorRole;         // Default: 'ADMIN' (required for auth)
  actorId?: string;                   // Actor identifier (optional)
}
```

### Defaults

```typescript
{
  maxBatchSize: 100,
  maxMemoryBytes: 50 * 1024 * 1024,  // 50MB
  maxRetries: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 10000,
  correlationId: auto-generated,
  actorRole: 'ADMIN',
}
```

---

## Testing & Verification

### Unit Tests

```bash
npm run test -- backend/tests/bounded-batch-processor.test.ts
```

### Test Coverage

- ✅ Normal path: single and multiple batches
- ✅ Failure path: oversized items, error reporting
- ✅ Retry path: exponential backoff, configurable limits
- ✅ Authorization: role-based gating
- ✅ Recovery: checkpoints and resumption
- ✅ Edge cases: mixed success/failure, large-scale processing
- ✅ Contract preservation: backward compatibility

### Manual Testing

```typescript
import { MemoryBoundedBatchProcessor } from './backend/src/batch/bounded-batch-processor';

const processor = new MemoryBoundedBatchProcessor();

// Test small batch
const result = await processor.process(
  [{ id: 1 }, { id: 2 }, { id: 3 }],
  { actorRole: 'ADMIN' }
);
console.log(`Success: ${result.exitCode === 0}`);

// Test authorization
try {
  await processor.process([{ id: 1 }], { actorRole: 'VIEWER' });
} catch (err) {
  console.log(`Auth blocked: ${err.code}`);
}

// Test large dataset
const large = Array.from({ length: 100000 }, (_, i) => ({ id: i }));
const largeResult = await processor.process(large, {
  maxBatchSize: 1000,
  actorRole: 'ADMIN',
});
console.log(`Processed ${largeResult.itemsSucceeded}/${largeResult.itemsProcessed}`);
```

---

## Troubleshooting

### "Item size exceeds max memory"

**Problem**: One or more items are too large to fit in a single batch.

**Solution**:
1. Check item sizes: `estimateObjectSize(item)` should be < `maxMemoryBytes`
2. Increase `maxMemoryBytes` if items are legitimately large
3. Split large items into smaller pieces upstream
4. Use `itemsSkipped` count in result to identify how many items failed

### "Batch is already in progress"

**Problem**: Attempted to resume a batch that is still being processed.

**Solution**:
1. Wait for the original `process()` call to complete
2. Check `processor.getActiveCount()` to see how many batches are in flight
3. Use unique `correlationId` for each distinct batch

### "Authorization denied"

**Problem**: Insufficient role to execute batch operation.

**Solution**:
1. Use ADMIN, OPERATOR, or OWNER role
2. Check `actorRole` and `actorId` in request
3. If using service-to-service calls, ensure the calling service is registered as OPERATOR

---

## Performance Notes

### Memory Usage
- Bounded by `maxMemoryBytes` per batch
- Checkpoints use minimal memory (O(1) metadata)
- Large datasets are split into independent batches

### Throughput
- Processing is sequential (batch-by-batch)
- Each batch is fully processed before moving to the next
- Parallelization can be added at the `process()` call site (wrap in Promise.all)

### Backoff Timing
- Initial backoff: 100ms (configurable)
- Each retry doubles backoff (with jitter)
- Useful for transient failures (temporary API unavailability, database locks, etc.)

---

## See Also

- [Migration Safety](./MIGRATIONS.md) — Schema preview and rollback notes
- [Rollback Verification](./OPERATIONS.md) — Deterministic rollback for migrations and deployments
- [Audit Trail](./AUDIT.md) — Event-sourced audit logging for sensitive operations
- [Import Pipeline](../backend/src/imports/import-pipeline.ts) — Bulk invoice import using batch processor

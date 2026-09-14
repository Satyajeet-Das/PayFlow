# Concurrency Control

## The Problem

Payment systems face a class of bugs that only manifest under concurrent load: two requests arrive simultaneously and both believe they are the first to perform an operation. Without explicit concurrency controls, this leads to:

- Double payments (two charges for one order)
- Double refunds (two refunds for one payment)
- Invalid state transitions (two concurrent cancels — which one wins?)
- Race conditions in idempotency checks (two identical requests both get past the "key doesn't exist" check)

PayFlow uses multiple, complementary layers of concurrency protection. No single layer is sufficient on its own.

---

## Layer 1: Database Unique Constraints (Strongest)

The **only reliable** protection against concurrent duplicates is a database-level unique constraint. Application-level checks have a time-of-check/time-of-use (TOCTOU) race condition.

### Idempotency Key Uniqueness

```sql
UNIQUE(merchant_id, key)   -- on idempotency_keys table
```

This is the final safety net. Even if 100 concurrent requests all pass application-level checks simultaneously, only one `INSERT` will succeed. The other 99 will receive a unique constraint violation and follow the replay path.

### Ledger Transaction Uniqueness

```sql
UNIQUE(idempotency_key)   -- on ledger_transactions table
```

Prevents the same payment from being posted to the ledger twice, even if the payment service has a bug that calls `recordPayment()` twice.

### Webhook Delivery Uniqueness

```sql
UNIQUE(idempotency_key)   -- on webhook_deliveries table
```

Prevents the same event from being delivered twice to the same merchant endpoint, even if the Kafka consumer processes the event multiple times.

---

## Layer 2: Optimistic Locking on State Transitions

When transitioning a payment's status, we use an optimistic lock by including the expected current status in the `WHERE` clause:

```typescript
// payments.repository.ts
async transitionStatus(
  paymentId: string,
  from: PaymentStatus,
  to: PaymentStatus,
): Promise<Payment | null> {
  // This UPDATE atomically checks the current state and changes it
  // If 0 rows updated, either the payment doesn't exist or
  // it was already transitioned by a concurrent request
  const result = await this.prisma.$executeRaw`
    UPDATE payments
    SET status = ${to}::payment_status,
        updated_at = now()
    WHERE id = ${paymentId}
      AND status = ${from}::payment_status
  `;

  if (result === 0) {
    return null; // Transition failed — concurrent update won
  }

  return this.findById(paymentId);
}
```

The calling service checks the return value:

```typescript
// payments.service.ts
const updated = await this.paymentsRepository.transitionStatus(
  paymentId, 'CREATED', 'CANCELLED'
);

if (!updated) {
  throw new ConflictException(
    'Payment was already modified by another request. Fetch the current state and retry.'
  );
}
```

**Why optimistic over pessimistic locking?**

Pessimistic locking (`SELECT ... FOR UPDATE`) holds a row lock for the duration of the operation. If the operation includes an external processor call (which can take seconds), this blocks all other requests to the same payment for that entire duration — killing throughput.

Optimistic locking assumes conflicts are rare. It tries the operation and handles failure if the assumption was wrong. For payment state transitions (which are infrequent per payment), this is the right tradeoff.

---

## Layer 3: SELECT ... FOR UPDATE SKIP LOCKED (Workers)

Background workers (outbox, reconciliation, webhook) must claim work items without two workers processing the same item simultaneously.

### The Pattern

```sql
-- Claim a batch of outbox events for processing
SELECT * FROM outbox_events
WHERE status = 'PENDING'
  AND scheduled_for <= now()
ORDER BY created_at ASC
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE` locks the selected rows.
`SKIP LOCKED` skips rows that are already locked by another transaction.

**Result:** Multiple worker instances can run concurrently without processing the same events. Each worker sees a disjoint subset of work items.

### Why SKIP LOCKED instead of FOR UPDATE?

`FOR UPDATE` (without SKIP LOCKED) blocks — the second worker waits until the first releases its lock. This is queue starvation under high load.

`FOR UPDATE SKIP LOCKED` is non-blocking — the second worker immediately moves to unlocked rows. Multiple workers scale linearly.

```typescript
// outbox.worker.ts
async processBatch(): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    const events = await tx.$queryRaw<OutboxEvent[]>`
      SELECT * FROM outbox_events
      WHERE status = 'PENDING'
        AND scheduled_for <= now()
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `;

    for (const event of events) {
      await this.publishEvent(tx, event);
    }
  });
}
```

---

## Layer 4: Redis Distributed Lock (In-Flight Detection)

For the idempotency in-flight detection (Case 4 in idempotency.md), a Redis lock provides fast, non-database detection that a request is currently being processed:

```typescript
// idempotency.service.ts
const lockKey = `idempotency:lock:${merchantId}:${key}`;
const acquired = await this.redis.set(lockKey, '1', 'NX', 'EX', 30);

if (!acquired) {
  throw new IdempotencyKeyInFlightException();
}

try {
  // Process payment
} finally {
  await this.redis.del(lockKey);
}
```

**Important:** This Redis lock is an optimization for user experience (fast in-flight detection), not a correctness guarantee. The database `UNIQUE` constraint is the correctness guarantee. If Redis is unavailable, the system falls back to the database constraint and the client may receive a slightly different error, but no duplicate payment is created.

---

## Layer 5: Database Transactions (Atomicity)

Multiple related operations must succeed or fail together. This is enforced using Prisma's interactive transactions:

```typescript
// All of these happen atomically or none of them do
await this.prisma.$transaction(async (tx) => {
  const payment = await tx.payment.create({ data: paymentData });
  await tx.ledgerEntry.createMany({ data: ledgerEntries });
  await tx.outboxEvent.create({ data: outboxEvent });
  await tx.idempotencyKey.update({ where: { ... }, data: { paymentId: payment.id } });
});
```

If any step fails, all steps are rolled back. This prevents partial states like:
- Payment created but ledger not updated
- Payment created but idempotency key not marked complete
- Ledger updated but outbox event not written

---

## Concurrency Scenarios and Outcomes

### Scenario 1: Two concurrent payment creations (same idempotency key)

```
Request A: INSERT idempotency_key (order_123) → SUCCESS
Request B: INSERT idempotency_key (order_123) → UNIQUE VIOLATION → replay path
```

**Outcome:** One payment created, both requests receive the same response.

---

### Scenario 2: Two concurrent cancel requests

```
Request A: UPDATE payments SET status='CANCELLED' WHERE id=X AND status='CREATED' → 1 row updated
Request B: UPDATE payments SET status='CANCELLED' WHERE id=X AND status='CREATED' → 0 rows updated
```

**Outcome:** Request A succeeds (200). Request B gets 0 rows updated → `ConflictException` (409). Client re-fetches the payment and sees it's already cancelled.

---

### Scenario 3: Cancel and charge race

```
Request A (cancel): UPDATE WHERE status='CREATED' → ...
Request B (processor callback): UPDATE WHERE status='PROCESSING' → ...
```

If Request A updates CREATED → CANCELLED before the payment reaches PROCESSING, it succeeds. The processor callback will update WHERE status='PROCESSING' and find 0 rows — it logs the inconsistency and the payment stays CANCELLED.

If Request B updates PROCESSING → SUCCEEDED first, Request A then tries CREATED → CANCELLED but the payment is already SUCCEEDED. 0 rows updated → 409.

**Outcome:** One of the two operations wins. The state machine invariant is preserved. No undefined states are possible.

---

### Scenario 4: Two outbox workers start simultaneously

```
Worker A: SELECT ... FOR UPDATE SKIP LOCKED → claims events [1, 2, 3, 4, 5]
Worker B: SELECT ... FOR UPDATE SKIP LOCKED → claims events [6, 7, 8, 9, 10]
```

**Outcome:** No event is processed twice. Workers process disjoint sets efficiently.

---

## What We Do NOT Use

### Advisory Locks
PostgreSQL advisory locks (`pg_try_advisory_lock`) are application-managed locks with no automatic cleanup. A crashed application holds the lock indefinitely. We avoid them.

### Application-Level Caches for Uniqueness Checks
Never do:
```typescript
const exists = await this.redis.get(`payment:exists:${idempotencyKey}`);
if (exists) return replay();
// ... create payment
await this.redis.set(`payment:exists:${idempotencyKey}`, '1');
```

Redis is not durable. A Redis restart between "check" and "set" loses the cache entry. The second request creates a duplicate. Always use database constraints for uniqueness guarantees.

### Distributed Transactions (2PC)
Two-phase commit across multiple databases/services is complex, slow, and has failure modes that are harder to reason about than our approach. We use PostgreSQL as the single source of truth and avoid cross-database transactions entirely.

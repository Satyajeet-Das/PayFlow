# Concurrency Reference

> This is a supplementary reference card for the concurrency patterns described in [`concurrency.md`](./concurrency.md). Quick-reference for implementation.

---

## Pattern Cheat Sheet

| Problem | Solution | Layer |
|---|---|---|
| Concurrent duplicate payment creation | `UNIQUE(merchant_id, key)` in `idempotency_keys` | Database constraint |
| Concurrent state transitions (cancel race) | `UPDATE WHERE status = $expected` | Optimistic lock |
| Multiple outbox workers claiming same events | `FOR UPDATE SKIP LOCKED` | DB row-level lock |
| In-flight request detection | Redis `SET NX EX 30` | Distributed lock |
| Atomic payment + ledger + outbox | `prisma.$transaction(async tx => {...})` | DB transaction |
| Ledger double-post prevention | `UNIQUE(idempotency_key)` in `ledger_transactions` | Database constraint |
| Webhook duplicate delivery | `UNIQUE(idempotency_key)` in `webhook_deliveries` | Database constraint |

---

## State Transition Pattern (Canonical)

```typescript
// Always use this pattern for status transitions:

const updated = await this.prisma.$executeRaw`
  UPDATE payments
  SET   status = ${newStatus}::payment_status,
        updated_at = now()
  WHERE id = ${paymentId}
    AND status = ${currentStatus}::payment_status
`;

if (updated === 0) {
  // Either: wrong current status, or payment was modified concurrently
  const current = await this.findById(paymentId);
  if (!current) throw new NotFoundException();
  throw new ConflictException(
    `Payment is in state ${current.status}, cannot transition to ${newStatus}`
  );
}
```

---

## FOR UPDATE SKIP LOCKED Pattern (Canonical)

```typescript
// Use inside a Prisma transaction:

const items = await this.prisma.$transaction(async (tx) => {
  return tx.$queryRaw<T[]>`
    SELECT * FROM ${table}
    WHERE  status = 'PENDING'
      AND  scheduled_for <= now()
    ORDER BY created_at ASC
    LIMIT  ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;
});
```

---

## Idempotent Operation Pattern (Canonical)

```typescript
// For any operation that must run exactly once:

async recordPaymentSuccess(paymentId: string): Promise<void> {
  const key = `payment_success:${paymentId}`;

  try {
    await this.prisma.ledgerTransaction.create({
      data: {
        idempotencyKey: key,  // UNIQUE constraint on this column
        // ... other fields
      },
    });
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      // Already recorded — this is fine, idempotent by design
      return;
    }
    throw error;
  }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
```

---

## Transaction Boundary Rules

1. **Payment state + ledger entries + outbox event** → always in ONE transaction
2. **Idempotency key update** → always in the SAME transaction as payment creation
3. **Outbox worker: publish + mark PUBLISHED** → separate operations (not in same transaction — if publish succeeds but mark fails, event is republished idempotently)
4. **Redis operations** → NEVER inside a Prisma transaction (different systems, can't atomically roll back both)

---

## Error Handling for Concurrency Conflicts

```typescript
// Global pattern for handling concurrent modification:

try {
  await this.paymentsService.cancel(paymentId, merchantId);
} catch (error) {
  if (error instanceof ConflictException) {
    // Re-fetch and return current state
    const payment = await this.paymentsService.findOne(paymentId, merchantId);
    // The payment is already in a state that makes cancel irrelevant
    // Return 200 with current state (idempotent behavior for client)
    return payment;
  }
  throw error;
}
```

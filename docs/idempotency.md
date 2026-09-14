# Idempotency

## What is Idempotency?

An operation is **idempotent** if performing it multiple times produces the same result as performing it once. In payment systems, idempotency is a safety guarantee: if a client retries a payment request (due to network failure, timeout, or crash), the payment is processed exactly once.

Without idempotency:
```
Client: POST /v1/payments  →  network times out
Client: POST /v1/payments  →  creates SECOND payment
Customer is charged twice.
```

With idempotency:
```
Client: POST /v1/payments + Idempotency-Key: order_123
  →  network times out

Client: POST /v1/payments + Idempotency-Key: order_123
  →  same payment returned, no second charge
```

---

## The Header

All mutating payment endpoints require:

```http
POST /v1/payments HTTP/1.1
Authorization: Bearer sk_live_abc123
Idempotency-Key: order_9f8e7d6c_attempt_1
Content-Type: application/json
```

The `Idempotency-Key` is:
- Chosen by the **merchant** (not PayFlow)
- Must be unique per merchant per intended operation
- Should encode business context (e.g., order ID + attempt number)
- Valid for **24 hours** from first use
- Scoped to the **merchant** (different merchants can use the same key value without conflict)

### If the Header is Missing
```
HTTP 400 Bad Request
{
  "code": "IDEMPOTENCY_KEY_REQUIRED",
  "message": "Idempotency-Key header is required for this endpoint"
}
```

---

## Database Design

```sql
CREATE TABLE idempotency_keys (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,   -- SHA-256 of canonical request body
  payment_id      TEXT REFERENCES payments(id),
  status_code     INTEGER,         -- HTTP status code of original response
  response_body   JSONB,           -- Full response body to replay
  locked_at       TIMESTAMPTZ,     -- Set when first request starts processing
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',

  UNIQUE(merchant_id, key)         -- THE core database constraint
);
```

### Why `UNIQUE(merchant_id, key)` at the Database Level?

Application-level checks are not safe under concurrency:

```
Time 0: Request A reads → key does not exist → proceeds
Time 0: Request B reads → key does not exist → proceeds
Time 1: Request A inserts key → succeeds
Time 1: Request B inserts key → duplicate! (without DB constraint: 2 payments created)
```

The database `UNIQUE` constraint makes the second insert fail with a unique violation regardless of concurrency. The application catches this violation and handles it correctly. This is the **only reliable** way to prevent duplicates under concurrent load.

### Why Store `request_hash`?

The `request_hash` is a SHA-256 of the canonical (deterministically serialized) request body. It serves one purpose: detecting when the same key is reused with a different request body.

```
First request:  key=order_123, body={"amount":1000,"currency":"INR"}
                → hash = abc...
                → stored

Second request: key=order_123, body={"amount":2000,"currency":"INR"}
                → hash = xyz... ≠ abc...
                → 409 Conflict (key reused with different payload)
```

This prevents a class of bug where a client accidentally reuses an idempotency key for a different operation.

---

## The Four Cases

### Case 1: New Request (Happy Path)

```
Idempotency-Key: order_123_payment

1. Compute body hash
2. INSERT INTO idempotency_keys (merchant_id, key, request_hash, locked_at=now())
   → Success (new key)
3. Process payment normally
4. UPDATE idempotency_keys SET payment_id=..., status_code=201, response_body=...
   (in same DB transaction as payment creation)
5. Return 201
```

### Case 2: Duplicate Request — Same Body (Replay)

```
Idempotency-Key: order_123_payment (already used, same body)

1. Compute body hash
2. INSERT → fails with UNIQUE violation
3. SELECT from idempotency_keys WHERE merchant_id=... AND key=...
4. Check: request_hash matches stored hash? YES
5. response_body is not null? YES (previous request completed)
6. Return stored status_code + response_body
   (client receives IDENTICAL response to original — including same payment ID)
```

### Case 3: Conflict — Same Key, Different Body

```
Idempotency-Key: order_123_payment (already used, DIFFERENT body)

1. Compute body hash
2. INSERT → fails with UNIQUE violation
3. SELECT from idempotency_keys WHERE merchant_id=... AND key=...
4. Check: request_hash matches stored hash? NO
5. Return 409:
   {
     "code": "IDEMPOTENCY_KEY_CONFLICT",
     "message": "This idempotency key was used with a different request body"
   }
```

### Case 4: In-Flight Request

```
Idempotency-Key: order_123_payment (locked_at is set but response_body is null)
This means another request is currently processing this key.

1. INSERT → fails with UNIQUE violation
2. SELECT from idempotency_keys
3. response_body is null → request is in flight
4. Return 409:
   {
     "code": "IDEMPOTENCY_KEY_IN_FLIGHT",
     "message": "A request with this key is currently being processed. Retry after 1 second."
   }
```

---

## Atomicity: The Critical Detail

The idempotency key update and the payment creation **must be in the same database transaction**:

```typescript
await this.prisma.$transaction(async (tx) => {
  // 1. Create payment
  const payment = await tx.payment.create({ data: paymentData });

  // 2. Create ledger entries
  await tx.ledgerEntry.createMany({ data: ledgerData });

  // 3. Mark idempotency key as complete
  await tx.idempotencyKey.update({
    where: { merchantId_key: { merchantId, key } },
    data: {
      paymentId: payment.id,
      statusCode: 201,
      responseBody: buildResponseBody(payment),
    },
  });
});
```

If the transaction commits → idempotency key is stored → replay works.
If the transaction rolls back → idempotency key is NOT stored → client can retry safely.

If the application crashes after the transaction commits but before the HTTP response is sent → the client retries → Case 2 (replay) correctly returns the already-created payment.

---

## The Concurrency Test

The most important test for idempotency is the concurrent duplicate test:

```typescript
it('100 concurrent identical requests should produce exactly 1 payment', async () => {
  const idempotencyKey = `test-concurrent-${Date.now()}`;
  const body = { amount: 1000, currency: 'INR' };

  const requests = Array.from({ length: 100 }, () =>
    request(app)
      .post('/v1/payments')
      .set('Authorization', `Bearer ${merchant.apiKey}`)
      .set('Idempotency-Key', idempotencyKey)
      .send(body)
  );

  const responses = await Promise.all(requests);

  // All requests succeed (either 201 or 200 replay)
  const failed = responses.filter(r => r.status >= 400);
  expect(failed).toHaveLength(0);

  // Exactly one unique payment ID across all responses
  const paymentIds = new Set(responses.map(r => r.body.data.id));
  expect(paymentIds.size).toBe(1);

  // Exactly one payment in the database
  const dbPayments = await prisma.payment.count({
    where: { merchantId: merchant.id }
  });
  expect(dbPayments).toBe(1);
});
```

This test proves correctness under the exact conditions that cause real-world duplicate charges.

---

## Expiry and Cleanup

Idempotency keys expire after 24 hours. After expiry:
- The key is treated as new (a new payment can be created with the same key)
- Expired keys are cleaned up by a nightly cron job

```typescript
// Cleanup worker (runs nightly)
await this.prisma.idempotencyKey.deleteMany({
  where: { expiresAt: { lt: new Date() } }
});
```

**Why 24 hours?** Long enough for all reasonable retry scenarios (network failures, client restarts, brief outages). Short enough that key space remains manageable. This is the same window used by Stripe.

---

## What Idempotency Does NOT Protect Against

1. **Different idempotency keys for the same logical operation** — if a merchant creates two payments with two different keys for the same order, both payments are created. PayFlow cannot detect business-level duplicates, only protocol-level duplicates.

2. **Refunds without idempotency keys** — if `Idempotency-Key` is not sent on refund requests, a network retry creates two refunds. This is why refund endpoints also require the header.

3. **Processor-side duplicates** — if the processor itself doesn't support idempotency, a retry from PayFlow to the processor could double-charge. The `UNKNOWN` state and reconciliation pattern address this. See [`failure-handling.md`](./failure-handling.md).

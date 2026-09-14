# Failure Handling

## Philosophy

In distributed systems, failures are not exceptional — they are routine. Network calls fail. Databases become temporarily unavailable. Third-party processors time out. The question is not "how do we prevent failures" but "how do we maintain correctness when they occur."

PayFlow's failure handling is built on three principles:

1. **Never assume a timed-out operation failed.** A timeout means the result is unknown, not that the operation failed. This distinction is critical in payment systems.

2. **Make operations idempotent before retrying.** An operation can only be safely retried if retrying it produces the same result as the first attempt.

3. **Prefer explicit uncertainty over silent failure.** The `UNKNOWN` payment state exists specifically to acknowledge that we do not know what happened, so we can resolve it correctly later.

---

## Failure Taxonomy

### Category 1: Client Errors (4xx)

These are deterministic failures caused by the merchant's request. Safe to return immediately.

| Error | HTTP Status | Code | Cause |
|---|---|---|---|
| Missing idempotency key | 400 | `IDEMPOTENCY_KEY_REQUIRED` | Merchant forgot the header |
| Validation failure | 400 | `VALIDATION_ERROR` | Invalid DTO fields |
| Idempotency conflict | 409 | `IDEMPOTENCY_KEY_CONFLICT` | Same key, different body |
| Invalid state transition | 409 | `INVALID_STATE_TRANSITION` | Cancel on a SUCCEEDED payment |
| Risk declined | 422 | `RISK_DECLINED` | Score too high |
| Payment not found | 404 | `PAYMENT_NOT_FOUND` | Wrong ID or wrong merchant |

### Category 2: Our Infrastructure Failures (5xx)

These are failures in PayFlow's own infrastructure. They do not indicate whether the payment was processed.

| Failure | Safe to Retry? | Behavior |
|---|---|---|
| DB unavailable before processor call | ✅ Yes | Payment not created. Idempotency key not stored. Retry creates a new payment safely. |
| DB unavailable after processor success | ❌ Complex | Payment processed by processor but not in our DB. This is the dual-write problem — solved by the outbox pattern being resilient, but a full DB outage here is an operational incident requiring manual reconciliation. |
| Redis unavailable | ✅ Yes | Rate limiting may fail open. Idempotency falls back to DB. Service degrades gracefully. |
| App crash during processor call | ✅ Yes (via reconciliation) | Payment enters UNKNOWN state if it was persisted as PROCESSING. Reconciliation worker resolves it. |

### Category 3: Processor Failures (External)

These are failures in the payment processor (our fake simulator models all of these):

| Failure Mode | Our Response |
|---|---|
| Processor returns explicit failure (card declined) | Payment → `FAILED`. Safe. Definitive. |
| Processor returns success | Payment → `SUCCEEDED`. |
| Network timeout (no response received) | Payment → `UNKNOWN`. Do NOT retry. Do NOT assume failure. |
| Processor returns 500 | Payment → `FAILED` (treat as definitive failure unless processor has retry semantics) |
| Processor returns duplicate success (idempotency replay) | Payment stays `SUCCEEDED`. Detect via processor_payment_id uniqueness. |
| Processor response arrives after timeout | Reconciliation worker discovers success/failure and updates accordingly. |

---

## The Timeout / UNKNOWN Scenario (Most Critical)

This is the hardest failure in payment systems to handle correctly. Here is the exact sequence:

```
Step 1: PayFlow sends charge request to processor
         → POST https://processor.internal/v1/charges

Step 2: Processor receives request, processes it
         → Customer's card is charged
         → Processor generates confirmation: ch_abc123

Step 3: Processor sends HTTP response back
         → The TCP packet is sent

Step 4: Network packet is lost (router failure, infrastructure issue)
         → PayFlow's HTTP client times out after 10 seconds

Step 5: PayFlow catches TimeoutException
         → PayFlow does NOT know if the charge succeeded
         → PayFlow cannot safely retry (might double-charge)
         → PayFlow cannot assume failure (money may have moved)

Step 6: PayFlow sets payment status = UNKNOWN
         → Records processor_payment_id if it was returned
         → Creates audit trail in payment_attempts
```

### Why NOT Retry?

Retrying a charge after a timeout is **the most dangerous operation in payment systems.** If the first request succeeded, retrying creates a second charge on the customer's card.

The correct solution is:
1. Set payment to `UNKNOWN`
2. Let the reconciliation worker query the processor for the payment status using a reference ID
3. Update the payment based on the authoritative processor response

### Why NOT Assume Failure?

If we assume a timeout means failure and mark the payment `FAILED`:
- The processor may have already charged the customer
- The customer's card is debited but our system shows no payment
- The merchant has rendered goods/services but our records show no payment
- Financial reconciliation becomes impossible

`UNKNOWN` is the only honest representation of the situation.

---

## Reconciliation: Resolving UNKNOWN Payments

The reconciliation worker runs every minute and queries the processor for the status of all `UNKNOWN` payments:

```
Every 60 seconds:
  1. Find payments WHERE status = 'UNKNOWN' AND created_at < now() - 2 minutes
     (2-minute buffer ensures processor has finished processing)

  2. For each UNKNOWN payment:
     a. Call processor.getPayment(processor_payment_id)
     b. Processor returns: SUCCEEDED | FAILED | STILL_UNKNOWN

  3. Map to PayFlow state:
     SUCCEEDED   → transition payment UNKNOWN → SUCCEEDED
                   write ledger settlement entries
                   write outbox event (payment.succeeded)

     FAILED      → transition payment UNKNOWN → FAILED
                   write ledger reversal entries
                   write outbox event (payment.failed)

     STILL_UNKNOWN → leave as UNKNOWN, try again next cycle
                     (if payment is > 24h old and still unknown → operational alert)

  4. Record results in reconciliation_runs table
```

See [`reconciliation.md`](./reconciliation.md) for the full implementation details.

---

## Processor Failure Modes (Simulator)

The processor simulator can be configured to exhibit all real-world failure modes:

```typescript
// src/modules/processor/simulator.processor.ts

type FailureMode =
  | 'success'           // Normal success
  | 'timeout'           // HTTP timeout (10s+)
  | 'error'             // HTTP 500 from processor
  | 'slow'              // Success but slow (8-9 seconds)
  | 'duplicate_response'// Returns success twice (test idempotency)
  | 'unknown_result';   // Returns ambiguous status

// Configured via environment variable or runtime config
PROCESSOR_FAILURE_MODE=timeout
PROCESSOR_DELAY_MS=15000
```

The simulator enables deterministic testing of all failure paths without requiring a real payment processor or network chaos.

---

## Partial Failure: The Dual-Write Problem

The most insidious failure is when one write succeeds and another fails:

```
Scenario: DB commit succeeds, Kafka publish fails

Without the outbox pattern:
  ✅ payment status = SUCCEEDED (in DB)
  ❌ payment.succeeded event not published to Kafka
  ❌ Webhook never fires
  ❌ Merchant never notified
  ❌ Ledger never updated (if ledger update is via event consumption)
```

PayFlow solves this with the **transactional outbox pattern**: the Kafka event is written to the `outbox_events` table in the same database transaction as the payment status update. If the transaction commits, both the payment update and the outbox event are guaranteed to exist. The outbox worker then reliably publishes to Kafka.

```
With the outbox pattern:
  ✅ payment status = SUCCEEDED (in DB)
  ✅ outbox_event = {type: 'payment.succeeded', ...} (in DB, same transaction)
  → Outbox worker publishes to Kafka (retried until successful)
  ✅ Webhook fires
  ✅ Merchant notified
```

See [`outbox-pattern.md`](./outbox-pattern.md) for full details.

---

## Infrastructure Failure: Redis Unavailable

Redis serves multiple functions in PayFlow:

| Function | On Redis Failure |
|---|---|
| API response caching | Cache miss → serve from DB. Increased DB load but correct results. |
| Rate limiting | ThrottlerGuard may fail open (depends on error handling config) — acceptable degradation |
| Idempotency in-flight lock | Falls back to DB-only path. In-flight detection is slower but correctness is maintained via DB UNIQUE constraint |

**The golden rule:** Redis unavailability causes performance degradation, not data corruption. PostgreSQL is the source of truth.

---

## Infrastructure Failure: Kafka Unavailable

```
Scenario: Kafka cluster is down during payment processing

Step 1: Payment is created and status = SUCCEEDED (DB committed)
Step 2: outbox_event row inserted (same DB transaction)
Step 3: Outbox worker tries to publish to Kafka → fails
Step 4: outbox_event status = FAILED, attempts++, scheduled_for = now() + backoff
Step 5: Outbox worker retries according to backoff schedule
Step 6: Kafka recovers → outbox worker publishes all pending events
```

**Merchant impact:** Webhooks are delayed by the duration of the Kafka outage. Payments still succeed and are recorded correctly. When Kafka recovers, all pending events are published in order.

**Key property:** Payment correctness is not dependent on Kafka availability. Kafka is in the notification path, not the transaction path.

---

## Circuit Breaker (Future Enhancement)

If the processor is returning errors for extended periods, PayFlow should stop sending requests and fast-fail new payments rather than consuming threads with requests that will time out:

```
Normal:  Payment → Processor (succeeds)
Degraded: Payment → Processor (fails 50% of the time) → slow, retries
Circuit Open: Payment → immediate FAILED (processor is down, skip the call)
```

This prevents resource exhaustion and gives the processor time to recover. Not implemented in the initial PayFlow version, but the `ProcessorService` abstraction makes this a drop-in addition.

---

## Error Response Format

All PayFlow errors follow a consistent format:

```json
{
  "statusCode": 409,
  "code": "INVALID_STATE_TRANSITION",
  "message": "Cannot transition payment from SUCCEEDED to CANCELLED",
  "timestamp": "2026-09-11T13:30:00.000Z",
  "path": "/api/v1/payments/pay_abc123/cancel",
  "requestId": "req_xyz789"
}
```

The `code` field is a machine-readable string that clients can use to programmatically handle specific error cases without string-matching on `message`.

All PayFlow-specific exceptions extend `PayFlowException`:

```typescript
// src/common/exceptions/payflow.exception.ts
export class PayFlowException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus,
  ) {
    super({ code, message }, status);
  }
}

// Usage:
throw new PayFlowException(
  'INVALID_STATE_TRANSITION',
  `Cannot transition from ${from} to ${to}`,
  HttpStatus.CONFLICT,
);
```

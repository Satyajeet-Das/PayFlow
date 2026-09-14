# Payment Lifecycle

## Overview

Every payment in PayFlow goes through a strictly controlled lifecycle defined by a **finite state machine**. No code can arbitrarily change a payment's status — every transition must be explicitly declared as legal, and any attempt to make an illegal transition throws an `InvalidStateTransitionException`.

This document describes every state, every legal transition, and what happens at each stage.

---

## State Diagram

```
                        ┌─────────┐
                        │ CREATED │ ◀── Initial state on payment creation
                        └────┬────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              │
        ┌─────────┐    ┌───────────┐       │
        │CANCELLED│    │PROCESSING │       │
        └─────────┘    └─────┬─────┘       │
          (terminal)         │             │
                   ┌─────────┼──────────┐  │
                   │         │          │  │
                   ▼         ▼          ▼  │
            ┌──────────┐ ┌──────┐ ┌───────────────┐
            │REQUIRES_ │ │FAILED│ │    UNKNOWN     │
            │ ACTION   │ └──────┘ │ (processor     │
            └────┬─────┘(terminal)│  uncertainty)  │
                 │               └───────┬───────┘
         ┌───────┼───────┐              │
         │       │       │        Reconciliation
         ▼       ▼       │        worker queries
     ┌───────┐ ┌──────┐  │        processor
     │PROCESS│ │FAILED│  │              │
     │  ING  │ └──────┘  │      ┌──────┴──────┐
     └───┬───┘(terminal) │      ▼             ▼
         │               │  ┌──────┐      ┌──────┐
         ▼               │  │SUCC- │      │FAILED│
      ┌──────────┐        │  │EEDED │      └──────┘
      │SUCCEEDED │◀───────┘  └──┬───┘    (terminal)
      └────┬─────┘             │
           │              ┌────┘
           ▼              │
    ┌──────────────┐       │
    │REFUND_PENDING│◀──────┘ (refund requested)
    └──────┬───────┘
           │
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌──────────┐
│REFUNDED│  │SUCCEEDED │ (refund failed — payment not refunded)
└────────┘  └──────────┘
(terminal)
```

---

## State Definitions

### `CREATED`
**What it means:** A payment record has been created in the database. Risk scoring has passed (or been skipped). The payment has not yet been sent to the processor.

**How you get here:** `POST /v1/payments` — after idempotency check and risk check both pass.

**Ledger entries created:**
```
DEBIT  CUSTOMER_FUNDS   amount   (customer's money reserved)
CREDIT CLEARING         amount   (funds in transit)
```

**Valid next states:** `PROCESSING`, `CANCELLED`

---

### `PROCESSING`
**What it means:** The payment has been submitted to the processor. We are waiting for a response.

**How you get here:** Automatically after CREATED when `ProcessorService.charge()` is called.

**Important:** The system must set the status to `PROCESSING` and persist it **before** calling the processor. If the application crashes during the processor call, the reconciliation worker can detect the in-flight state and query the processor.

**Valid next states:** `REQUIRES_ACTION`, `SUCCEEDED`, `FAILED`, `UNKNOWN`

---

### `REQUIRES_ACTION`
**What it means:** The processor requires additional authentication from the customer (e.g., 3D Secure challenge, OTP verification). The payment is paused waiting for the customer.

**How you get here:** Processor returns a redirect URL or challenge token.

**Valid next states:** `PROCESSING` (customer completes action), `FAILED` (customer abandons), `CANCELLED`

---

### `SUCCEEDED`
**What it means:** The processor has confirmed the payment. Money has moved. This is a financially significant terminal event.

**How you get here:** Processor returns a success response.

**Ledger entries created:**
```
DEBIT  CLEARING          amount         (clearing resolved)
CREDIT MERCHANT_PAYABLE  amount - fee   (merchant receives funds minus fee)
CREDIT REVENUE_FEES      fee            (PayFlow takes its cut)
```

**Valid next states:** `REFUND_PENDING`

---

### `FAILED`
**What it means:** The processor has definitively rejected the payment. The customer's card was declined, insufficient funds, expired card, etc.

**How you get here:** Processor returns an explicit failure response.

**Ledger entries created:**
```
DEBIT  CLEARING          amount   (reversal of the initial debit)
CREDIT CUSTOMER_FUNDS    amount   (money returned to customer)
```

**Valid next states:** None (terminal)

---

### `CANCELLED`
**What it means:** The payment was cancelled before it reached the processor. No money moved. No charge was attempted.

**How you get here:** `POST /v1/payments/:id/cancel` — only valid from `CREATED` or `REQUIRES_ACTION`.

**Ledger entries created:** Same reversal as `FAILED`.

**Valid next states:** None (terminal)

---

### `UNKNOWN`
**What it means:** The processor call timed out or the network response was lost. **We do not know whether the charge succeeded or failed.** This is the most dangerous state in payment systems.

**Why this state exists:** If a payment processor charges a card and the HTTP response is lost before reaching our application, we cannot assume failure. Retrying would potentially double-charge the customer. Assuming success would leave us with unreconciled funds. The only correct response is to acknowledge uncertainty and resolve it later.

**How you get here:** `ProcessorService.charge()` throws a `TimeoutException` or network error.

**Valid next states:** `SUCCEEDED`, `FAILED`, `CANCELLED` (all via reconciliation worker only)

See [`failure-handling.md`](./failure-handling.md) and [`reconciliation.md`](./reconciliation.md) for the full story.

---

### `REFUND_PENDING`
**What it means:** A refund has been requested and submitted to the processor. We are waiting for confirmation.

**How you get here:** `POST /v1/payments/:id/refund`

**Valid next states:** `REFUNDED`, `SUCCEEDED` (if refund fails, payment returns to succeeded)

---

### `REFUNDED`
**What it means:** The refund has been confirmed by the processor. Funds have been returned to the customer.

**Ledger entries created:**
```
DEBIT  MERCHANT_PAYABLE  refund_amount   (merchant's balance reduced)
CREDIT CUSTOMER_FUNDS    refund_amount   (funds returned to customer)
```

**Valid next states:** None (terminal)

---

## Legal Transitions Table

```typescript
// src/modules/payments/payments.state-machine.ts
export const LEGAL_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED:          ['PROCESSING', 'CANCELLED'],
  PROCESSING:       ['REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'UNKNOWN'],
  REQUIRES_ACTION:  ['PROCESSING', 'FAILED', 'CANCELLED'],
  SUCCEEDED:        ['REFUND_PENDING'],
  FAILED:           [],
  CANCELLED:        [],
  UNKNOWN:          ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  REFUND_PENDING:   ['REFUNDED', 'SUCCEEDED'],
  REFUNDED:         [],
};
```

### Terminal States
`FAILED`, `CANCELLED`, `REFUNDED` — no further transitions are ever possible.

### Why Explicit Transitions?
Without an explicit map, a developer could write `payment.status = 'SUCCEEDED'` in any service method and it would work. With the state machine, every status update goes through:

```typescript
export function assertValidTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidStateTransitionException(from, to);
  }
}
```

This makes illegal transitions a runtime exception rather than a silent data corruption.

---

## Payment Attempt Tracking

Every time the processor is called, a `payment_attempt` record is created:

```
payment_id        → which payment
attempt_number    → 1, 2, 3... (for retries)
processor_request → what we sent (JSON)
processor_response→ what we received (JSON, or null on timeout)
status            → PENDING | SUCCESS | FAILED | TIMEOUT | UNKNOWN
duration_ms       → how long the call took
```

This provides a complete audit trail of all processor interactions, which is essential for:
- Debugging failed payments
- Reconciliation (knowing which processor reference ID to query)
- Detecting processor-side issues (high latency, elevated error rates)

---

## Concurrency: Preventing Race Conditions on Transitions

Two requests cannot simultaneously transition the same payment. This is enforced by an optimistic lock:

```sql
UPDATE payments
SET status = $newStatus, updated_at = now()
WHERE id = $paymentId
  AND status = $expectedCurrentStatus   -- Optimistic lock
RETURNING *;
```

If zero rows are returned, the expected status did not match — another request already transitioned the payment. The service throws a `409 Conflict`.

See [`concurrency.md`](./concurrency.md) for the full concurrency model.

---

## Refund Rules

1. A refund can only be requested if the payment is `SUCCEEDED`
2. The refund amount must be ≤ the original payment amount
3. The refund amount must be ≤ the remaining refundable amount (payment.amount - sum of previous refunds)
4. Partial refunds are supported
5. Multiple partial refunds are supported until the full amount is refunded
6. Each refund requires its own `Idempotency-Key` header

---

## API Reference

| Endpoint | Valid From States | Response |
|---|---|---|
| `POST /v1/payments` | — (creates CREATED) | 201 PaymentDto |
| `POST /v1/payments/:id/cancel` | CREATED, REQUIRES_ACTION | 200 PaymentDto |
| `POST /v1/payments/:id/refund` | SUCCEEDED | 200 RefundDto |
| `GET /v1/payments/:id` | Any | 200 PaymentDto |

### Cancel Behavior
If a cancel is requested on a terminal state (`SUCCEEDED`, `FAILED`, `CANCELLED`, `REFUNDED`), the API returns `409 Conflict` with:
```json
{
  "statusCode": 409,
  "code": "INVALID_STATE_TRANSITION",
  "message": "Cannot transition payment from SUCCEEDED to CANCELLED"
}
```

### Idempotency on Cancels and Refunds
Both cancel and refund endpoints require an `Idempotency-Key`. This prevents double-refunds if the network fails after the refund is processed but before the client receives the response.

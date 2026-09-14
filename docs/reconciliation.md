# Reconciliation

## Purpose

Reconciliation is the process of resolving the gap between what PayFlow's database says happened and what the payment processor says happened. This gap appears when the processor successfully processes a payment but the HTTP response never reaches PayFlow (due to network failure, timeout, or application crash).

Reconciliation answers the question: **"For every payment we believe is UNKNOWN, what did the processor actually do?"**

---

## When Reconciliation is Needed

```
Normal flow (reconciliation not needed):
  PayFlow → processor.charge() → response received → payment SUCCEEDED/FAILED

Abnormal flow (reconciliation required):
  PayFlow → processor.charge() → [timeout] → payment UNKNOWN
  PayFlow → processor.charge() → [app crash] → payment stuck in PROCESSING
  Processor → responds late → PayFlow already timed out → payment UNKNOWN
```

---

## The Reconciliation Worker

The worker runs as a NestJS scheduled job (`@Cron`) every 60 seconds inside the application process:

```typescript
// src/modules/reconciliation/reconciliation.worker.ts

@Injectable()
export class ReconciliationWorker {
  @Cron('0 * * * * *')  // Every 60 seconds
  async run(): Promise<void> {
    const run = await this.reconciliationService.startRun();

    try {
      const unknownPayments = await this.paymentsRepository.findByStatus(
        PaymentStatus.UNKNOWN,
        { olderThanMinutes: 2 },  // Give processor time to finalize
      );

      for (const payment of unknownPayments) {
        await this.resolvePayment(payment, run);
      }

      await this.reconciliationService.completeRun(run.id, {
        checked: unknownPayments.length,
        resolved: run.resolved,
        failed: run.failed,
      });

    } catch (error) {
      await this.reconciliationService.failRun(run.id, error.message);
    }
  }
}
```

---

## Resolution Algorithm

For each UNKNOWN payment:

```typescript
async resolvePayment(payment: Payment, run: ReconciliationRun): Promise<void> {
  try {
    // 1. Query the processor for the current status
    const processorStatus = await this.processor.getPayment(
      payment.processorPaymentId
    );

    // 2. Map processor status to our state machine
    switch (processorStatus.status) {
      case 'SUCCEEDED':
        await this.resolveAsSucceeded(payment);
        run.resolved++;
        break;

      case 'FAILED':
        await this.resolveAsFailed(payment, processorStatus.errorCode);
        run.resolved++;
        break;

      case 'PENDING':
      case 'UNKNOWN':
        // Processor doesn't know yet either — leave as UNKNOWN, try next cycle
        this.logger.warn({
          event: 'reconciliation.still_unknown',
          paymentId: payment.id,
          processorPaymentId: payment.processorPaymentId,
          ageMs: Date.now() - payment.createdAt.getTime(),
        });
        break;
    }

  } catch (error) {
    // Processor unavailable — log and continue to next payment
    // Do NOT mark as FAILED — we still don't know the status
    this.logger.error({
      event: 'reconciliation.processor_error',
      paymentId: payment.id,
      error: error.message,
    });
    run.failed++;
  }
}
```

---

## Resolving as SUCCEEDED

```typescript
async resolveAsSucceeded(payment: Payment): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    // 1. Transition state machine
    await tx.$executeRaw`
      UPDATE payments
      SET status = 'SUCCEEDED',
          succeeded_at = now(),
          updated_at = now()
      WHERE id = ${payment.id}
        AND status = 'UNKNOWN'
    `;

    // 2. Write ledger settlement entries
    await this.ledgerService.recordPaymentSuccess(tx, payment);

    // 3. Write outbox event so merchants are notified
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventType: 'payment.succeeded',
        payload: buildPaymentSucceededEvent(payment),
      },
    });
  });

  this.logger.log({
    event: 'reconciliation.resolved_succeeded',
    paymentId: payment.id,
    merchantId: payment.merchantId,
  });
}
```

---

## Resolving as FAILED

```typescript
async resolveAsFailed(payment: Payment, errorCode: string): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    // 1. Transition state machine
    await tx.$executeRaw`
      UPDATE payments
      SET status = 'FAILED',
          failure_code = ${errorCode},
          failed_at = now(),
          updated_at = now()
      WHERE id = ${payment.id}
        AND status = 'UNKNOWN'
    `;

    // 2. Reverse ledger entries (refund customer)
    await this.ledgerService.recordPaymentFailure(tx, payment);

    // 3. Write outbox event
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventType: 'payment.failed',
        payload: buildPaymentFailedEvent(payment, errorCode),
      },
    });
  });
}
```

---

## What if the Payment Has No processorPaymentId?

This happens when the payment crashed or timed out **before** the processor generated an ID — meaning the request may not have reached the processor at all.

```
Scenario A: Request timed out before reaching processor
  → processor never charged the customer
  → processorPaymentId is null
  → We CAN safely assume FAILED

Scenario B: Request reached processor but response lost
  → processorPaymentId exists (returned in early response)
  → Cannot safely assume anything

Implementation:
  if (payment.processorPaymentId === null) {
    // No evidence the processor received the request
    await this.resolveAsFailed(payment, 'PROCESSOR_UNREACHABLE');
  } else {
    // Query processor by ID
    const status = await this.processor.getPayment(payment.processorPaymentId);
    ...
  }
```

---

## Handling Long-UNKNOWN Payments

If a payment remains UNKNOWN for more than 24 hours, something has gone seriously wrong:
- The processor may no longer have a record of the charge
- The `processorPaymentId` may be invalid
- Manual intervention may be required

```typescript
// Escalation alert
if (payment.ageHours > 24 && payment.status === 'UNKNOWN') {
  await this.alertingService.critical({
    alert: 'PAYMENT_STUCK_UNKNOWN',
    paymentId: payment.id,
    merchantId: payment.merchantId,
    ageHours: payment.ageHours,
  });
}
```

---

## Reconciliation Run Tracking

Every reconciliation run is recorded in `reconciliation_runs`:

```sql
SELECT
  id,
  started_at,
  completed_at,
  payments_checked,
  payments_resolved,
  payments_failed,
  status
FROM reconciliation_runs
ORDER BY started_at DESC
LIMIT 20;
```

This provides:
- Operational visibility into reconciliation health
- Historical record of how many UNKNOWN payments are being resolved per run
- A signal that processor reliability is degrading (increasing UNKNOWN rate)

---

## Testing Reconciliation

The reconciliation flow is tested with the following scenario:

```typescript
describe('Reconciliation', () => {
  it('resolves UNKNOWN → SUCCEEDED when processor returns success', async () => {
    // 1. Create payment with processor in 'timeout' mode
    processor.setMode('timeout');
    const { body } = await createPayment();
    const paymentId = body.data.id;

    // Payment should be UNKNOWN
    expect(body.data.status).toBe('UNKNOWN');

    // 2. Switch processor to return success for this payment
    processor.setPaymentStatus(paymentId, 'SUCCEEDED');

    // 3. Run reconciliation
    await reconciliationWorker.run();

    // 4. Verify payment is now SUCCEEDED
    const payment = await getPayment(paymentId);
    expect(payment.status).toBe('SUCCEEDED');

    // 5. Verify ledger is balanced
    const balance = await getLedgerBalance();
    expect(balance.debits).toBe(balance.credits);

    // 6. Verify outbox event was created
    const events = await getOutboxEvents(paymentId);
    expect(events).toContainEqual(
      expect.objectContaining({ eventType: 'payment.succeeded' })
    );
  });
});
```

---

## Reconciliation vs. Manual Resolution

The reconciliation worker handles the automated case. For rare situations requiring manual resolution (very long-UNKNOWN payments, processor disputes), the admin interface provides:

```
POST /api/v1/internal/payments/:id/resolve
  Body: { status: 'SUCCEEDED' | 'FAILED', reason: 'manual reconciliation', operatorId: '...' }
  Auth: JWT + ADMIN
```

This endpoint:
1. Validates the resolution makes sense (payment must be UNKNOWN)
2. Applies the transition atomically with ledger entries
3. Writes an audit log entry recording who made the decision and why
4. Creates the appropriate outbox event

Manual resolutions are always logged in `audit_logs` with the operator's ID and reason.

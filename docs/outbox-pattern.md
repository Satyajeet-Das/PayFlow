# Outbox Pattern

## The Problem: Unreliable Dual-Write

The most common naive approach to publishing events after a database write:

```typescript
// DANGEROUS — do not do this
async createPayment(data: CreatePaymentDto): Promise<Payment> {
  const payment = await this.prisma.payment.create({ data });

  // If this crashes, event is never published
  // If Kafka is down, event is never published
  // These two operations are NOT atomic
  await this.kafkaProducer.publish('payment.created', payment);

  return payment;
}
```

The problem: the database commit and the Kafka publish are two separate operations with no atomicity guarantee. If the process crashes, the network fails, or Kafka is unavailable between the two operations, the event is permanently lost.

**Lost events mean:**
- Merchants never receive webhooks
- Analytics dashboards have gaps
- Audit trails are incomplete
- The system is in an inconsistent state with no way to detect it

---

## The Solution: Transactional Outbox

Instead of publishing to Kafka directly, write the event to a database table (`outbox_events`) **in the same database transaction** as the payment update. A separate background worker reliably reads from this table and publishes to Kafka.

```
Payment Status Update ──┐
                         ├── Single DB Transaction ──→ COMMIT
Outbox Event Insert  ───┘

                              ↓ (after commit)

                    Outbox Worker (every 5s)
                              ↓
                    Read PENDING outbox events
                              ↓
                    Publish to Kafka
                              ↓
                    Mark as PUBLISHED
```

The key insight: **if the transaction commits, both the payment update and the outbox event are guaranteed to exist in the database.** If the transaction rolls back, neither exists. There is no window where one exists and the other doesn't.

---

## Database Schema

```sql
CREATE TABLE outbox_events (
  id              TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,        -- 'payment', 'refund'
  aggregate_id    TEXT NOT NULL,        -- payment_id, refund_id
  event_type      TEXT NOT NULL,        -- 'payment.succeeded', 'payment.failed'
  payload         JSONB NOT NULL,       -- Full event payload
  status          outbox_status NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now()   -- enables delayed retry
);

-- Worker queries this index constantly
CREATE INDEX outbox_pending_idx
  ON outbox_events(status, scheduled_for)
  WHERE status IN ('PENDING', 'FAILED');
```

---

## Writing to the Outbox

Events are written in the same transaction as the state change that caused them:

```typescript
// payments.service.ts
async markPaymentSucceeded(payment: Payment): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    // 1. Transition payment state
    await tx.$executeRaw`
      UPDATE payments
      SET status = 'SUCCEEDED', succeeded_at = now()
      WHERE id = ${payment.id} AND status = 'PROCESSING'
    `;

    // 2. Write ledger entries
    await this.ledgerService.recordPaymentSuccess(tx, payment);

    // 3. Write outbox event — SAME TRANSACTION
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'payment',
        aggregateId: payment.id,
        eventType: 'payment.succeeded',
        payload: {
          event_id: randomUUID(),
          event_type: 'payment.succeeded',
          aggregate_id: payment.id,
          merchant_id: payment.merchantId,
          timestamp: new Date().toISOString(),
          version: 1,
          data: {
            payment_id: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            status: 'SUCCEEDED',
          },
        },
      },
    });
    // If ANYTHING above fails → entire transaction rolls back
    // → outbox event NOT written → no event ever published
    // → safe. Client retries. New transaction.
  });
}
```

---

## The Outbox Worker

```typescript
// src/modules/outbox/outbox.worker.ts

@Injectable()
export class OutboxWorker {
  @Cron('*/5 * * * * *')  // Every 5 seconds
  async processBatch(): Promise<void> {
    // Use FOR UPDATE SKIP LOCKED to safely run multiple workers concurrently
    const events = await this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<OutboxEvent[]>`
        SELECT * FROM outbox_events
        WHERE status IN ('PENDING', 'FAILED')
          AND scheduled_for <= now()
        ORDER BY created_at ASC
        LIMIT 100
        FOR UPDATE SKIP LOCKED
      `;
    });

    if (events.length === 0) return;

    this.logger.log({
      event: 'outbox.processing_batch',
      count: events.length,
    });

    await Promise.allSettled(
      events.map(event => this.publishEvent(event))
    );
  }

  private async publishEvent(event: OutboxEvent): Promise<void> {
    try {
      await this.kafkaProducer.publish(
        this.getTopicForEvent(event.eventType),
        event.payload,
        { key: event.aggregateId }  // Same aggregate on same partition → ordered
      );

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'PUBLISHED',
          processedAt: new Date(),
        },
      });

    } catch (error) {
      const nextAttempt = this.calculateBackoff(event.attempts + 1);

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: event.attempts >= 4 ? 'FAILED' : 'PENDING',
          attempts: { increment: 1 },
          lastError: error.message,
          scheduledFor: nextAttempt,
        },
      });

      this.logger.error({
        event: 'outbox.publish_failed',
        outboxEventId: event.id,
        eventType: event.eventType,
        attempts: event.attempts + 1,
        nextAttempt,
        error: error.message,
      });
    }
  }

  private calculateBackoff(attemptNumber: number): Date {
    const delayMs = Math.min(
      1000 * Math.pow(2, attemptNumber),  // Exponential: 2s, 4s, 8s, 16s, 32s
      5 * 60 * 1000,                       // Cap at 5 minutes
    );
    return new Date(Date.now() + delayMs);
  }
}
```

---

## Kafka Topic Assignment

Events are published to topics based on their type:

```typescript
// src/modules/events/events.producer.ts

const TOPIC_MAP: Record<string, string> = {
  'payment.created':    'payflow.payments',
  'payment.processing': 'payflow.payments',
  'payment.succeeded':  'payflow.payments',
  'payment.failed':     'payflow.payments',
  'payment.unknown':    'payflow.payments',
  'payment.refunded':   'payflow.payments',
};

// Kafka message key = aggregateId (payment_id)
// This ensures all events for the same payment go to the same partition
// → events for a single payment are always consumed in order
```

---

## At-Least-Once vs. Exactly-Once

The outbox pattern guarantees **at-least-once delivery**. This means:

- An event will eventually be published ✅
- An event may be published more than once ⚠️

The second point happens when:
- The worker publishes to Kafka successfully
- The worker crashes before marking the event as `PUBLISHED`
- On restart, the worker publishes the event again

**This is expected and correct.** Kafka consumers handle duplicates by checking `event_id` idempotency:

```typescript
// Kafka consumer (example: webhook consumer)
async handleEvent(event: PayFlowEvent): Promise<void> {
  // Check if already processed
  const alreadyProcessed = await this.redis.sismember(
    'processed_events',
    event.event_id
  );

  if (alreadyProcessed) {
    this.logger.log({
      event: 'consumer.duplicate_skipped',
      eventId: event.event_id,
    });
    return;
  }

  // Process the event
  await this.processEvent(event);

  // Mark as processed
  await this.redis.sadd('processed_events', event.event_id);
  await this.redis.expire('processed_events', 86400 * 7); // 7 day TTL
}
```

---

## Failure Scenarios and Outcomes

| Scenario | Outcome |
|---|---|
| App crashes before DB transaction commits | Transaction rolls back. No outbox event. Payment not changed. Client retries safely. |
| App crashes after DB commit, before worker runs | Outbox event exists in DB with status=PENDING. Worker picks it up on next run. ✅ |
| Worker crashes mid-batch | Unprocessed events remain PENDING (row lock released on crash). Next worker run processes them. ✅ |
| Kafka is down for 1 hour | Events accumulate in outbox_events. No data loss. When Kafka recovers, backlog is processed. |
| Kafka recovers after 1 hour of downtime | Events published in order (within partition). Consumers process backlog. |
| Worker publishes to Kafka twice | Consumers detect duplicate event_id and skip. Idempotent processing. ✅ |
| outbox_events grows very large | Purge PUBLISHED events older than 30 days. Add monitoring alert if PENDING count > 10,000. |

---

## Monitoring the Outbox

The outbox lag (number of PENDING events) is a key operational metric:

```sql
-- Current outbox lag by status
SELECT status, COUNT(*) as count
FROM outbox_events
GROUP BY status;

-- Events stuck in FAILED (need attention)
SELECT * FROM outbox_events
WHERE status = 'FAILED'
ORDER BY created_at DESC;

-- Events older than 10 minutes that are still PENDING (worker might be down)
SELECT COUNT(*) FROM outbox_events
WHERE status = 'PENDING'
  AND created_at < now() - INTERVAL '10 minutes';
```

A Prometheus metric `payflow_outbox_lag_events` exposes the PENDING count for alerting.

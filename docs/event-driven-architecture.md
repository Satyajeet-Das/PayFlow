# Event-Driven Architecture

## Why Events?

Payment processing produces a stream of meaningful state changes: a payment succeeds, a refund is initiated, a reconciliation resolves an UNKNOWN payment. Multiple parts of the system need to react to these events:

- **Webhook worker** — notify the merchant's endpoint
- **Analytics** — update real-time metrics dashboards
- **Audit system** — record state changes for compliance
- **Ledger** — record financial movements
- **Risk engine** — update behavioral models

Without an event bus, each of these would require direct coupling to the payment service. The payment service would need to know about the webhook worker, the analytics system, and every other consumer. Adding a new consumer would require modifying the payment service.

With Kafka, the payment service publishes one event. Any number of consumers can subscribe without the payment service knowing they exist. This is the **open/closed principle applied to system architecture**.

---

## Kafka in the PayFlow Architecture

```
Payment State Change
        │
        ▼ (in DB transaction)
  outbox_events table
        │
        ▼ (every 5 seconds)
  Outbox Worker
        │
        ▼ (publish)
  Kafka Broker
        │
        ├──▶ payflow.payments topic
        │         │
        │         ├──▶ [Consumer Group: webhooks]
        │         │         → Creates webhook deliveries
        │         │
        │         ├──▶ [Consumer Group: analytics]
        │         │         → Updates metrics dashboards
        │         │
        │         └──▶ [Consumer Group: audit]
        │                   → Records audit log entries
        │
        └──▶ payflow.payments.dlq topic
                  (dead-letter queue for failed events)
```

---

## Event Schema

All PayFlow events follow a consistent envelope:

```typescript
// src/modules/events/schemas/payflow-event.schema.ts

interface PayFlowEvent {
  // Metadata
  event_id:       string;   // UUID — unique per event (for consumer idempotency)
  event_type:     string;   // e.g. 'payment.succeeded'
  schema_version: number;   // For schema evolution (start at 1)

  // Routing
  aggregate_type: string;   // 'payment' | 'refund'
  aggregate_id:   string;   // payment_id or refund_id
  merchant_id:    string;

  // Timing
  timestamp:      string;   // ISO 8601

  // Payload — event-specific data
  data:           Record<string, unknown>;
}
```

### Example: `payment.succeeded`

```json
{
  "event_id": "evt_01j9k2m3n4p5q6r7s8t9u0v1",
  "event_type": "payment.succeeded",
  "schema_version": 1,
  "aggregate_type": "payment",
  "aggregate_id": "pay_01j9k2m3n4p5q6r7s8t9u0v1",
  "merchant_id": "mer_abc123",
  "timestamp": "2026-09-11T13:45:23.000Z",
  "data": {
    "payment_id": "pay_01j9k2m3n4p5q6r7s8t9u0v1",
    "amount": 100000,
    "currency": "INR",
    "previous_status": "PROCESSING",
    "customer_id": "cus_xyz789",
    "description": "Order #4521 payment",
    "metadata": {
      "order_id": "ord_4521"
    }
  }
}
```

### Event Types

| Event Type | Trigger |
|---|---|
| `payment.created` | New payment created (status: CREATED) |
| `payment.processing` | Payment submitted to processor |
| `payment.succeeded` | Processor confirmed success |
| `payment.failed` | Processor returned failure |
| `payment.unknown` | Processor call timed out |
| `payment.cancelled` | Payment cancelled by merchant |
| `payment.refund_pending` | Refund submitted to processor |
| `payment.refunded` | Refund confirmed |

---

## Topic Design

```
Topics:
  payflow.payments          ← All payment lifecycle events
  payflow.payments.dlq      ← Events that failed after all retries

Partitioning:
  Key: payment_id (aggregate_id)
  → All events for the same payment go to the same partition
  → Consumers see events for a given payment in order
  → Parallelism: different payments processed by different partition-consumers

Replication:
  replication.factor: 3     ← Tolerate 2 broker failures
  min.insync.replicas: 2    ← At least 2 replicas must confirm before ack
```

### Why Partition by payment_id?

```
Without partitioning by payment_id:
  payment.processing (partition 0) ← processed first by consumer A
  payment.succeeded  (partition 1) ← processed first by consumer B
  Consumer A and B race → out-of-order processing

With partitioning by payment_id:
  payment.processing → partition 3 ← consumer C processes
  payment.succeeded  → partition 3 ← consumer C processes AFTER
  Same consumer, same partition → correct order guaranteed
```

---

## Kafka Producer

```typescript
// src/modules/events/events.producer.ts

@Injectable()
export class EventsProducer {
  private producer: KafkaJS.Producer;

  async publish(
    topic: string,
    event: PayFlowEvent,
    options?: { key?: string },
  ): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{
        key: options?.key ?? event.aggregate_id,
        value: JSON.stringify(event),
        headers: {
          'event-type': event.event_type,
          'event-id': event.event_id,
          'schema-version': String(event.schema_version),
        },
        timestamp: String(Date.now()),
      }],
    });
  }
}
```

**Producer configuration for durability:**
```typescript
const producer = kafka.producer({
  // Wait for all in-sync replicas to acknowledge
  // Prevents data loss if the leader broker fails after ack
  acks: -1,

  // Retry configuration
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },

  // Enable idempotent producer
  // Prevents Kafka-side duplicates from producer retries
  idempotent: true,
});
```

---

## Kafka Consumer (Webhook Worker)

```typescript
// src/modules/webhooks/webhooks.consumer.ts

@Injectable()
export class WebhooksConsumer implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    const consumer = this.kafka.consumer({
      groupId: 'payflow-webhooks',
    });

    await consumer.subscribe({
      topics: ['payflow.payments'],
      fromBeginning: false,
    });

    await consumer.run({
      // Process one batch at a time (backpressure control)
      eachBatchAutoResolve: false,

      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        for (const message of batch.messages) {
          const event = JSON.parse(message.value!.toString()) as PayFlowEvent;

          // Idempotent processing — check event_id before acting
          await this.processEvent(event);

          // Commit this offset only after successful processing
          resolveOffset(message.offset);

          // Keep consumer group alive during slow processing
          await heartbeat();
        }
      },
    });
  }

  private async processEvent(event: PayFlowEvent): Promise<void> {
    // Idempotency check
    const processed = await this.redis.sismember('processed_events', event.event_id);
    if (processed) return;

    // Create webhook deliveries for all subscribed endpoints
    await this.webhooksService.createDeliveriesForEvent(event);

    // Mark as processed
    await this.redis.sadd('processed_events', event.event_id);
    await this.redis.expire('processed_events', 7 * 24 * 3600); // 7 days
  }
}
```

---

## Consumer Group Strategy

Each logical consumer type has its own consumer group:

```
Consumer Group: payflow-webhooks
  → Processes events to create webhook deliveries
  → Each partition handled by one consumer in the group
  → Can scale by adding more consumers (up to partition count)

Consumer Group: payflow-analytics
  → Updates real-time metrics
  → Idempotent processing (same event processed twice = same metric)

Consumer Group: payflow-audit
  → Writes audit log entries
  → Idempotent (duplicate event_id → skip)
```

**Why separate consumer groups?** Each group maintains its own offset. The webhook worker's processing lag does not affect the analytics worker's progress. Groups can be at different points in the topic history.

---

## Schema Evolution

When event schemas change:

1. **Additive changes only** (new fields) — consumers ignore unknown fields. No `schema_version` bump needed.
2. **Breaking changes** (field renamed/removed) — bump `schema_version`. Maintain backward-compatible consumers until all consumers are updated.

```typescript
// Consumer handles multiple schema versions
if (event.schema_version === 1) {
  return this.handleV1(event);
} else if (event.schema_version === 2) {
  return this.handleV2(event);
}
```

---

## What Happens if Kafka is Unavailable?

See [`outbox-pattern.md`](./outbox-pattern.md) for full details.

Short version:
1. Events accumulate in `outbox_events` table (safe, in PostgreSQL)
2. Payments still succeed/fail/get processed normally
3. Merchants experience webhook delays proportional to the Kafka downtime
4. When Kafka recovers, outbox worker publishes the accumulated backlog
5. Consumers process the backlog in order

**Payment correctness is never dependent on Kafka availability.** Kafka is in the notification path, not the transaction path.

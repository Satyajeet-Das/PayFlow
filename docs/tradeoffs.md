# Tradeoffs

## Why These Choices Were Made

Every architectural decision is a tradeoff. This document explains the reasoning behind PayFlow's major decisions — not just what was chosen, but why the alternatives were rejected.

---

## Why PostgreSQL, Not a NoSQL Database?

**Financial data requires ACID transactions.** Consider what happens during a payment:

```
BEGIN;
  UPDATE payments SET status = 'SUCCEEDED';
  INSERT INTO ledger_entries (DEBIT clearing, CREDIT merchant_payable);
  INSERT INTO outbox_events (...);
COMMIT;
```

All three operations must either all succeed or all fail. If the process crashes between the `UPDATE` and the `INSERT`, the ledger is wrong. ACID isolation prevents this.

NoSQL databases (MongoDB, DynamoDB, Cassandra) sacrifice ACID for scalability. This is the right tradeoff for user preferences, product catalogs, or session storage. It is the **wrong** tradeoff for financial data.

Additionally, PostgreSQL's `UNIQUE` constraints, `FOR UPDATE SKIP LOCKED`, and `CHECK` constraints are essential to PayFlow's concurrency model. These are not available in most NoSQL systems.

**The tradeoff we accept:** PostgreSQL does not scale horizontally as easily as DynamoDB. At the scale PayFlow targets (~1000 RPS), a well-tuned single PostgreSQL instance handles the load comfortably. Sharding is a problem for after product-market fit.

---

## Why Modular Monolith, Not Microservices?

The goal is to demonstrate correctness under failure, not to maximize operational complexity.

**What microservices would add:**
- Network calls between services (new failure mode)
- Distributed tracing (required to understand cross-service failures)
- Service discovery (Consul, Kubernetes DNS)
- API contracts between services (versioning, compatibility)
- Independent deployment (but also independent failures)

**What microservices would NOT add at this stage:**
- Better correctness guarantees
- Easier reasoning about state
- Simpler testing

**The modular monolith achieves the same logical separation** (clear module boundaries, no cross-module direct DB access) without the operational overhead.

**When would microservices be justified?**
- When different parts of the system need to scale at different rates (e.g., the webhook worker needs 100x more capacity than the payment API)
- When different teams own different parts and need independent deployment
- When modules have legitimately different availability requirements

None of these apply to a single-team project at this stage. The module boundaries in PayFlow are preserved so extraction to microservices is a mechanical step, not an architectural redesign.

---

## Why Kafka, Not HTTP Webhooks or a Simple Queue?

Three alternatives were considered:

**Alternative 1: Direct HTTP from payment service to webhook worker**
```
PaymentsService.succeed() → WebhookService.notify()
```
Problem: Tight coupling. Slow merchant endpoints slow down payment processing. Webhook worker crashes take down payment creation.

**Alternative 2: Redis pub/sub**
- Redis pub/sub is fire-and-forget — if a consumer is down when the event is published, the event is lost.
- Redis pub/sub has no persistence. A Redis restart loses all in-flight messages.
- **Not suitable for payment events which must be durably delivered.**

**Alternative 3: Database-backed queue (polling)**
```
Webhook worker polls webhook_deliveries every second
```
This is actually what PayFlow does for the final delivery step (webhook deliveries are queued in PostgreSQL). But for the event pipeline (payment → multiple consumers), a DB queue has N-consumer fan-out complexity.

**Why Kafka wins:**
- Durable (replication factor 3, `acks: -1`)
- Replayable (consumers can re-read old events)
- Multiple independent consumer groups (webhooks, analytics, audit) read the same topic without interfering
- Ordered per payment (partition by payment_id)

**The tradeoff we accept:** Kafka adds operational complexity. You need Zookeeper (or KRaft), topic management, and consumer group monitoring. For a small team, this is real cost. It is justified because Kafka provides durability and fan-out that no alternative achieves cleanly.

---

## Why Transactional Outbox, Not Direct Kafka Publish?

```
// Why not just:
await prisma.payment.update({ ... });
await kafkaProducer.publish('payment.succeeded', event);
```

Because if the process crashes between line 1 and line 2:
- Payment is SUCCEEDED in the DB
- Event is never published
- Merchant never receives webhook
- Analytics never updated
- Ledger may not be updated (if it's event-driven)

This is the **dual-write problem**. There is no reliable solution without either:
1. A distributed transaction (2PC) across the DB and Kafka — extremely complex and slow
2. Outbox pattern — write the event to the DB in the same transaction, publish asynchronously

The outbox pattern is the established solution used by Debezium, all Saga-pattern implementations, and payment companies like Stripe.

**The tradeoff we accept:** Events are eventually published (within seconds) rather than immediately. This is acceptable for webhook delivery but would not be acceptable if consumers needed real-time results for the synchronous API response.

---

## Why BIGINT for Monetary Amounts?

**The wrong choice: JavaScript `number`**
```javascript
0.1 + 0.2  // 0.30000000000000004 — wrong
```

**The less wrong choice: DECIMAL(15,2) in PostgreSQL**
This is what the existing `transactions` table uses and it's fine for personal finance. However, when you move amounts to application code as JavaScript numbers, precision can be lost.

**The right choice for payments: BIGINT (integer paise/cents)**
```
₹100.50 → stored as 10050 (paise)
₹0.01  → stored as 1 (paise)
```

Integer arithmetic has no precision issues. `10050 + 1 = 10051` exactly, always.

**The tradeoff we accept:** All amounts must be divided by 100 for display. API clients must send amounts in the smallest unit. This is the same convention used by Stripe, Razorpay, and every other payment API.

---

## Why At-Least-Once Delivery, Not Exactly-Once?

Exactly-once delivery across distributed systems requires:
- Idempotent producers (✅ KafkaJS supports `idempotent: true`)
- Transactional Kafka consumers (complex, not all consumer languages support it well)
- Two-phase commit across Kafka and the consumer's database

The complexity of exactly-once is not worth it when you can make consumers idempotent. An idempotent consumer + at-least-once delivery achieves the same correctness guarantee with lower complexity.

**At-least-once + idempotent consumers = effectively exactly-once behavior**

Every PayFlow consumer checks `event_id` before processing. Duplicate delivery is detected and skipped. The system behaves as if exactly-once were guaranteed.

**The tradeoff we accept:** Maintaining the processed event ID set (in Redis) has a cost. Redis TTL (7 days) means events replayed after 7 days would be processed again. This is an acceptable window for any reasonable Kafka replay scenario.

---

## Why No Refresh Tokens (Yet)?

The existing system configures `JWT_REFRESH_SECRET` in `.env` and validates it via Joi, but there is no refresh token endpoint implemented. This is a **known gap**, not a deliberate decision.

A refresh token endpoint should be added before production deployment because:
- 7-day JWT expiry means users are logged out for 7 days if their token is revoked
- Refresh tokens allow short-lived access tokens (15 minutes) with longer-lived refresh tokens (30 days)
- Short access token expiry limits the damage of token theft

This was not part of the initial personal finance system requirements and is not in the critical path for PayFlow's payment infrastructure demonstration.

---

## Why Rule-Based Risk, Not ML?

**ML-based fraud detection requires:**
1. Labeled training data (payments labeled as fraudulent/legitimate)
2. Feature engineering (velocity, device fingerprint, graph analysis)
3. Model serving infrastructure
4. Model retraining pipeline
5. Explanation/interpretability for compliance

None of this exists yet. Building ML without data is not ML — it is guessing with extra steps.

**Rule-based risk has real advantages:**
- Deterministic and testable — same input always produces same output
- Explainable — "declined because amount > ₹500,000 and customer age < 30 days"
- Immediately deployable
- Easy to tune — change thresholds without retraining

The rule-based engine is designed with a `RiskRule` interface so ML models can be plugged in later as additional rules. The architecture does not need to change when ML is introduced.

---

## Why Keep the Personal Finance Module?

When I reviewed the codebase, I considered removing the personal finance layer (transactions, dashboard) entirely and replacing it with payment infrastructure. This would have been a mistake.

**Reasons to keep it:**
1. The RBAC system (VIEWER/ANALYST/ADMIN) becomes more valuable with PayFlow, not less — ADMIN users now operate the infrastructure
2. Removing working, tested code to replace it with equivalent functionality is waste
3. The `User` model (with roles) and `Merchant` model serve genuinely different audiences and should coexist

**The one naming tension:** The existing `Transaction` model (personal finance records) shares the word "transaction" with what a payment processor calls a transaction. In code they are completely separate (different tables, modules, services). The only risk is cognitive — engineers new to the codebase may confuse them. This is solved by documentation and clear naming conventions (`PaymentAttempt` not `PaymentTransaction`).

---

## What Would I Do Differently in a Greenfield Project?

1. **UUIDs as proper PostgreSQL `UUID` type**, not `TEXT`. The existing schema uses `TEXT` for IDs — this is functional but misses type safety at the DB level and uses slightly more storage.

2. **Event sourcing for payments** — instead of storing only the current state, store every state transition as an immutable event. This makes reconciliation and audit trivial. The tradeoff is query complexity (reconstructing current state from events). PayFlow's approach (store current state + audit log) is a pragmatic middle ground.

3. **OpenAPI spec-first development** — write the API spec before implementation so clients can be developed in parallel.

4. **Dedicated test database** in docker-compose — the current setup requires manual database URL switching for tests. A separate `test_finance_db` in docker-compose would make this automatic.

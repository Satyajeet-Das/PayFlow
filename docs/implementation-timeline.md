# PayFlow — Implementation Timeline

> **Project:** Evolving Finance Dashboard → PayFlow  
> **Total Estimated Time:** 8–10 weeks (solo engineer, full-time)  
> **Stack:** NestJS 11 · TypeScript · Prisma 7 · PostgreSQL 16 · Redis 7 · Kafka · Jest  
> **Approach:** Build incrementally. Every phase ends with a working, testable system.

---

## Reading This Document

Each phase has:
- **Goal** — what the system can do after this phase
- **Prerequisites** — what must be done before starting
- **Tasks** — exact files to create or modify, in order
- **Tests** — what must pass before moving to next phase
- **Definition of Done** — how you know the phase is complete

> ⚠️ Do NOT skip Phase 0. Two of its fixes are correctness bugs (data leak + broken Prisma URL), not cosmetic improvements.

---

## Phase 0 — Pre-Flight Fixes
**Duration:** 1–2 days  
**Goal:** Fix existing bugs. No new features. All existing tests still pass.

### Prerequisites
- None. Start here.

---

### Task 0.1 — Fix Prisma Schema URL
**File:** [`prisma/schema.prisma`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/prisma/schema.prisma)

The `url` line is commented out. This breaks `prisma migrate dev` and `prisma studio`.

```diff
datasource db {
  provider = "postgresql"
- // url      = env("DATABASE_URL")
+ url      = env("DATABASE_URL")
}
```

After fix, regenerate client:
```bash
npx prisma generate
```

---

### Task 0.2 — Fix Dashboard Cache Key Collision (Data Privacy Bug)
**File:** [`src/modules/dashboard/dashboard.controller.ts`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/src/modules/dashboard/dashboard.controller.ts)

**The bug:** NestJS `CacheInterceptor` uses the request URL as the cache key. Two different users hitting `GET /api/v1/dashboard/summary` share the same Redis key — User B sees User A's financial data.

**Fix:** Override `CacheInterceptor` to include `userId` in the cache key:

Create `src/common/interceptors/user-scoped-cache.interceptor.ts`:
```typescript
import { CacheInterceptor, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class UserScopedCacheInterceptor extends CacheInterceptor {
  trackBy(context: ExecutionContext): string | undefined {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id ?? 'anonymous';
    const baseKey = super.trackBy(context);
    return baseKey ? `${baseKey}:user:${userId}` : undefined;
  }
}
```

Replace `CacheInterceptor` with `UserScopedCacheInterceptor` in `dashboard.controller.ts`.

---

### Task 0.3 — Fix Dockerfile CMD Path
**File:** [`Dockerfile`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/Dockerfile)

```diff
- CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
+ CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
```

---

### Task 0.4 — Add PayFlowException Base Class
**New file:** `src/common/exceptions/payflow.exception.ts`

```typescript
import { HttpException, HttpStatus } from '@nestjs/common';

export class PayFlowException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus,
  ) {
    super({ code, message }, status);
  }
}
```

**Modify:** `src/common/filters/http-exception.filter.ts`  
Add `code` field extraction from `PayFlowException` responses so all error responses include a machine-readable `code`.

---

### Task 0.5 — Wire Prisma Query Events to Logger
**File:** `src/common/database/prisma.service.ts`

Add after `$connect()`:
```typescript
this.$on('query', (e) => {
  this.logger.debug({
    event: 'db.query',
    query: e.query,
    duration_ms: e.duration,
  });
});
```

---

### Task 0.6 — Add Idempotency-Key to CORS Allowed Headers
**File:** [`src/main.ts`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/src/main.ts)

```diff
allowedHeaders: [
  'Content-Type',
  'Authorization',
  'X-Request-Id',
+ 'Idempotency-Key',
],
```

---

### Phase 0 Tests
```bash
npm run test          # All existing unit tests must still pass
npm run test:e2e      # Auth E2E tests must still pass
```

### Phase 0 Definition of Done
- [ ] `npx prisma migrate dev` works without error
- [ ] `npx prisma studio` connects to the database
- [ ] All 12 existing tests pass
- [ ] Dashboard returns different cached data for different users (manual verification)
- [ ] Error responses include `code` field

---

## Phase 1 — Payment Foundation
**Duration:** 5–7 days  
**Goal:** Merchants exist. API keys work. Payments can be created and cancelled. State machine enforced.

### Prerequisites
- Phase 0 complete and all tests passing

---

### Task 1.1 — Database Migration (Merchants + Customers + Payments)

Create migration: `prisma migrate dev --name add_payment_foundation`

New tables in this migration:
- `merchants` (id, name, email, status, created_at, updated_at, deleted_at)
- `api_keys` (id, merchant_id, key_hash, key_prefix, name, last_used_at, expires_at, revoked_at)
- `customers` (id, merchant_id, external_id, email, name, metadata, created_at, UNIQUE merchant_id+external_id)
- `payments` (id, merchant_id, customer_id, amount BIGINT, currency, status payment_status enum, description, metadata, processor_payment_id, risk_score, risk_decision, failure_code, failure_message, created/updated/succeeded/failed/cancelled/refunded at)
- `payment_attempts` (id, payment_id, attempt_number, processor_request JSONB, processor_response JSONB, status, error_code, duration_ms, created_at, completed_at)

New PostgreSQL enums:
- `payment_status` — CREATED, PROCESSING, REQUIRES_ACTION, SUCCEEDED, FAILED, CANCELLED, UNKNOWN, REFUND_PENDING, REFUNDED

---

### Task 1.2 — Merchants Module

**New files:**
```
src/modules/merchants/
├── merchants.module.ts
├── merchants.controller.ts     ← CRUD, JWT + ADMIN auth
├── merchants.service.ts
├── merchants.repository.ts
└── dto/
    ├── create-merchant.dto.ts
    └── merchant-response.dto.ts
```

Key endpoint: `POST /api/v1/merchants` — creates merchant, generates first API key, returns raw key **once**.

---

### Task 1.3 — API Key Guard

**New file:** `src/common/guards/api-key.guard.ts`

- Extracts `Authorization: Bearer sk_live_xxx` header
- Computes SHA-256 of the raw key
- Looks up `api_keys` table by `key_hash`
- Attaches `request.merchant` on success
- Returns 401 if not found, revoked, or expired

**New decorator:** `src/common/decorators/current-merchant.decorator.ts`

---

### Task 1.4 — Payment State Machine

**New file:** `src/modules/payments/payments.state-machine.ts`

```typescript
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

export function assertValidTransition(from: PaymentStatus, to: PaymentStatus): void { ... }
```

Also add `InvalidStateTransitionException` extending `PayFlowException`.

---

### Task 1.5 — Processor Simulator (Phase 1 version — success only)

**New files:**
```
src/modules/processor/
├── processor.interface.ts      ← PaymentProcessor interface
├── simulator.processor.ts      ← Always returns success
└── processor.module.ts
```

---

### Task 1.6 — Payments Module

**New files:**
```
src/modules/payments/
├── payments.module.ts
├── payments.controller.ts
├── payments.service.ts
├── payments.repository.ts
├── payments.state-machine.ts
└── dto/
    ├── create-payment.dto.ts
    ├── payment-response.dto.ts
    └── payment-query.dto.ts
```

**Endpoints in this phase:**
- `POST /v1/payments` — create (no idempotency yet, added Phase 2)
- `GET  /v1/payments/:id`
- `GET  /v1/payments`
- `POST /v1/payments/:id/cancel`

Auth: `@Public()` + `@UseGuards(MerchantApiKeyGuard)`

---

### Task 1.7 — Register New Modules in AppModule

**Modify:** `src/app.module.ts`

Add `MerchantsModule`, `CustomersModule`, `PaymentsModule`, `ProcessorModule` to imports.

---

### Phase 1 Tests

```
Unit tests:
  payments.state-machine.spec.ts
    ✓ All legal transitions succeed
    ✓ All illegal transitions throw InvalidStateTransitionException
    ✓ FAILED is terminal (no transitions out)
    ✓ CANCELLED is terminal

  payments.service.spec.ts
    ✓ create() returns payment with status CREATED
    ✓ cancel() on CREATED → CANCELLED
    ✓ cancel() on SUCCEEDED → throws

  api-key.guard.spec.ts
    ✓ Valid key → attaches merchant
    ✓ Invalid key → 401
    ✓ Revoked key → 401
    ✓ Expired key → 401

E2E tests:
  payments.e2e-spec.ts
    ✓ POST /v1/payments → 201
    ✓ GET  /v1/payments/:id → 200
    ✓ POST /v1/payments/:id/cancel (CREATED) → 200, status=CANCELLED
    ✓ POST /v1/payments/:id/cancel (CANCELLED) → 409
    ✓ POST /v1/payments/:id/cancel (no auth) → 401
```

### Phase 1 Definition of Done
- [ ] `POST /v1/payments` creates payment, returns status `CREATED`
- [ ] State machine prevents all illegal transitions with `409`
- [ ] API key authentication works end-to-end
- [ ] All state machine unit tests pass (legal + illegal coverage)
- [ ] E2E tests pass

---

## Phase 2 — Correctness & Idempotency
**Duration:** 5–7 days  
**Goal:** Duplicate requests are safe. 100 concurrent identical requests produce exactly 1 payment. Refunds work.

### Prerequisites
- Phase 1 complete

---

### Task 2.1 — Database Migration (Idempotency + Refunds)

Create migration: `prisma migrate dev --name add_idempotency_refunds`

New tables:
- `idempotency_keys` (id, merchant_id, key, request_hash, payment_id FK, status_code, response_body JSONB, locked_at, created_at, expires_at — UNIQUE merchant_id+key)
- `refunds` (id, payment_id FK, amount BIGINT, currency, status refund_status, reason, processor_refund_id, metadata, created/updated/succeeded/failed at)

New enum: `refund_status` — PENDING, SUCCEEDED, FAILED

---

### Task 2.2 — Idempotency Module

**New files:**
```
src/modules/idempotency/
├── idempotency.module.ts
├── idempotency.service.ts      ← checkOrLock(), complete(), getStoredResponse()
└── idempotency.repository.ts
```

**Service logic (4 cases):**
1. `INSERT` succeeds → new request, proceed
2. `INSERT` fails (UNIQUE) + same hash + `response_body` not null → replay stored response
3. `INSERT` fails (UNIQUE) + different hash → `IdempotencyConflictException` (409)
4. `INSERT` fails (UNIQUE) + `response_body` null (locked_at set) → in-flight (409)

---

### Task 2.3 — Wire Idempotency into Payments

**Modify:** `src/modules/payments/payments.controller.ts`

Extract `Idempotency-Key` header. Return 400 if missing. Pass to `PaymentsService`.

**Modify:** `src/modules/payments/payments.service.ts`

```
create():
  1. checkOrLock(merchantId, idempotencyKey, bodyHash)
  2. If replay → return stored response
  3. If conflict → throw
  4. Process payment
  5. complete(idempotencyKey, 201, paymentResponse)
     — in the SAME DB transaction as payment creation
```

---

### Task 2.4 — Refund Endpoint

**Add to:** `src/modules/payments/payments.controller.ts`
```
POST /v1/payments/:id/refund
Header: Idempotency-Key (required)
Body:   { amount: number, reason?: string }
```

**Add to:** `src/modules/payments/payments.service.ts`
- Validate payment is `SUCCEEDED`
- Validate refund amount ≤ original amount
- Validate no over-refunding (sum of previous refunds + this refund ≤ payment.amount)
- Create `refunds` record
- Transition payment → `REFUND_PENDING`
- Call processor refund
- Transition → `REFUNDED` or back to `SUCCEEDED` on failure

---

### Task 2.5 — Add DTO for Refund

**New file:** `src/modules/payments/dto/refund-payment.dto.ts`

---

### Phase 2 Tests

```
Unit tests:
  idempotency.service.spec.ts
    ✓ New key → proceed
    ✓ Same key + same body + completed → replay exact response
    ✓ Same key + different body → 409 conflict
    ✓ Same key + in-flight (locked, no response) → 409 in-flight

Integration test (MOST IMPORTANT):
  idempotency.concurrent.spec.ts
    ✓ 100 concurrent identical requests → exactly 1 payment
    ✓ All 100 responses have the same payment ID
    ✓ DB has exactly 1 payment record

E2E tests:
  payments.e2e-spec.ts (extended)
    ✓ Missing Idempotency-Key → 400
    ✓ Same key + same body (second request) → 200 with original payment
    ✓ Same key + different body → 409 with code IDEMPOTENCY_KEY_CONFLICT
    ✓ Refund on SUCCEEDED payment → 200
    ✓ Refund exceeding amount → 400
    ✓ Refund on FAILED payment → 409
    ✓ Duplicate refund (same idempotency key) → 200 replay
```

### Phase 2 Definition of Done
- [ ] Concurrent duplicate test passes: 100 requests → 1 payment in DB
- [ ] All 4 idempotency cases covered by unit tests
- [ ] Refund validates state, amount, and is idempotency-safe
- [ ] `Idempotency-Key` missing returns structured `400` with `code` field

---

## Phase 3 — Failure Recovery & Reconciliation
**Duration:** 5–7 days  
**Goal:** Processor failures are handled correctly. UNKNOWN payments are resolved. System never double-charges.

### Prerequisites
- Phase 2 complete

---

### Task 3.1 — Database Migration (Reconciliation Runs)

Create migration: `prisma migrate dev --name add_reconciliation`

New table:
- `reconciliation_runs` (id, started_at, completed_at, payments_checked, payments_resolved, payments_failed, error, status)

---

### Task 3.2 — Complete Processor Simulator (All Failure Modes)

**Modify:** `src/modules/processor/simulator.processor.ts`

Add `ChaosService` injection and all failure modes:
- `success` — normal
- `timeout` — `sleep(15000)` then throw `TimeoutException`
- `error` — throw `ProcessorException` with HTTP 500
- `slow` — `sleep(delay_ms)`, then success
- `unknown_result` — return `{ status: 'UNKNOWN' }`

**New file:** `src/modules/chaos/chaos.service.ts` (dev/test only)

**New file:** `src/modules/chaos/chaos.controller.ts` — `POST /v1/internal/chaos/processor`

**Modify:** `src/app.module.ts` — import `ChaosModule.register()` (conditionally)

---

### Task 3.3 — Wire Timeout Handling in Payments Service

**Modify:** `src/modules/payments/payments.service.ts`

```typescript
// Charge with timeout
try {
  const result = await Promise.race([
    this.processor.charge(request),
    sleep(10_000).then(() => { throw new TimeoutException(); }),
  ]);
  // Success path
} catch (error) {
  if (error instanceof TimeoutException) {
    await this.transitionStatus(payment.id, 'PROCESSING', 'UNKNOWN');
    // Log attempt as TIMEOUT
    return; // Return UNKNOWN payment to caller
  }
  // Other errors → FAILED
}
```

---

### Task 3.4 — Reconciliation Module

**New files:**
```
src/modules/reconciliation/
├── reconciliation.module.ts
├── reconciliation.service.ts   ← resolveAsSucceeded(), resolveAsFailed()
├── reconciliation.worker.ts    ← @Cron('0 * * * * *') — every 60s
└── reconciliation.repository.ts
```

**Worker logic:**
1. Find all `status = UNKNOWN` AND `created_at < now() - 2 minutes`
2. For each: call `processor.getPayment(processorPaymentId)`
3. Map result to `SUCCEEDED` | `FAILED` | still `UNKNOWN`
4. For `SUCCEEDED`: atomic transition + ledger entries (Phase 6 adds ledger, Phase 3 logs only)
5. Record run in `reconciliation_runs`

**Admin endpoint:** `POST /v1/internal/reconciliation/trigger` (JWT + ADMIN) — manual trigger for testing

---

### Task 3.5 — Register Reconciliation Module

**Modify:** `src/app.module.ts` — add `ReconciliationModule`, `ScheduleModule.forRoot()`

**New package:**
```bash
npm install @nestjs/schedule
```

---

### Phase 3 Tests

```
Unit tests:
  simulator.processor.spec.ts
    ✓ success mode → returns SUCCEEDED
    ✓ timeout mode → throws TimeoutException after delay
    ✓ error mode → throws ProcessorException
    ✓ unknown_result mode → returns UNKNOWN status

  reconciliation.service.spec.ts
    ✓ processor returns SUCCEEDED → payment transitions to SUCCEEDED
    ✓ processor returns FAILED → payment transitions to FAILED
    ✓ processor returns UNKNOWN → payment stays UNKNOWN
    ✓ processor throws error → logged, payment stays UNKNOWN

Integration tests:
  reconciliation.integration.spec.ts
    ✓ Full flow: charge → timeout → UNKNOWN → processor succeeds → reconciliation → SUCCEEDED
    ✓ Full flow: charge → timeout → UNKNOWN → processor fails → reconciliation → FAILED
    ✓ Reconciliation run recorded in reconciliation_runs table
    ✓ Multiple UNKNOWN payments processed in single run

Chaos tests (manual):
  ✓ Inject processor timeout → create payment → payment is UNKNOWN
  ✓ Reset processor → trigger reconciliation → payment becomes SUCCEEDED
```

### Phase 3 Definition of Done
- [ ] All processor failure modes work deterministically via chaos config
- [ ] A payment that times out becomes `UNKNOWN` (never `FAILED` from timeout alone)
- [ ] Reconciliation worker resolves `UNKNOWN` → `SUCCEEDED` or `FAILED`
- [ ] `reconciliation_runs` table records every run outcome
- [ ] Integration test for full UNKNOWN → SUCCEEDED flow passes

---

## Phase 4 — Event-Driven Architecture (Kafka + Outbox)
**Duration:** 7–10 days  
**Goal:** Payment events flow reliably through Kafka. Outbox guarantees no event loss. Consumers are idempotent.

### Prerequisites
- Phase 3 complete

---

### Task 4.1 — Add Kafka to Docker Compose

**Modify:** `docker-compose.yml`

Add `zookeeper` and `kafka` services. Add `payflow.payments` topic creation via `kafka-topics.sh`.

```bash
npm install kafkajs @nestjs/microservices
```

---

### Task 4.2 — Database Migration (Outbox Events)

Create migration: `prisma migrate dev --name add_outbox`

New table: `outbox_events` (id, aggregate_type, aggregate_id, event_type, payload JSONB, status outbox_status, attempts, last_error, created_at, processed_at, scheduled_for)

New enum: `outbox_status` — PENDING, PROCESSING, PUBLISHED, FAILED

Index: `(status, scheduled_for) WHERE status IN ('PENDING', 'FAILED')`

---

### Task 4.3 — Events Module (Kafka Producer)

**New files:**
```
src/modules/events/
├── events.module.ts
├── events.producer.ts          ← KafkaJS producer, publish(topic, event, key)
└── schemas/
    └── payment.events.ts       ← Typed event factories for each event type
```

Producer config: `acks: -1`, `idempotent: true`

---

### Task 4.4 — Outbox Module + Worker

**New files:**
```
src/modules/outbox/
├── outbox.module.ts
├── outbox.service.ts           ← writeEvent(tx, eventType, payload)
├── outbox.repository.ts        ← claimBatch() using FOR UPDATE SKIP LOCKED
└── outbox.worker.ts            ← @Cron('*/5 * * * * *')
```

**Worker:**
1. `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100`
2. For each event: publish to Kafka → mark `PUBLISHED`
3. On failure: increment `attempts`, set `scheduled_for` with backoff, set status `FAILED`

---

### Task 4.5 — Wire Outbox into Payment Service

**Modify:** `src/modules/payments/payments.service.ts`

In every DB transaction that changes payment state, also call `outboxService.writeEvent(tx, eventType, payload)`.

Events to emit:
- `payment.created` — after CREATE
- `payment.processing` — when processor called
- `payment.succeeded` — when processor confirms
- `payment.failed` — on failure
- `payment.unknown` — on timeout
- `payment.cancelled` — on cancel
- `payment.refunded` — on refund confirmed

---

### Task 4.6 — Admin Endpoint for Outbox

**Add to outbox module:** `POST /v1/internal/outbox/flush` (JWT + ADMIN) — manual trigger for testing

---

### Task 4.7 — Register New Modules

**Modify:** `src/app.module.ts` — add `EventsModule`, `OutboxModule`

---

### Phase 4 Tests

```
Integration tests:
  outbox.integration.spec.ts
    ✓ Payment created → outbox_event row inserted in SAME transaction
    ✓ Transaction rollback → outbox_event NOT inserted
    ✓ Outbox worker processes PENDING events and publishes to Kafka
    ✓ Kafka unavailable → events stay in PENDING, retried with backoff
    ✓ Worker crashes mid-batch → remaining events stay PENDING (not lost)
    ✓ FOR UPDATE SKIP LOCKED → two workers don't process same event

  consumer.idempotency.spec.ts
    ✓ Same event_id received twice → processed only once
    ✓ event_id tracked in Redis with 7-day TTL

E2E:
  ✓ POST /v1/payments → DB shows outbox_event with status PENDING
  ✓ After worker runs → outbox_event status = PUBLISHED
  ✓ Kafka message matches PayFlowEvent schema (event_id, event_type, timestamp, version)
```

### Phase 4 Definition of Done
- [ ] Every payment state change writes an outbox event in the same DB transaction
- [ ] Outbox worker publishes all pending events within 5 seconds
- [ ] Kafka unavailability does not prevent payment creation
- [ ] Consumer idempotency test passes (same event processed once)
- [ ] `outbox_events` table accumulates backlog during Kafka outage and clears on recovery

---

## Phase 5 — Webhooks
**Duration:** 5–7 days  
**Goal:** Merchants receive signed webhook notifications. Retries work. Dead-lettering after 5 failures.

### Prerequisites
- Phase 4 complete (Kafka events flowing)

---

### Task 5.1 — Database Migration (Webhooks)

Create migration: `prisma migrate dev --name add_webhooks`

New tables:
- `webhook_endpoints` (id, merchant_id FK, url, secret, events TEXT[], is_active, created_at, updated_at)
- `webhook_deliveries` (id, webhook_endpoint_id FK, event_type, payload JSONB, status webhook_delivery_status, attempts, max_attempts, next_attempt_at, last_attempt_at, last_http_status, last_response_body, last_error, idempotency_key, created_at — UNIQUE idempotency_key)

New enum: `webhook_delivery_status` — PENDING, SUCCEEDED, FAILED, DEAD

Index: `(status, next_attempt_at) WHERE status IN ('PENDING', 'FAILED')`

---

### Task 5.2 — Webhooks Module

**New files:**
```
src/modules/webhooks/
├── webhooks.module.ts
├── webhooks.controller.ts      ← CRUD for endpoints (JWT + ADMIN)
├── webhooks.service.ts         ← createDeliveriesForEvent()
├── webhooks.repository.ts
├── webhooks.signer.ts          ← HMAC-SHA256 signature generation
├── webhooks.consumer.ts        ← Kafka consumer group 'payflow-webhooks'
└── webhooks.worker.ts          ← @Cron('*/10 * * * * *')
```

---

### Task 5.3 — HMAC Signer

**File:** `src/modules/webhooks/webhooks.signer.ts`

```typescript
sign(secret: string, payload: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}
```

Headers sent: `X-PayFlow-Signature`, `X-PayFlow-Event-Type`, `X-PayFlow-Delivery-Id`

---

### Task 5.4 — Kafka Consumer

**File:** `src/modules/webhooks/webhooks.consumer.ts`

- Subscribe to `payflow.payments` topic
- Consumer group: `payflow-webhooks`
- For each event: find all active webhook endpoints for the merchant subscribed to this event type
- For each endpoint: upsert into `webhook_deliveries` (idempotency_key = `{endpointId}:{eventId}`)

---

### Task 5.5 — Delivery Worker

**File:** `src/modules/webhooks/webhooks.worker.ts`

- Claim pending deliveries with `FOR UPDATE SKIP LOCKED LIMIT 50`
- POST to webhook URL (10-second timeout)
- 2xx → `SUCCEEDED`
- Non-2xx or timeout → increment attempts, schedule next attempt with backoff
- 5 failures → `DEAD`

**Retry delays:** 0s → 5s → 30s → 5min → 30min

---

### Task 5.6 — Admin Endpoint

`GET /v1/internal/webhook-deliveries` (filter by status=DEAD)  
`POST /v1/internal/webhook-deliveries/:id/retry`

---

### Phase 5 Tests

```
Unit tests:
  webhooks.signer.spec.ts
    ✓ Signature is HMAC-SHA256 of "timestamp.payload"
    ✓ Signature verifiable by merchant with same secret
    ✓ Different timestamp → different signature

  webhooks.worker.spec.ts
    ✓ 2xx response → status SUCCEEDED
    ✓ 500 response → retry scheduled with 5s delay
    ✓ Timeout → retry scheduled
    ✓ 5 failures → status DEAD
    ✓ Retry backoff: 0s, 5s, 30s, 5min, 30min

Integration tests:
  webhooks.integration.spec.ts
    ✓ Kafka event → webhook delivery created for subscribed endpoint
    ✓ Worker delivers to mock HTTP server
    ✓ Duplicate event (same event_id) → only 1 delivery record (idempotent)
    ✓ Merchant not subscribed to event type → no delivery created
    ✓ Dead-lettered delivery → manual retry succeeds
```

### Phase 5 Definition of Done
- [ ] Merchant registers webhook endpoint via API
- [ ] `payment.succeeded` event triggers delivery to merchant URL
- [ ] Delivery signed with HMAC-SHA256 and timestamp
- [ ] 500 responses retry with correct backoff schedule
- [ ] 5 consecutive failures → status `DEAD`
- [ ] Duplicate event delivery prevented by `UNIQUE(idempotency_key)`

---

## Phase 6 — Financial Integrity (Ledger)
**Duration:** 5–7 days  
**Goal:** Every payment creates balanced double-entry ledger entries. SUM(debits) = SUM(credits) always.

### Prerequisites
- Phase 2 complete (payments fully working)

---

### Task 6.1 — Database Migration (Ledger)

Create migration: `prisma migrate dev --name add_ledger`

New tables:
- `ledger_accounts` (id, code UNIQUE, name, type account_type, normal_balance, merchant_id nullable FK)
- `ledger_transactions` (id, reference_type, reference_id, description, idempotency_key UNIQUE, created_at)
- `ledger_entries` (id, ledger_transaction_id FK, account_id FK, entry_type CHECK IN('DEBIT','CREDIT'), amount BIGINT CHECK > 0, currency)

New enums: `account_type` (ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE)

Seed system accounts: `CUSTOMER_FUNDS`, `CLEARING`, `MERCHANT_PAYABLE`, `REVENUE_FEES`

---

### Task 6.2 — Ledger Module

**New files:**
```
src/modules/ledger/
├── ledger.module.ts
├── ledger.service.ts
│   ├── recordPaymentCreated(tx, payment)
│   ├── recordPaymentSuccess(tx, payment)
│   ├── recordPaymentFailure(tx, payment)
│   └── recordRefund(tx, payment, refund)
└── ledger.repository.ts
    └── computeImbalance()   ← SUM(DEBIT) - SUM(CREDIT)
```

---

### Task 6.3 — Wire Ledger into Payment Transactions

**Modify:** `src/modules/payments/payments.service.ts`

In every state-change DB transaction, also call the appropriate `ledger.service` method:

| Payment Event | Ledger Action |
|---|---|
| CREATED | DEBIT customer_funds, CREDIT clearing |
| SUCCEEDED | DEBIT clearing, CREDIT merchant_payable + fees |
| FAILED / CANCELLED | DEBIT clearing, CREDIT customer_funds (reversal) |
| REFUNDED | DEBIT merchant_payable, CREDIT customer_funds |

All ledger entries use `idempotency_key = 'payment_success:{paymentId}'` to prevent double-posting.

---

### Task 6.4 — Invariant Verification Endpoint

`GET /v1/internal/ledger/balance` (JWT + ADMIN)

Returns `{ imbalance: 0 }` always if system is correct.

---

### Phase 6 Tests

```
Unit tests:
  ledger.service.spec.ts
    ✓ recordPaymentSuccess() creates exactly 3 entries (DEBIT clearing, CREDIT payable, CREDIT fees)
    ✓ SUM(debits) == SUM(credits) for each recording call
    ✓ Idempotent: calling twice produces same ledger (no double-post)
    ✓ recordPaymentFailure() reverses the initial CUSTOMER_FUNDS debit

Integration tests:
  ledger.integration.spec.ts
    ✓ After 1000 random payment outcomes, imbalance == 0
    ✓ Full refund: net effect on all accounts is zero
    ✓ Partial refund: correct amounts in merchant_payable and customer_funds
    ✓ Ledger entry and payment status update are atomic (rollback = both or neither)

E2E:
  ✓ GET /v1/internal/ledger/balance → { imbalance: 0 } after 100 payments
```

### Phase 6 Definition of Done
- [ ] Every payment state transition writes balanced ledger entries in the same DB transaction
- [ ] `computeImbalance()` returns `0` after any number of operations
- [ ] Invariant test with 1000 random payments passes
- [ ] Ledger entries cannot be double-posted (UNIQUE idempotency_key)

---

## Phase 7 — Risk Engine + Observability
**Duration:** 5–7 days  
**Goal:** Payments are risk-scored before processing. Prometheus metrics exposed. OpenTelemetry traces available.

### Prerequisites
- Phase 1 complete (for risk engine)
- Phase 6 complete (for metrics — all components exist)

---

### Task 7.1 — Risk Module

**New files:**
```
src/modules/risk/
├── risk.module.ts
├── risk.service.ts             ← evaluate(context): { score, decision, reasons }
├── risk.context.ts             ← RiskContext interface
└── rules/
    ├── high-amount.rule.ts     ← score += 30 if amount > 500_000
    ├── velocity.rule.ts        ← score += 40 if > 10 payments in 1 minute
    ├── failed-attempts.rule.ts ← score += 25 if > 3 failed in last hour
    └── new-customer.rule.ts    ← score += 15 if customer age < 7 days
```

**Decision thresholds:**
- Score 0–39 → `allow`
- Score 40–69 → `review` (allow but flag)
- Score 70–100 → `decline` → 422 response, payment not created

---

### Task 7.2 — Wire Risk into Payments Service

**Modify:** `src/modules/payments/payments.service.ts`

Before creating payment: call `riskService.evaluate()`. If `decline`, throw `RiskDeclinedException`. Update idempotency key with 422 response.

Store `risk_score` and `risk_decision` on the payment record.

---

### Task 7.3 — Observability Module

**New packages:**
```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
npm install @opentelemetry/instrumentation-http @opentelemetry/instrumentation-pg
npm install prom-client @willsoto/nestjs-prometheus
```

**New files:**
```
src/modules/observability/
├── observability.module.ts
├── metrics.service.ts          ← All Prometheus counters/histograms/gauges
└── tracing.bootstrap.ts        ← OpenTelemetry SDK init (called before NestJS bootstrap)
```

**Modify:** `src/main.ts` — import `tracing.bootstrap.ts` at top (before any other imports)

**New endpoint:** `GET /metrics` — Prometheus scrape endpoint (no auth, restrict by IP in production)

---

### Task 7.4 — Wire Metrics into Services

Add metric calls at key points:
- `PaymentsService` → increment `payflow_payments_total` on each status transition
- `ProcessorService` → record `payflow_processor_latency_seconds`
- `OutboxWorker` → update `payflow_outbox_lag_events` gauge after each batch
- `WebhooksWorker` → increment `payflow_webhook_deliveries_total`

---

### Task 7.5 — Health Check Extension

**Modify:** `src/modules/health/health.controller.ts`

Add Kafka connectivity check alongside existing DB and Redis checks.

---

### Phase 7 Tests

```
Unit tests:
  risk.service.spec.ts
    ✓ High amount → high score, decline decision
    ✓ Multiple failed attempts → elevated score
    ✓ Normal payment → low score, allow decision
    ✓ Score ≥ 70 → 422 with reasons array

  metrics.service.spec.ts
    ✓ GET /metrics returns valid Prometheus text format
    ✓ payflow_payments_total increments on payment creation

E2E:
  ✓ High-amount payment → 422 with { code: 'RISK_DECLINED', reasons: ['high_amount'] }
  ✓ Normal payment → passes risk check, proceeds normally
```

### Phase 7 Definition of Done
- [ ] Risk score stored on every payment record
- [ ] High-score payments declined with structured 422 response
- [ ] `GET /metrics` returns Prometheus metrics
- [ ] `payflow_payments_total`, `payflow_processor_latency_seconds` populated
- [ ] OpenTelemetry traces show full request path for `POST /v1/payments`
- [ ] Health check includes Kafka status

---

## Phase 8 — Chaos Testing + Load Testing
**Duration:** 3–5 days  
**Goal:** Prove correctness under failure. Establish performance baseline. Identify real bottlenecks.

### Prerequisites
- Phase 7 complete (full system)

---

### Task 8.1 — Complete Chaos Module

Add remaining chaos targets:
- `POST /v1/internal/chaos/kafka` — disconnect/reconnect Kafka
- `POST /v1/internal/chaos/webhook-endpoint` — force specific endpoint to 500/timeout
- `POST /v1/internal/chaos/database` — add artificial query latency

---

### Task 8.2 — Run Chaos Scenarios

Execute each scenario from [`docs/failure-injection.md`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/docs/failure-injection.md):

- **Scenario 1:** Processor timeout → UNKNOWN → reconciliation → SUCCEEDED ✓
- **Scenario 2:** Kafka down → outbox accumulates → Kafka recovers → events flush ✓
- **Scenario 3:** Webhook endpoint down → retries → dead-letter → manual retry ✓
- **Scenario 4:** 100 concurrent identical requests → 1 payment ✓

Document results.

---

### Task 8.3 — Load Testing

Install k6:
```bash
choco install k6
```

Create test scripts (see [`docs/load-testing.md`](file:///c:/VS%20Code/MY%20Backend%20APIs/PayFlow/docs/load-testing.md)):
- `tests/load/payment-creation.js` — 100 RPS, 5 minutes
- `tests/load/idempotency-concurrent.js` — 100 concurrent identical requests
- `tests/load/mixed-workload.js` — 500 RPS, mixed read/write

Run baseline:
```bash
k6 run tests/load/payment-creation.js
```

Measure: p50, p95, p99 latency, error rate, throughput.

---

### Task 8.4 — Bottleneck Analysis + Optimization

After measuring, identify and fix the bottleneck (likely DB connection pool or missing index):

```sql
-- Run during load test:
SELECT query, calls, mean_exec_time FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 10;

SELECT count(*), state FROM pg_stat_activity
WHERE datname = 'finance_db' GROUP BY state;
```

Apply one fix at a time. Re-measure. Do not optimize blindly.

---

### Phase 8 Tests

```
Chaos tests (all must produce correct outcomes):
  ✓ Scenario 1 — UNKNOWN → reconciliation → SUCCEEDED
  ✓ Scenario 2 — Kafka outage → recovery (zero event loss)
  ✓ Scenario 3 — Webhook failures → dead-letter → manual retry
  ✓ Scenario 4 — 100 concurrent → 1 payment

Load tests:
  ✓ 100 RPS: p95 < 500ms, error rate < 0.1%
  ✓ DB ledger imbalance = 0 after load test

Correctness verification (run after each load test):
  ✓ SELECT COUNT(*) = COUNT(DISTINCT id) FROM payments (no duplicates)
  ✓ Ledger imbalance = 0
  ✓ No payments stuck in PROCESSING
```

### Phase 8 Definition of Done
- [ ] All 4 chaos scenarios produce correct outcomes (documented with evidence)
- [ ] Load test at 100 RPS: p95 < 500ms, errors < 0.1%
- [ ] Ledger balanced after load test
- [ ] Bottleneck identified (not guessed) via pg_stat_statements
- [ ] At least one optimization applied and measured

---

## Project Definition of Done

The complete PayFlow project is done when **all of the following pass:**

### Correctness (Non-Negotiable)
- [ ] 100 concurrent identical requests → exactly 1 payment (idempotency test)
- [ ] SUM(ledger debits) == SUM(ledger credits) after 10,000 operations (ledger invariant)
- [ ] No illegal state transitions possible via any API call (state machine)
- [ ] UNKNOWN payment → reconciliation → correct resolution (never stuck, never double-charged)

### Failure Recovery
- [ ] Kafka outage → zero payment event loss (outbox accumulates, publishes on recovery)
- [ ] Processor timeout → UNKNOWN (not FAILED) → reconciliation resolves
- [ ] Webhook 5 failures → dead-lettered (not infinite retry)
- [ ] App crash during processing → payment resolved correctly on restart

### API Quality
- [ ] All endpoints documented in Swagger with examples
- [ ] `Idempotency-Key` required on all mutating endpoints
- [ ] All errors include machine-readable `code` field
- [ ] Existing personal finance API unchanged and all tests still passing

### Observability
- [ ] `GET /metrics` returns all required Prometheus metrics
- [ ] OpenTelemetry trace for `POST /v1/payments` shows all steps
- [ ] Every payment log includes `payment_id`, `merchant_id`, `request_id`

### Security
- [ ] API keys stored as SHA-256 hashes
- [ ] Webhook payloads signed with HMAC-SHA256
- [ ] Rate limiting per merchant (not just global)

### Testing
- [ ] State machine: all legal + all illegal transitions covered
- [ ] Idempotency: concurrent test (100 VUs)
- [ ] Reconciliation: UNKNOWN flow integration test
- [ ] Ledger: balance invariant test (1000 payments)
- [ ] Webhooks: retry + dead-letter flow

---

## Quick Reference: File Creation Order

```
Phase 0 (2 days):
  MODIFY  prisma/schema.prisma
  NEW     src/common/interceptors/user-scoped-cache.interceptor.ts
  NEW     src/common/exceptions/payflow.exception.ts
  MODIFY  src/common/filters/http-exception.filter.ts
  MODIFY  src/common/database/prisma.service.ts
  MODIFY  src/main.ts
  MODIFY  Dockerfile

Phase 1 (5-7 days):
  NEW     prisma/migrations/..._add_payment_foundation/
  NEW     src/modules/merchants/ (5 files)
  NEW     src/common/guards/api-key.guard.ts
  NEW     src/common/decorators/current-merchant.decorator.ts
  NEW     src/modules/processor/ (3 files)
  NEW     src/modules/payments/ (6 files)
  MODIFY  src/app.module.ts

Phase 2 (5-7 days):
  NEW     prisma/migrations/..._add_idempotency_refunds/
  NEW     src/modules/idempotency/ (3 files)
  MODIFY  src/modules/payments/payments.controller.ts
  MODIFY  src/modules/payments/payments.service.ts
  NEW     src/modules/payments/dto/refund-payment.dto.ts

Phase 3 (5-7 days):
  NEW     prisma/migrations/..._add_reconciliation/
  MODIFY  src/modules/processor/simulator.processor.ts
  NEW     src/modules/chaos/ (2 files)
  MODIFY  src/modules/payments/payments.service.ts
  NEW     src/modules/reconciliation/ (4 files)
  MODIFY  src/app.module.ts

Phase 4 (7-10 days):
  NEW     prisma/migrations/..._add_outbox/
  MODIFY  docker-compose.yml
  NEW     src/modules/events/ (3 files)
  NEW     src/modules/outbox/ (4 files)
  MODIFY  src/modules/payments/payments.service.ts
  MODIFY  src/app.module.ts

Phase 5 (5-7 days):
  NEW     prisma/migrations/..._add_webhooks/
  NEW     src/modules/webhooks/ (7 files)
  MODIFY  src/app.module.ts

Phase 6 (5-7 days):
  NEW     prisma/migrations/..._add_ledger/
  NEW     src/modules/ledger/ (3 files)
  MODIFY  src/modules/payments/payments.service.ts
  MODIFY  prisma/seed.ts (add system ledger accounts)

Phase 7 (5-7 days):
  NEW     src/modules/risk/ (6 files)
  NEW     src/modules/observability/ (3 files)
  MODIFY  src/modules/payments/payments.service.ts
  MODIFY  src/modules/health/health.controller.ts
  MODIFY  src/main.ts

Phase 8 (3-5 days):
  NEW     tests/load/ (3 k6 scripts)
  MODIFY  src/modules/chaos/chaos.controller.ts (extend)
```

# PayFlow System Architecture

## Overview

PayFlow is a **reliable financial infrastructure system** built as a modular monolith with asynchronous workers. It evolved from a personal finance dashboard into a production-grade payment processing backend capable of handling duplicate requests, concurrency, partial failures, asynchronous events, processor uncertainty, webhook failures, and financial reconciliation.

The project demonstrates that the hardest problems in financial systems are not algorithmic — they are about **correctness under failure**, and that correctness requires careful design of state machines, database constraints, idempotency, and event delivery.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PayFlow NestJS Monolith                             │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  EXISTING: Personal Finance Layer (JWT + RBAC)                         │ │
│  │                                                                         │ │
│  │  ┌─────────┐  ┌─────────┐  ┌──────────────┐  ┌────────────────────┐  │ │
│  │  │  auth   │  │  users  │  │ transactions │  │     dashboard      │  │ │
│  │  │ (JWT)   │  │ (ADMIN) │  │ (INCOME/EXP) │  │ (Redis cached)     │  │ │
│  │  └─────────┘  └─────────┘  └──────────────┘  └────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  NEW: Payment Processing Layer (Merchant API Keys)                     │ │
│  │                                                                         │ │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │ │
│  │  │merchants │  │  idempotency │  │   payments   │  │   processor  │  │ │
│  │  │customers │  │ (UNIQUE key) │  │ (state mach) │  │ (simulator)  │  │ │
│  │  └──────────┘  └──────────────┘  └──────────────┘  └──────────────┘  │ │
│  │                                                                         │ │
│  │  ┌──────────┐  ┌──────────────┐  ┌──────────────┐                     │ │
│  │  │   risk   │  │    ledger    │  │reconciliation│                     │ │
│  │  │ (rules)  │  │(double-entry)│  │  (UNKNOWN→)  │                     │ │
│  │  └──────────┘  └──────────────┘  └──────────────┘                     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  NEW: Event Pipeline (Asynchronous)                                    │ │
│  │                                                                         │ │
│  │  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────┐  │ │
│  │  │  outbox  │────▶│  kafka   │────▶│ webhooks │────▶│  merchant    │  │ │
│  │  │ (write-  │     │ (events) │     │ (HMAC    │     │  endpoint    │  │ │
│  │  │  ahead)  │     │          │     │  signed) │     │              │  │ │
│  │  └──────────┘     └──────────┘     └──────────┘     └──────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  In-Process Workers (@Cron)                                            │ │
│  │  outbox-worker (5s)  │  reconciliation-worker (1min)  │  webhook-     │ │
│  │                      │                                 │  worker (10s) │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘

Infrastructure:
  PostgreSQL 16  ← Source of truth for ALL financial state (ACID)
  Redis 7        ← Caching, idempotency locks, rate limiting
  Kafka          ← Async event bus (at-least-once, replayable)
```

---

## Module Responsibilities

### Existing Modules (Personal Finance Layer)

| Module | Responsibility | Auth |
|---|---|---|
| `auth` | JWT login, profile retrieval | Public (login) / JWT |
| `users` | User lifecycle (create, deactivate, role management) | JWT + ADMIN |
| `transactions` | Personal finance records (INCOME/EXPENSE) | JWT + RBAC |
| `dashboard` | Analytics, trends, category breakdown | JWT + RBAC |
| `health` | Liveness probe (DB + Redis + Kafka) | Public |

### New Modules (Payment Infrastructure Layer)

| Module | Responsibility | Auth |
|---|---|---|
| `merchants` | Merchant registration, API key issuance | JWT + ADMIN |
| `customers` | Customer entity management | Merchant API Key |
| `payments` | Payment lifecycle, state machine, refunds | Merchant API Key |
| `idempotency` | Idempotency key store, duplicate detection | Internal service |
| `processor` | Payment processor abstraction + simulator | Internal service |
| `risk` | Rule-based risk scoring, decline decisions | Internal service |
| `ledger` | Double-entry accounting, financial invariants | Internal service |
| `outbox` | Transactional outbox table + publish worker | Internal + Worker |
| `events` | Kafka producer, typed event schemas | Internal service |
| `webhooks` | Webhook endpoints, HMAC signing, delivery worker | JWT + ADMIN / Worker |
| `reconciliation` | UNKNOWN payment resolution worker | Worker |
| `observability` | Prometheus metrics, OpenTelemetry traces | Internal |

---

## Authentication Architecture

Two parallel authentication models coexist without conflict:

```
Request arrives at PayFlow
        │
        ▼
  Is route @Public()?
  ├─ Yes → Allow (health, login)
  └─ No  ↓
        │
  Does request have Authorization: Bearer sk_*?
  ├─ Yes → MerchantApiKeyGuard → lookup api_keys table → merchant context
  └─ No  ↓
        │
  JwtAuthGuard → validate JWT → user context
        │
  ActiveUserGuard → check user.status === ACTIVE
        │
  RolesGuard → check @Roles() metadata
```

### Why Two Auth Models?

The existing personal finance system has **internal users** (employees of the company running PayFlow) who authenticate with email/password and have organizational roles (VIEWER/ANALYST/ADMIN).

The new payment infrastructure has **external merchants** (businesses using PayFlow to process their customers' payments). These merchants authenticate with API keys, not passwords. They have no concept of VIEWER/ANALYST — they see only their own data.

This is the same model used by real payment companies:
- Stripe: employees use SSO, merchants use `sk_live_*` API keys
- PayPal: internal users vs merchant credentials

---

## Data Flow: Payment Creation

```
POST /v1/payments
  │
  ├─ 1. MerchantApiKeyGuard validates API key
  │       └─ Sets request.merchant on context
  │
  ├─ 2. ThrottlerGuard checks per-merchant rate limit
  │
  ├─ 3. ValidationPipe validates CreatePaymentDto
  │
  ├─ 4. PaymentsController → PaymentsService.create()
  │
  ├─ 5. IdempotencyService.checkOrLock(merchantId, idempotencyKey, bodyHash)
  │       ├─ New key → proceed
  │       ├─ Existing key + same body → return stored response
  │       └─ Existing key + different body → 409 Conflict
  │
  ├─ 6. RiskService.evaluate(payment) → score + decision
  │       └─ decision=decline → 422 (no payment created, idempotency updated)
  │
  ├─ 7. DB Transaction:
  │       ├─ INSERT INTO payments (status=CREATED)
  │       ├─ INSERT INTO payment_attempts (attempt_number=1)
  │       ├─ INSERT INTO ledger_entries (DEBIT customer, CREDIT clearing)
  │       └─ UPDATE idempotency_keys (payment_id=..., response_body=...)
  │
  ├─ 8. ProcessorService.charge() → async, with timeout
  │       ├─ Success  → payment SUCCEEDED, ledger settled
  │       ├─ Failure  → payment FAILED
  │       └─ Timeout  → payment UNKNOWN (reconciliation will resolve)
  │
  ├─ 9. DB Transaction (status update):
  │       ├─ UPDATE payments SET status=...
  │       └─ INSERT INTO outbox_events (payment.succeeded/failed/unknown)
  │
  └─ 10. Return PaymentResponseDto
```

---

## Directory Structure

```
src/
├── main.ts                           ← Bootstrap
├── app.module.ts                     ← Root module wiring
├── config/                           ← Typed config factories
│   ├── app.config.ts
│   ├── database.config.ts
│   ├── jwt.config.ts
│   ├── redis.config.ts
│   └── kafka.config.ts               ← NEW (Phase 4)
├── common/
│   ├── database/
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   ├── current-merchant.decorator.ts  ← NEW
│   │   ├── public.decorator.ts
│   │   └── roles.decorator.ts
│   ├── dto/
│   │   └── pagination.dto.ts
│   ├── exceptions/
│   │   ├── payflow.exception.ts           ← NEW base class
│   │   ├── invalid-state-transition.exception.ts
│   │   └── idempotency-conflict.exception.ts
│   ├── filters/
│   │   └── http-exception.filter.ts       ← MODIFIED
│   ├── guards/
│   │   ├── jwt-auth.guard.ts
│   │   ├── active-user.guard.ts
│   │   ├── roles.guard.ts
│   │   └── api-key.guard.ts               ← NEW
│   └── interceptors/
│       ├── request-id.interceptor.ts
│       └── transform.interceptor.ts
└── modules/
    ├── auth/           ← KEEP
    ├── users/          ← KEEP
    ├── transactions/   ← KEEP
    ├── dashboard/      ← MODIFY (cache key fix)
    ├── health/         ← MODIFY (add Kafka check)
    ├── merchants/      ← NEW (Phase 1)
    ├── customers/      ← NEW (Phase 1)
    ├── payments/       ← NEW (Phase 1)
    ├── idempotency/    ← NEW (Phase 2)
    ├── processor/      ← NEW (Phase 1, extended Phase 3)
    ├── risk/           ← NEW (Phase 7)
    ├── ledger/         ← NEW (Phase 6)
    ├── outbox/         ← NEW (Phase 4)
    ├── events/         ← NEW (Phase 4)
    ├── webhooks/       ← NEW (Phase 5)
    ├── reconciliation/ ← NEW (Phase 3)
    └── observability/  ← NEW (Phase 7)
```

---

## Technology Decisions

### Why NestJS?
- Existing investment in the framework — no migration cost
- Decorators-first design maps cleanly to guards, interceptors, and filters
- Built-in module system enforces the boundary isolation the architecture requires
- `@nestjs/schedule` supports in-process workers without additional infrastructure

### Why PostgreSQL as Source of Truth?
See [`tradeoffs.md`](./tradeoffs.md) for the full reasoning. Short version: financial correctness requires ACID. Kafka is eventually consistent and cannot be the source of truth for payment state.

### Why Modular Monolith?
See [`tradeoffs.md`](./tradeoffs.md). Short version: microservices multiply failure points. The distributed systems complexity in PayFlow comes from Kafka and async workers, not from service splitting.

### Why Kafka?
Kafka provides durable, replayable, ordered event streams that are ideal for:
1. Decoupling payment state changes from webhook delivery
2. Allowing multiple consumers (webhook worker, analytics, audit) to independently process the same event
3. Replay capability when a consumer has a bug and needs to reprocess historical events

See [`event-driven-architecture.md`](./event-driven-architecture.md) for full rationale.

# PayFlow Engineering Blueprint
## Evolving Finance Dashboard → Reliable Financial Infrastructure

> **Audit Date:** 2026-09-11  
> **Auditor:** Senior Staff Engineer Review  
> **Codebase:** `c:\VS Code\MY Backend APIs\PayFlow`

---

## 1. Repository Overview

The repository is a **NestJS 11** (not 10 as stated — package.json shows `^11.1.18`) monolith with a well-structured layout. Here is the exact verified technology snapshot:

| Concern | Technology | Version |
|---|---|---|
| Framework | NestJS | ^11.1.18 |
| Language | TypeScript | ^6.0.2 |
| ORM | Prisma | ^7.6.0 |
| Database | PostgreSQL | 16 (docker) |
| Cache/Session | Redis | 7 (docker) |
| Auth | Passport-JWT + Passport-Local | - |
| Logging | nestjs-pino / pino-http | ^4.6.1 |
| Validation | class-validator / class-transformer | - |
| API docs | @nestjs/swagger | ^11.2.6 |
| Rate limiting | @nestjs/throttler | ^6.5.0 |
| Security | Helmet + CORS + compression | - |
| Testing | Jest + Supertest | jest^30 |
| Container | Docker + Docker Compose v3.9 | - |
| Prisma adapter | @prisma/adapter-pg | ^7.6.0 |

**Important discrepancy:** The Prisma schema has `datasource db { url = env("DATABASE_URL") }` commented out (`// url = env("DATABASE_URL")`). The `PrismaService` injects the connection string directly via `PrismaPg` adapter. This is non-standard but functional.

---

## 2. Existing Architecture

```
src/
├── main.ts                         ← Bootstrap: Helmet, CORS, versioning, Swagger, Pino
├── app.module.ts                   ← Root module: Config, Pino, Throttler, Redis cache, guards
├── config/
│   ├── app.config.ts               ← App env vars (port, env, CORS, throttle, bcrypt)
│   ├── database.config.ts          ← Database URL (barely used - see Prisma note)
│   ├── jwt.config.ts               ← JWT secret + expiry
│   └── redis.config.ts             ← Redis host/port/credentials
├── common/
│   ├── database/
│   │   ├── prisma.module.ts        ← Global Prisma module
│   │   └── prisma.service.ts       ← PrismaClient + cleanDatabase() for tests
│   ├── decorators/
│   │   ├── current-user.decorator.ts
│   │   ├── public.decorator.ts     ← @Public() bypass JWT
│   │   └── roles.decorator.ts      ← @Roles(...) metadata
│   ├── dto/
│   │   └── pagination.dto.ts       ← PaginationDto + paginate() helper
│   ├── filters/
│   │   └── http-exception.filter.ts ← Global catch-all exception filter
│   ├── guards/
│   │   ├── jwt-auth.guard.ts       ← JWT guard with @Public() bypass
│   │   ├── active-user.guard.ts    ← Check user.status === ACTIVE
│   │   └── roles.guard.ts          ← RBAC guard using @Roles() metadata
│   └── interceptors/
│       ├── request-id.interceptor.ts ← X-Request-Id header propagation
│       └── transform.interceptor.ts  ← Wrap all success responses in {success,data,timestamp}
└── modules/
    ├── auth/
    │   ├── auth.controller.ts      ← POST /auth/login, GET /auth/profile
    │   ├── auth.service.ts         ← validateUser(), login(), getProfile()
    │   ├── auth.module.ts          ← Passport + JWT setup
    │   ├── auth.service.spec.ts    ← Unit tests (validateUser, login, getProfile)
    │   ├── dto/login.dto.ts
    │   └── strategies/
    │       ├── jwt.strategy.ts     ← DB lookup on every request (!)
    │       └── local.strategy.ts
    ├── users/
    │   ├── users.controller.ts     ← CRUD (ADMIN only for write)
    │   ├── users.service.ts        ← Business logic + bcrypt
    │   ├── users.repository.ts     ← Prisma data access (typed Selects)
    │   ├── users.service.spec.ts   ← Unit tests
    │   └── dto/ (create, update, query)
    ├── transactions/
    │   ├── transactions.controller.ts ← CRUD (ADMIN write, ANALYST/ADMIN read)
    │   ├── transactions.service.ts    ← RBAC-scoped business logic
    │   ├── transactions.repository.ts ← Rich filtering, raw SQL for monthly trends
    │   └── dto/ (create, update, query)
    ├── dashboard/
    │   ├── dashboard.controller.ts  ← Redis-cached analytics endpoints
    │   ├── dashboard.service.ts     ← Delegates to TransactionsRepository
    │   └── dto/
    └── health/
        ├── health.controller.ts    ← DB + Redis liveness probe
        └── health.module.ts
```

**Guard execution order (app.module.ts):**
```
HTTP request → JwtAuthGuard → ActiveUserGuard → RolesGuard → ThrottlerGuard
```

**Response envelope:**
```json
{ "success": true, "data": <payload>, "timestamp": "ISO8601" }
```

---

## 3. Existing Module Audit

### auth — `KEEP` (minor modifications needed)

**Strengths:**
- Clean separation: `LocalStrategy` for credential validation, `JwtStrategy` for stateless auth
- `@Public()` decorator cleanly bypasses JWT guard
- Password not exposed anywhere (Prisma select + destructuring)
- Unit tests cover the happy path and error cases

**Weaknesses / Risks:**
- **Critical**: `JwtStrategy.validate()` does a full DB lookup on **every authenticated request**. At 100 RPS this is 100 extra DB queries/second with no caching. Acceptable now but will become a bottleneck.
- No refresh token endpoint is implemented, despite JWT_REFRESH_SECRET being configured and validated
- The `login` method re-reads `jwt.expiresIn` from config on every call — minor but inconsistent
- `auth.service.ts` line 41: `configService.get<string>('jwt.expiresIn') ?? '7d'` — the fallback is dead code because Joi validates JWT_EXPIRES_IN at startup

**Not to touch:** The Passport setup, JWT signing, `@Public()` pattern. These are correct and should not change.

---

### users — `KEEP`

**Strengths:**
- Repository pattern is clean and correctly typed
- `userSelect` constant prevents password leakage at the ORM layer
- `existsByEmail()` prevents duplicates before creation (avoids race condition via application-level check — though a DB UNIQUE constraint also exists, this is acceptable)
- `softDelete` correctly sets both `deletedAt` and `status: INACTIVE`
- Well-tested (5 meaningful test cases)

**Weaknesses:**
- No `VIEWER` role can update their own profile (currently only ADMIN can update users)
- No email uniqueness check in `update()` — if email is ever updateable, this would cause a 500 from Prisma unique constraint instead of a clean 409

**Not to touch:** The repository pattern, the `userSelect` approach, soft delete logic.

---

### transactions — `KEEP` with observation

**Strengths:**
- Very rich filtering in `buildWhere()` — composable and readable
- Uses `$transaction([findMany, count])` for consistent pagination counts (snapshot consistency within the batch)
- Raw SQL in `getMonthlyTrends()` is well-structured and injection-safe (uses `Prisma.sql` tagged template)
- Soft delete is consistently applied via `deletedAt: null` filter
- RBAC scoping is explicit in the service layer

**Weaknesses / Risks:**
- **Naming collision risk**: The existing `Transaction` model represents a personal finance record (income/expense). The new `Payment` domain is a different concept but both are "transactions" in financial parlance. This will create cognitive confusion. The existing `Transaction` model should be renamed to `LedgerEntry` or kept as `Transaction` and the new entity named `Payment` (recommended).
- `getMonthlyTrends()` uses raw SQL with hardcoded table name `"transactions"`. If the table is ever renamed in Prisma schema, this silently breaks.
- No test for `TransactionsRepository` directly — only the service is tested

---

### dashboard — `KEEP`

**Strengths:**
- Redis caching with `@UseInterceptors(CacheInterceptor)` and `@CacheTTL()` is clean
- Proper RBAC: VIEWER gets limited response (no category/trend breakdown)
- Delegates to `TransactionsRepository` rather than reimplementing queries

**Weaknesses:**
- `DashboardService` is tightly coupled to `TransactionsRepository`. This works now but is an architectural smell — Dashboard should depend on a Domain Service, not a Repository.
- Cache key is URL-based (NestJS default). For user-scoped data, this means User A's cache key for `/dashboard/summary` is the same as User B's — **potential data leakage**. This is a correctness bug.
- `recentTransactions: unknown[]` type in `DashboardOverview` interface is a type safety gap

**Action needed:** Fix the cache key leak before PayFlow work begins.

---

### health — `KEEP` with upgrade

**Strengths:**
- Correctly checks both DB and Redis independently
- Marked `@Public()` so healthchecks don't require auth (correct for load balancer probes)

**Weaknesses:**
- Does not check Kafka (when added)
- Does not report version/commit SHA
- Does not differentiate between "degraded" (partial) and "error" states in HTTP status code (returns 200 always)

---

### common/database/PrismaService — `MODIFY`

**Current approach:** Uses `@prisma/adapter-pg` directly in the constructor with `process.env.DATABASE_URL` (not `ConfigService`). This bypasses NestJS DI config.

**Risk:** The Prisma schema has `// url = env("DATABASE_URL")` commented out. The `datasource db` block has no URL. This means Prisma CLI commands (`prisma migrate dev`, `prisma studio`) that read the schema directly will fail unless the URL is set differently.

**Action needed:** 
1. Restore `url = env("DATABASE_URL")` in schema.prisma
2. Keep adapter-pg approach in PrismaService but also pass via config

**Also:** `cleanDatabase()` truncates ALL public tables including new ones we'll add. This is fine for tests if kept up-to-date, but consider using `TRUNCATE ... RESTART IDENTITY CASCADE` instead of a loop.

---

### common/filters/GlobalExceptionFilter — `MODIFY`

**Current behavior:** Catches `HttpException` and generic `Error`. Returns structured `ErrorResponse`.

**Gap:** When new PayFlow-specific error types are added (e.g., `IdempotencyConflictException`, `InvalidStateTransitionException`, `InsufficientFundsException`), the filter should recognize them and return appropriate status codes with semantic error codes.

**Action needed:** Add a `PayFlowException` base class with `code` field. The filter will map these to consistent error responses with machine-readable codes.

---

### common/interceptors — `KEEP`

`TransformInterceptor` and `RequestIdInterceptor` are clean. No changes needed.

**Observation:** `RequestIdInterceptor` reads from `x-request-id` but sets it as `request.requestId`. The `GlobalExceptionFilter` also reads from `request.headers['x-request-id']`. These work consistently but the requestId is not propagated into Pino's log context automatically — the Pino `genReqId` function in `app.module.ts` handles that separately.

---

### common/dto/PaginationDto — `KEEP`

Clean, tested implicitly through service tests. The `skip` getter is correct.

---

## 4. Existing Database Audit

### Current Schema

```
users
├── id              TEXT PK (UUID)
├── email           TEXT UNIQUE NOT NULL
├── password        TEXT NOT NULL
├── first_name      TEXT NOT NULL
├── last_name       TEXT NOT NULL
├── role            Role (VIEWER|ANALYST|ADMIN) DEFAULT VIEWER
├── status          UserStatus (ACTIVE|INACTIVE) DEFAULT ACTIVE
├── created_at      TIMESTAMP DEFAULT now()
├── updated_at      TIMESTAMP @updatedAt
└── deleted_at      TIMESTAMP NULL (soft delete)

transactions
├── id              TEXT PK (UUID)
├── amount          DECIMAL(15,2) NOT NULL
├── type            TransactionType (INCOME|EXPENSE) NOT NULL
├── category        TEXT NOT NULL
├── date            TIMESTAMP NOT NULL
├── notes           TEXT NULL
├── user_id         TEXT FK → users(id) NOT NULL
├── created_at      TIMESTAMP DEFAULT now()
├── updated_at      TIMESTAMP @updatedAt
└── deleted_at      TIMESTAMP NULL (soft delete)

Indexes: user_id, type, category, date
```

### Issues

1. **IDs are `TEXT` not `UUID` type.** Using PostgreSQL `TEXT` for UUIDs misses the ability to use the native `uuid` type for storage efficiency and type safety at the DB level. Acceptable for now — changing this post-migration is costly.

2. **No `DECIMAL` precision risk**: `DECIMAL(15,2)` supports values up to 9,999,999,999,999.99. Sufficient.

3. **No `CHECK` constraints**: There are no `CHECK(amount > 0)` constraints. An application bug could insert negative amounts directly via Prisma without validation.

4. **`id` as TEXT (UUID) generated by Prisma**: The `@default(uuid())` is Prisma-generated, not DB-generated. If records are ever inserted bypassing Prisma (direct SQL), IDs won't be auto-generated.

5. **Soft delete filter not in DB**: `deletedAt: null` is an application-level filter. No partial index on `deleted_at IS NULL` exists — for large tables this becomes a performance issue. A partial index would help: `CREATE INDEX ON transactions(user_id) WHERE deleted_at IS NULL`.

---

## 5. Existing API Audit

| Method | Path | Auth | Role | Notes |
|---|---|---|---|---|
| POST | /api/v1/auth/login | None | Any | Returns JWT. Uses LocalStrategy. |
| GET | /api/v1/auth/profile | JWT | Any active | Returns current user (no password) |
| GET | /api/v1/users | JWT | ADMIN, ANALYST | Paginated, filterable |
| POST | /api/v1/users | JWT | ADMIN | Creates user |
| GET | /api/v1/users/:id | JWT | ADMIN, ANALYST | Single user |
| PATCH | /api/v1/users/:id | JWT | ADMIN | Update user |
| DELETE | /api/v1/users/:id | JWT | ADMIN | Soft delete |
| GET | /api/v1/transactions | JWT | ADMIN, ANALYST | Paginated, filterable |
| POST | /api/v1/transactions | JWT | ADMIN | Creates transaction |
| GET | /api/v1/transactions/:id | JWT | ADMIN, ANALYST | Single transaction |
| PATCH | /api/v1/transactions/:id | JWT | ADMIN | Update |
| DELETE | /api/v1/transactions/:id | JWT | ADMIN | Soft delete |
| GET | /api/v1/dashboard/overview | JWT | ALL | Cached 60s |
| GET | /api/v1/dashboard/summary | JWT | ALL | Cached 60s |
| GET | /api/v1/dashboard/categories | JWT | ANALYST, ADMIN | Cached 120s |
| GET | /api/v1/dashboard/trends | JWT | ANALYST, ADMIN | Cached 300s |
| GET | /api/v1/dashboard/recent | JWT | ALL | Cached 30s |
| GET | /api/v1/health | None | Any | DB + Redis liveness |

**API conventions established:**
- Global prefix: `/api`
- URI versioning: `/v1`
- Response envelope: `{ success: true, data: T, timestamp: ISO8601 }`
- Error envelope: `{ statusCode, error, message, timestamp, path, requestId }`
- UUID params via `ParseUUIDPipe`
- Rate limit: 100 req/60s global (via ThrottlerGuard)

**The new PayFlow API must follow these exact conventions.**

---

## 6. Existing Testing Audit

### Unit Tests

| File | Coverage | Quality |
|---|---|---|
| `auth.service.spec.ts` | `validateUser`, `login`, `getProfile` — 3 methods, 5 cases | Good. Mocks PrismaService and JwtService correctly. Tests edge cases (user not found, wrong password). |
| `users.service.spec.ts` | `create`, `findAll`, `findOne`, `update`, `remove` — full service coverage | Good. 9 test cases. Tests ConflictException, NotFoundException. Checks password not passed plain text. |

### E2E Tests

| File | Coverage | Quality |
|---|---|---|
| `test/auth.e2e-spec.ts` | POST /auth/login (4 cases), GET /auth/profile (3 cases) | Good. Boots full AppModule. Uses `cleanDatabase()` before/after. Tests 200, 401, 400 status codes. Tests password not in response. |

### Gaps

1. **Zero coverage** on `TransactionsService`, `TransactionsRepository`, `DashboardService`
2. No E2E tests for Users, Transactions, Dashboard endpoints
3. No integration test for the Redis cache behavior
4. No test for concurrent requests
5. No test for soft-delete filtering
6. No test for RBAC (role-based access control)
7. No test for rate limiting behavior

---

## 7. Existing Observability / Security Audit

### Observability

| Aspect | Status |
|---|---|
| Structured JSON logging | ✅ Pino with genReqId, redacted auth headers |
| Request ID propagation | ✅ X-Request-Id header in/out |
| DB query logging | ✅ Prisma `log: [{ emit: 'event', level: 'query' }]` (events not consumed) |
| Error logging | ✅ GlobalExceptionFilter logs errors with requestId |
| Metrics | ❌ None |
| Distributed tracing | ❌ None |
| Alerting | ❌ None |

**Gap:** Prisma emits query events (`query` level) but nothing consumes them. These should be wired to Pino for query latency observability.

### Security

| Aspect | Status |
|---|---|
| Helmet | ✅ Configured with env-aware CSP |
| CORS | ✅ Origin whitelist from config |
| Rate limiting | ✅ 100 req/60s global |
| Input validation | ✅ ValidationPipe with whitelist + forbidNonWhitelisted |
| JWT | ✅ HS256, expiry enforced |
| Password hashing | ✅ bcrypt, 12 rounds |
| Secrets in env | ✅ Joi validates at startup |
| SQL injection | ✅ Prisma parameterized + tagged template literals |
| Soft deletes | ✅ Consistent pattern |
| Auth header redaction in logs | ✅ |
| Non-root Docker user | ✅ nestjs:nodejs |
| CSRF | ⚠️ Not applicable for JWT-only API |
| Input sanitization (XSS) | ⚠️ Whitelist strips unknown props but no HTML sanitization |
| Secrets in production Compose | ❌ Hardcoded `change-me-in-production` strings in docker-compose.yml |

---

## 8. Target PayFlow Architecture

The goal is a **modular monolith + async workers** with clear domain boundaries.

```
┌─────────────────────────────────────────────────────────────────┐
│                     PayFlow NestJS Monolith                      │
│                                                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────────┐   │
│  │  auth   │  │  users  │  │ txns    │  │    dashboard     │   │
│  │ (KEEP)  │  │ (KEEP)  │  │ (KEEP)  │  │    (KEEP)        │   │
│  └─────────┘  └─────────┘  └─────────┘  └──────────────────┘   │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                 NEW: payments domain                      │    │
│  │  ┌──────────┐ ┌─────────────┐ ┌──────────────────────┐  │    │
│  │  │ payments │ │ idempotency │ │      processor        │  │    │
│  │  │ (state   │ │  (key store │ │   (fake simulator)   │  │    │
│  │  │ machine) │ │  + dedup)   │ │                      │  │    │
│  │  └──────────┘ └─────────────┘ └──────────────────────┘  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                 NEW: financial integrity                   │    │
│  │  ┌────────┐  ┌────────────────┐  ┌──────────────────┐   │    │
│  │  │ ledger │  │ reconciliation │  │      risk        │   │    │
│  │  │ (DEB=  │  │ (UNKNOWN →     │  │ (rule engine)   │   │    │
│  │  │  CRED) │  │  SUCC/FAIL)    │  │                  │   │    │
│  │  └────────┘  └────────────────┘  └──────────────────┘   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                 NEW: event pipeline                        │    │
│  │  ┌─────────┐  ┌──────────────┐  ┌──────────────────┐    │    │
│  │  │  outbox │  │    kafka     │  │    webhooks      │    │    │
│  │  │ (write- │  │  (producer + │  │  (delivery +     │    │    │
│  │  │  ahead) │  │  consumers)  │  │   retry + DLQ)   │    │    │
│  │  └─────────┘  └──────────────┘  └──────────────────┘    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                 NEW: workers (within-process)              │    │
│  │  outbox-worker │ reconciliation-worker │ webhook-worker   │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

External:
  PostgreSQL 16 ← source of truth for all financial state
  Redis 7       ← idempotency locks + rate limiting + caching
  Kafka         ← async event bus (added in Phase 4)
```

### Key Architectural Decisions

**Why PostgreSQL as source of truth, not Kafka?**  
Financial correctness requires ACID transactions. Kafka is eventually consistent. The payment state machine transitions must be atomic with ledger entries. PostgreSQL's serializable isolation makes this possible.

**Why modular monolith first?**  
Microservices multiply failure points. A modular monolith with clear interfaces can be extracted later with significantly less risk. The distributed systems complexity comes from Kafka + worker isolation, not from service splitting.

**Why async workers inside the process?**  
NestJS supports `@nestjs/schedule` for cron-based workers. Running workers inside the same process allows sharing the DI container (PrismaService, Redis) without network overhead. The outbox worker, reconciliation worker, and webhook worker are all in-process scheduled jobs.

**Why transactional outbox?**  
Direct DB → Kafka publish is a two-phase commit without 2PC support. If the app crashes after DB commit but before Kafka publish, the event is lost. The outbox writes the event to DB in the same transaction, then a worker reliably publishes it.

---

## 9. Module-by-Module Change Map

| Module | Classification | Rationale |
|---|---|---|
| `auth` | **KEEP** (1 fix) | Fix: cache user in JWT validation to avoid per-request DB hit |
| `users` | **KEEP** | Stable, well-tested |
| `transactions` | **KEEP** | Keep as personal finance records; new payments domain is separate |
| `dashboard` | **MODIFY** (1 fix) | Fix cache key collision for user-scoped data |
| `health` | **MODIFY** | Add Kafka health check in Phase 4 |
| `common/database` | **MODIFY** | Fix Prisma schema URL comment; add transaction helper |
| `common/filters` | **MODIFY** | Add PayFlowException base class support |
| `common/interceptors` | **KEEP** | Already correct |
| `common/dto` | **KEEP** | Add cursor-pagination DTO later (optional) |
| `common/guards` | **KEEP** | Add `MerchantApiKeyGuard` in Phase 1 |
| **payments** | **ADD** | Core new domain — state machine, attempts, refunds |
| **idempotency** | **ADD** | Idempotency key store + duplicate detection |
| **processor** | **ADD** | Fake processor simulator with failure modes |
| **risk** | **ADD** | Rule-based risk engine |
| **ledger** | **ADD** | Double-entry accounting |
| **outbox** | **ADD** | Transactional outbox table + worker |
| **events** | **ADD** | Kafka producer service + typed event schemas |
| **webhooks** | **ADD** | Merchant webhook endpoints, delivery, retry, DLQ |
| **reconciliation** | **ADD** | Worker: UNKNOWN payments → query processor → resolve |
| **merchants** | **ADD** | Merchant entity + API key management |
| **customers** | **ADD** | Customer entity (referenced by payments) |
| **observability** | **ADD** | OpenTelemetry + Prometheus metrics |

---

## 10. Database Evolution Plan

### Principle
- Every new migration is **additive only** for Phase 0-3
- No existing tables/columns are dropped or renamed
- Migrations are isolated per phase so partial rollout is possible

---

### Phase 1 New Tables

#### `merchants`
```sql
CREATE TABLE merchants (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  webhook_url   TEXT,
  webhook_secret TEXT,            -- HMAC secret for webhook signatures
  status        TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | SUSPENDED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
```

#### `api_keys`
```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  key_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of raw key; never store raw
  key_prefix    TEXT NOT NULL,          -- First 8 chars for display (e.g. "sk_live_")
  name          TEXT,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX api_keys_merchant_id_idx ON api_keys(merchant_id);
```

#### `customers`
```sql
CREATE TABLE customers (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  external_id   TEXT NOT NULL,          -- Merchant's own customer ID
  email         TEXT,
  name          TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(merchant_id, external_id)
);
CREATE INDEX customers_merchant_id_idx ON customers(merchant_id);
```

#### `payments`
```sql
CREATE TYPE payment_status AS ENUM (
  'CREATED', 'PROCESSING', 'REQUIRES_ACTION',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN',
  'REFUND_PENDING', 'REFUNDED'
);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  customer_id         TEXT REFERENCES customers(id),
  amount              BIGINT NOT NULL,          -- Amount in smallest currency unit (paise/cents). NEVER decimal for money.
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              payment_status NOT NULL DEFAULT 'CREATED',
  description         TEXT,
  metadata            JSONB DEFAULT '{}',
  processor_payment_id TEXT,                   -- Processor's reference
  idempotency_key_id  TEXT REFERENCES idempotency_keys(id),
  risk_score          INTEGER,
  risk_decision       TEXT,                    -- ALLOW | REVIEW | DECLINE
  failure_code        TEXT,
  failure_message     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ
);

CREATE INDEX payments_merchant_id_idx ON payments(merchant_id);
CREATE INDEX payments_customer_id_idx ON payments(customer_id);
CREATE INDEX payments_status_idx ON payments(status);
CREATE INDEX payments_created_at_idx ON payments(created_at DESC);
-- For reconciliation worker to find UNKNOWN payments efficiently:
CREATE INDEX payments_status_created_at_idx ON payments(status, created_at) WHERE status = 'UNKNOWN';
```

> **Critical:** Use `BIGINT` for monetary amounts, not `DECIMAL`. Store amounts in the smallest unit (paise for INR, cents for USD). This eliminates floating-point rounding errors entirely.

#### `payment_attempts`
```sql
CREATE TABLE payment_attempts (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payment_id          TEXT NOT NULL REFERENCES payments(id),
  attempt_number      INTEGER NOT NULL,
  processor_request   JSONB,               -- What was sent to processor
  processor_response  JSONB,               -- What was received (or null on timeout)
  status              TEXT NOT NULL,       -- PENDING | SUCCESS | FAILED | TIMEOUT | UNKNOWN
  error_code          TEXT,
  error_message       TEXT,
  duration_ms         INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX payment_attempts_payment_id_idx ON payment_attempts(payment_id);
```

---

### Phase 2 New Tables

#### `idempotency_keys`
```sql
CREATE TABLE idempotency_keys (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,           -- SHA-256 of canonical request body
  payment_id      TEXT REFERENCES payments(id),
  status_code     INTEGER,                 -- HTTP status code of original response
  response_body   JSONB,                   -- Stored response to replay
  locked_at       TIMESTAMPTZ,             -- Set when first request is in flight
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '24 hours',
  UNIQUE(merchant_id, key)
);
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys(expires_at);
```

**Why this structure:**
- `UNIQUE(merchant_id, key)` is the database-level guard against concurrent duplicates
- `locked_at` enables optimistic in-flight detection
- `request_hash` enables conflict detection (same key, different body)
- `expires_at` allows cleanup without complex state management

#### `refunds`
```sql
CREATE TYPE refund_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE refunds (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payment_id      TEXT NOT NULL REFERENCES payments(id),
  amount          BIGINT NOT NULL,         -- Refund amount (≤ payment.amount)
  currency        TEXT NOT NULL,
  status          refund_status NOT NULL DEFAULT 'PENDING',
  reason          TEXT,
  processor_refund_id TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ
);
CREATE INDEX refunds_payment_id_idx ON refunds(payment_id);
```

---

### Phase 4 New Tables

#### `outbox_events`
```sql
CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

CREATE TABLE outbox_events (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  aggregate_type  TEXT NOT NULL,           -- e.g. 'payment'
  aggregate_id    TEXT NOT NULL,           -- payment_id
  event_type      TEXT NOT NULL,           -- e.g. 'payment.succeeded'
  payload         JSONB NOT NULL,
  status          outbox_status NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  scheduled_for   TIMESTAMPTZ NOT NULL DEFAULT now()   -- enables delayed retry
);

-- Outbox worker queries this constantly:
CREATE INDEX outbox_pending_idx ON outbox_events(status, scheduled_for) WHERE status IN ('PENDING', 'FAILED');
```

---

### Phase 5 New Tables

#### `webhook_endpoints`
```sql
CREATE TABLE webhook_endpoints (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id),
  url           TEXT NOT NULL,
  secret        TEXT NOT NULL,             -- HMAC-SHA256 signing secret
  events        TEXT[] NOT NULL DEFAULT '{}',  -- subscribed event types
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_merchant_id_idx ON webhook_endpoints(merchant_id);
```

#### `webhook_deliveries`
```sql
CREATE TYPE webhook_delivery_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'DEAD');

CREATE TABLE webhook_deliveries (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  event_type          TEXT NOT NULL,
  payload             JSONB NOT NULL,
  status              webhook_delivery_status NOT NULL DEFAULT 'PENDING',
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at     TIMESTAMPTZ,
  last_http_status    INTEGER,
  last_response_body  TEXT,
  last_error          TEXT,
  idempotency_key     TEXT NOT NULL,       -- Prevents duplicate delivery
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(idempotency_key)
);

CREATE INDEX webhook_deliveries_status_next_attempt_idx
  ON webhook_deliveries(status, next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');
```

---

### Phase 6 New Tables

#### `ledger_accounts`
```sql
CREATE TYPE account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');
CREATE TYPE account_normal_balance AS ENUM ('DEBIT', 'CREDIT');

CREATE TABLE ledger_accounts (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code            TEXT NOT NULL UNIQUE,    -- e.g. 'CUSTOMER_FUNDS', 'CLEARING', 'MERCHANT_PAYABLE'
  name            TEXT NOT NULL,
  type            account_type NOT NULL,
  normal_balance  account_normal_balance NOT NULL,
  merchant_id     TEXT REFERENCES merchants(id),  -- NULL = system account
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `ledger_transactions`
```sql
CREATE TABLE ledger_transactions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  reference_type  TEXT NOT NULL,           -- 'payment' | 'refund' | 'settlement'
  reference_id    TEXT NOT NULL,           -- payment_id, refund_id, etc.
  description     TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,    -- Prevents double-posting
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_txn_reference_idx ON ledger_transactions(reference_type, reference_id);
```

#### `ledger_entries`
```sql
CREATE TABLE ledger_entries (
  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ledger_transaction_id   TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id              TEXT NOT NULL REFERENCES ledger_accounts(id),
  entry_type              TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  amount                  BIGINT NOT NULL CHECK (amount > 0),
  currency                TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries(ledger_transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id);
```

**Core invariant enforced via trigger or application logic:**
```sql
-- For every ledger_transaction_id:
-- SUM(amount WHERE entry_type='DEBIT') = SUM(amount WHERE entry_type='CREDIT')
```

---

### Phase 7 New Tables

#### `risk_assessments`
```sql
CREATE TABLE risk_assessments (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payment_id      TEXT NOT NULL REFERENCES payments(id) UNIQUE,
  score           INTEGER NOT NULL,        -- 0-100
  decision        TEXT NOT NULL,           -- 'allow' | 'review' | 'decline'
  reasons         TEXT[] NOT NULL DEFAULT '{}',
  rules_version   TEXT NOT NULL,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `reconciliation_runs`
```sql
CREATE TABLE reconciliation_runs (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  payments_checked    INTEGER NOT NULL DEFAULT 0,
  payments_resolved   INTEGER NOT NULL DEFAULT 0,
  payments_failed     INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  status              TEXT NOT NULL DEFAULT 'RUNNING'  -- RUNNING | COMPLETED | FAILED
);
```

#### `audit_logs`
```sql
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  actor_type      TEXT NOT NULL,           -- 'user' | 'merchant' | 'system'
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,           -- e.g. 'payment.cancel', 'user.deactivate'
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  before_state    JSONB,
  after_state     JSONB,
  ip_address      TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_type, actor_id);
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
```

---

## 11. API Evolution Plan

All new endpoints follow existing conventions:
- Base: `/api/v1/...`
- Response: `{ success: true, data: T, timestamp: ISO8601 }`
- Auth: Merchant API key (`Authorization: Bearer sk_live_...`) or existing JWT
- UUID params: `ParseUUIDPipe`

### New Endpoints — Phase 1

#### `POST /v1/payments`
```
Auth:           Merchant API Key
Header:         Idempotency-Key: <string> (REQUIRED)
Body:           CreatePaymentDto
  - amount:     number (in paise/cents, positive integer)
  - currency:   string (ISO 4217, default INR)
  - customer_id: string (optional)
  - description: string (optional, max 500)
  - metadata:   object (optional)
Response 201:   PaymentResponseDto (full payment object)
Response 409:   Idempotency conflict (same key, different body)
Response 200:   Idempotency replay (same key, same body)
Response 422:   Risk declined
Response 400:   Validation error
Idempotency:    FULL — replay stored response on duplicate key+body
Concurrency:    DB UNIQUE(merchant_id, key) prevents duplicate creation
```

#### `GET /v1/payments/:id`
```
Auth:           Merchant API Key
Response 200:   PaymentResponseDto
Response 404:   Not found (or belongs to different merchant)
```

#### `GET /v1/payments`
```
Auth:           Merchant API Key
Query:          status, customer_id, date_from, date_to, page, limit
Response 200:   PaginatedResult<PaymentResponseDto>
```

#### `POST /v1/payments/:id/cancel`
```
Auth:           Merchant API Key
Response 200:   Updated PaymentResponseDto
Response 409:   Invalid state transition
Response 404:   Not found
```

#### `POST /v1/payments/:id/refund`
```
Auth:           Merchant API Key
Header:         Idempotency-Key: <string> (REQUIRED)
Body:           RefundPaymentDto
  - amount:     number (≤ payment.amount, positive integer)
  - reason:     string (optional)
Response 200:   RefundResponseDto
Response 409:   Idempotency conflict OR amount exceeds payment
Response 400:   Invalid state (payment not SUCCEEDED)
```

### New Endpoints — Phase 5

#### `POST /v1/merchants/:id/webhooks`
```
Auth:           JWT (ADMIN)
Body:           CreateWebhookEndpointDto
  - url:        string (HTTPS required in production)
  - events:     string[] (e.g. ["payment.succeeded", "payment.failed"])
Response 201:   WebhookEndpointDto (includes generated secret — shown ONCE)
```

#### `GET /v1/merchants/:id/webhooks`
#### `DELETE /v1/merchants/:id/webhooks/:webhookId`

### Internal / Worker Endpoints (Phase 3)

These are **not** HTTP endpoints — they are scheduled in-process workers. However, they should have a manual trigger endpoint for operational purposes:

```
POST /v1/internal/reconciliation/trigger  (JWT + ADMIN)
POST /v1/internal/outbox/flush            (JWT + ADMIN)
```

---

## 12. Detailed Implementation Phases

### Phase 0 — Pre-Flight Fixes (1-2 days)
**Prerequisites:** None  
**Definition of Done:** All existing tests pass. No regressions.

**Tasks:**
1. **Fix Prisma schema**: Restore `url = env("DATABASE_URL")` in schema.prisma
2. **Fix dashboard cache key collision**: Override cache key generation to include `userId`
3. **Add Prisma query event logging**: Wire `$on('query', ...)` to Pino logger
4. **Fix Docker CMD path**: `docker-compose.yml` CMD uses `node dist/main` but output is at `dist/src/main.js` (see `package.json` `start:prod`)
5. **Add `PayFlowException` base class**: `common/exceptions/payflow.exception.ts` with `code: string` field. Update `GlobalExceptionFilter` to map it.
6. **Add `ApiKeyGuard`**: Skeleton only — accepts `Authorization: Bearer sk_*` header, looks up in `api_keys` table (table doesn't exist yet — guard returns 501 until Phase 1 migration runs)
7. Update `CORS_ORIGINS` to also allow `Idempotency-Key` header

**Files affected:**
- `prisma/schema.prisma`
- `src/modules/dashboard/dashboard.controller.ts`
- `src/common/database/prisma.service.ts`
- `src/common/filters/http-exception.filter.ts`
- `src/common/exceptions/payflow.exception.ts` (NEW)
- `src/common/guards/api-key.guard.ts` (NEW)
- `src/main.ts` (CORS headers)
- `docker-compose.yml`

**Tests required:**
- Existing tests must still pass
- Add test for dashboard cache key isolation (can be manual verification)

---

### Phase 1 — Payment Foundation (1 week)
**Prerequisites:** Phase 0 complete  
**Definition of Done:** `POST /v1/payments` creates a payment. State machine enforced. Basic tests passing.

**Database changes:** `merchants`, `api_keys`, `customers`, `payments`, `payment_attempts` tables

**New modules:**
```
src/modules/merchants/
src/modules/customers/
src/modules/payments/
  payments.controller.ts
  payments.service.ts
  payments.repository.ts
  payments.state-machine.ts    ← LEGAL_TRANSITIONS map
  dto/
    create-payment.dto.ts
    refund-payment.dto.ts
    payment-response.dto.ts
    payment-query.dto.ts
```

**State machine implementation:**
```typescript
// payments.state-machine.ts
export const LEGAL_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED:         ['PROCESSING', 'CANCELLED'],
  PROCESSING:      ['REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'UNKNOWN'],
  REQUIRES_ACTION: ['PROCESSING', 'FAILED', 'CANCELLED'],
  SUCCEEDED:       ['REFUND_PENDING'],
  FAILED:          [],           // terminal
  CANCELLED:       [],           // terminal
  UNKNOWN:         ['SUCCEEDED', 'FAILED', 'CANCELLED'],   // reconciliation resolves
  REFUND_PENDING:  ['REFUNDED', 'SUCCEEDED'],  // back to SUCCEEDED on refund failure
  REFUNDED:        [],           // terminal
};

export function assertValidTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new InvalidStateTransitionException(from, to);
  }
}
```

**API Key Guard completion:** Wire `ApiKeyGuard` to `api_keys` table.

**Processor module skeleton:**
```
src/modules/processor/
  processor.interface.ts      ← PaymentProcessor interface
  simulator.processor.ts      ← Fake implementation (success only, Phase 1)
  processor.module.ts
```

**Tests required:**
- Unit: `PaymentStateMachine` — every legal and illegal transition
- Unit: `PaymentsService.create()`
- Unit: `PaymentsService.cancel()` — valid and invalid states
- E2E: `POST /v1/payments` (201 success case)
- E2E: `POST /v1/payments/:id/cancel` — CREATED → CANCELLED
- E2E: `POST /v1/payments/:id/cancel` — SUCCEEDED → 409 invalid transition

---

### Phase 2 — Correctness & Idempotency (1 week)
**Prerequisites:** Phase 1 complete  
**Definition of Done:** 100 concurrent identical requests produce 1 payment. All idempotency scenarios covered by tests.

**Database changes:** `idempotency_keys`, `refunds` tables

**New module:**
```
src/modules/idempotency/
  idempotency.service.ts
  idempotency.repository.ts
  idempotency.module.ts
```

**Idempotency flow:**
```
POST /v1/payments
  ↓
Extract Idempotency-Key header (REQUIRED — 400 if missing)
  ↓
Hash request body (SHA-256 of canonical JSON)
  ↓
Try INSERT INTO idempotency_keys (merchant_id, key, request_hash, locked_at=now())
  ├─ Success → new request, proceed
  ├─ UNIQUE violation (same key):
  │     ├─ Same request_hash → replay stored response (200 with original body)
  │     └─ Different request_hash → 409 Conflict
  └─ locked_at set but no response_body → in-flight request
        → 409 with "request in progress" (retry after 1s)

After payment created:
  ↓
UPDATE idempotency_keys SET payment_id=..., status_code=201, response_body=...
  WHERE merchant_id=... AND key=... (in same DB transaction as payment creation)
```

**Critical concurrency test:**
```typescript
// test: 100 concurrent identical requests → 1 payment
const promises = Array.from({ length: 100 }, () =>
  request(app).post('/v1/payments')
    .set('Idempotency-Key', 'test-key-concurrent')
    .send(paymentBody)
);
const results = await Promise.all(promises);
const created = results.filter(r => r.status === 201);
const replayed = results.filter(r => r.status === 200);
const paymentIds = new Set([...created, ...replayed].map(r => r.body.data.id));
expect(paymentIds.size).toBe(1);   // Only 1 unique payment
expect(created.length + replayed.length).toBe(100);  // All succeed
```

**Refund implementation:**
- `POST /v1/payments/:id/refund`
- Validates payment is `SUCCEEDED`
- Validates refund amount ≤ remaining refundable amount
- Creates `refund` record + transitions payment to `REFUND_PENDING`
- Calls processor refund

**Tests required:**
- Unit: `IdempotencyService` — all four cases (new, replay, conflict, in-flight)
- Integration: Concurrent requests test (100 parallel)
- E2E: Same key + same body → replay
- E2E: Same key + different body → 409
- E2E: Refund success, refund amount exceeded

---

### Phase 3 — Failure Recovery & Reconciliation (1 week)
**Prerequisites:** Phase 2 complete  
**Definition of Done:** UNKNOWN payments are resolved by reconciliation worker. Processor failure modes are all tested.

**Processor simulator completion:**
```typescript
// simulator.processor.ts
export type FailureMode = 'success' | 'timeout' | 'error' | 'slow' | 'duplicate' | 'unknown_result';

export class ProcessorConfig {
  mode: FailureMode = 'success';
  delayMs?: number;
  errorCode?: string;
}
```

**Configurable via env var or runtime config endpoint (for testing):**
```
PROCESSOR_FAILURE_MODE=timeout
PROCESSOR_DELAY_MS=5000
```

**UNKNOWN state handling:**
```
PaymentsService.charge()
  ↓
try { processorResponse = await processor.charge(timeout=10s) }
catch(TimeoutError) {
  → payment.status = UNKNOWN
  → payment_attempt.status = TIMEOUT
  → schedule reconciliation check
}
```

**Reconciliation worker:**
```
src/modules/reconciliation/
  reconciliation.worker.ts     ← @Cron('*/1 * * * *') (every minute)
  reconciliation.service.ts
  reconciliation.module.ts
```

**Worker logic:**
```
Every 1 minute:
  1. Find all payments with status=UNKNOWN and created_at < now() - 2 minutes
  2. For each: call processor.getPayment(processor_payment_id)
  3. Map processor response to SUCCEEDED | FAILED | still UNKNOWN
  4. Transition payment + create outbox event (Phase 4 will publish these)
  5. Log to reconciliation_runs table
```

**Tests required:**
- Unit: `ProcessorSimulator` — each failure mode
- Integration: charge → timeout → UNKNOWN → reconciliation → SUCCEEDED
- Integration: charge → timeout → UNKNOWN → reconciliation → FAILED
- Integration: reconciliation worker handles processor still returning unknown
- E2E: Full reconciliation flow with mocked processor

---

### Phase 4 — Event-Driven Architecture (1-1.5 weeks)
**Prerequisites:** Phase 3 complete  
**Definition of Done:** Payment events flow through Kafka. Consumers are idempotent. Outbox worker handles Kafka failures.

**Infrastructure addition:** Kafka to docker-compose.yml

```yaml
kafka:
  image: confluentinc/cp-kafka:7.6.0
  environment:
    KAFKA_BROKER_ID: 1
    KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
    KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false'
  depends_on: [zookeeper]

zookeeper:
  image: confluentinc/cp-zookeeper:7.6.0
  environment:
    ZOOKEEPER_CLIENT_PORT: 2181
```

**New package:** `@nestjs/microservices` + `kafkajs`

**Event schema:**
```typescript
interface PayFlowEvent {
  event_id: string;      // UUID — for consumer idempotency
  event_type: string;    // 'payment.succeeded', 'payment.failed', etc.
  aggregate_type: 'payment' | 'refund';
  aggregate_id: string;  // payment_id
  merchant_id: string;
  version: number;       // schema version
  timestamp: string;     // ISO 8601
  payload: unknown;      // event-specific data
}
```

**New modules:**
```
src/modules/events/
  events.producer.ts       ← KafkaJS producer wrapper
  events.module.ts
  schemas/
    payment.events.ts      ← Typed event factories

src/modules/outbox/
  outbox.worker.ts         ← @Cron('*/5 * * * * *') — every 5 seconds
  outbox.service.ts
  outbox.repository.ts
  outbox.module.ts
```

**Outbox worker:**
```
Every 5 seconds:
  1. SELECT ... FROM outbox_events WHERE status='PENDING' AND scheduled_for <= now()
     LIMIT 100 FOR UPDATE SKIP LOCKED     ← Prevents worker conflicts
  2. For each event:
     a. UPDATE status='PROCESSING'
     b. Publish to Kafka topic
     c. UPDATE status='PUBLISHED'
     d. On failure: UPDATE status='FAILED', attempts++, scheduled_for=now()+backoff
  3. Events with attempts > 5 → status='FAILED' (manual intervention required)
```

**Consumer idempotency:**
- Before processing any event, check `event_id` in a Redis Set or DB table
- If already processed → skip (log as duplicate)
- If not → process + mark as processed

**Tests required:**
- Unit: OutboxService — all four scenarios (success, Kafka fail, worker crash simulation, duplicate)
- Unit: Event producer — message format validation
- Integration: Payment creation → outbox_events row inserted in same transaction
- Integration: Outbox worker processes events and publishes to Kafka
- Integration: Consumer receives duplicate event → processes exactly once

---

### Phase 5 — Webhooks (1 week)
**Prerequisites:** Phase 4 complete (Kafka events flowing)  
**Definition of Done:** Merchants receive webhook calls. Retries with exponential backoff. Dead-lettering after 5 failures.

**New module:**
```
src/modules/webhooks/
  webhooks.controller.ts      ← CRUD for webhook endpoints
  webhooks.service.ts
  webhooks.worker.ts          ← @Cron('*/10 * * * * *') — every 10 seconds
  webhooks.repository.ts
  webhooks.consumer.ts        ← Kafka consumer: subscribes to payment.* topics
  webhooks.signer.ts          ← HMAC-SHA256 signature generation
  webhooks.module.ts
```

**Signature scheme:**
```typescript
// webhooks.signer.ts
const timestamp = Math.floor(Date.now() / 1000).toString();
const payload = `${timestamp}.${JSON.stringify(body)}`;
const signature = createHmac('sha256', secret).update(payload).digest('hex');
// Headers sent:
// X-PayFlow-Timestamp: <timestamp>
// X-PayFlow-Signature: v1=<signature>
```

**Retry schedule:**
```
Attempt 1: immediate
Attempt 2: now + 5s
Attempt 3: now + 30s
Attempt 4: now + 5min
Attempt 5: now + 30min
After 5: status = DEAD (DLQ)
```

**Worker logic:**
```
Every 10 seconds:
  1. SELECT deliveries WHERE status IN ('PENDING','FAILED') AND next_attempt_at <= now()
     FOR UPDATE SKIP LOCKED LIMIT 50
  2. For each delivery:
     a. Send HTTP POST to webhook URL
     b. Expect 2xx within 10s
     c. Success → status='SUCCEEDED'
     d. Failure → attempts++, next_attempt_at = backoff(attempts), status='FAILED'
     e. attempts >= max_attempts → status='DEAD'
  3. Merchant webhook server down → system continues, DLQ notified
```

**Tests required:**
- Unit: `WebhookSigner` — signature generation + verification
- Unit: Backoff calculation
- Integration: Kafka event → webhook delivery created → worker delivers
- Integration: Webhook endpoint returns 500 → retry with backoff
- Integration: 5 failures → DLQ (status=DEAD)
- Integration: Duplicate delivery idempotency (same idempotency_key → skip)
- Integration: Invalid signature verification

---

### Phase 6 — Financial Integrity / Ledger (1 week)
**Prerequisites:** Phase 2 complete (payments working)  
**Definition of Done:** Every payment creates balanced ledger entries. SUM(debits) = SUM(credits) always.

**New module:**
```
src/modules/ledger/
  ledger.service.ts
  ledger.repository.ts
  ledger.module.ts
```

**System accounts (seeded, never deleted):**
```
CUSTOMER_FUNDS    — ASSET/DEBIT  (what customers deposited)
CLEARING          — LIABILITY/CREDIT (in-transit funds)
MERCHANT_PAYABLE  — LIABILITY/CREDIT (owed to merchant)
REVENUE_FEES      — REVENUE/CREDIT (PayFlow fees)
```

**Ledger entry for a ₹1000 payment:**
```
Phase 1 (payment PROCESSING):
  DEBIT  CUSTOMER_FUNDS    1000  (customer funds reduced)
  CREDIT CLEARING          1000  (funds in transit)

Phase 2 (payment SUCCEEDED):
  DEBIT  CLEARING          1000  (clearing resolved)
  CREDIT MERCHANT_PAYABLE  950   (merchant gets 95%)
  CREDIT REVENUE_FEES       50   (PayFlow takes 5%)

Phase 3 (settlement):
  DEBIT  MERCHANT_PAYABLE  950
  CREDIT BANK_PAYOUT       950
```

**Implementation note:** Ledger entries are written in the **same DB transaction** as the payment status update. This is the critical correctness guarantee.

**Tests required:**
- Unit: `LedgerService.recordPayment()` — assert entry count and balance
- Unit: `LedgerService.recordRefund()` — partial and full refund
- Integration: SUM(DEBIT) == SUM(CREDIT) after 1000 random payments + refunds
- Integration: Ledger transaction is atomic with payment status update

---

### Phase 7 — Risk Engine + Observability (1 week)
**Prerequisites:** Phase 1 complete (payments exist)

**Risk module:**
```
src/modules/risk/
  risk.service.ts
  risk.rules/
    high-amount.rule.ts
    velocity.rule.ts
    failed-attempts.rule.ts
    new-customer.rule.ts
  risk.module.ts
```

**Rule interface:**
```typescript
interface RiskRule {
  name: string;
  evaluate(context: RiskContext): Promise<RuleResult>;
}

interface RuleResult {
  triggered: boolean;
  score: number;   // 0-100 contribution
  reason?: string;
}
```

**Observability module:**
```
src/modules/observability/
  metrics.service.ts          ← Prometheus counters/histograms
  tracing.service.ts          ← OpenTelemetry spans
  observability.module.ts
```

**Metrics to add:**
- `payflow_payments_total{status}` — counter
- `payflow_payment_latency_seconds` — histogram (p50/p95/p99)
- `payflow_processor_latency_seconds` — histogram
- `payflow_webhook_deliveries_total{status}` — counter
- `payflow_outbox_lag_events` — gauge (pending outbox events)
- `payflow_reconciliation_resolved_total` — counter

**Expose at:** `GET /metrics` (Prometheus scrape endpoint, protected by IP allowlist or separate port)

---

### Phase 8 — Chaos & Load Testing (ongoing)
**Prerequisites:** Phase 5 complete

**Chaos config endpoint:**
```
POST /v1/internal/chaos  (ADMIN only, disabled in production)
Body: { target: 'processor', mode: 'timeout', duration_ms: 30000 }
```

**Load testing:** Use k6 or Artillery  
**Target:** 100 RPS → measure p50/p95/p99, error rate  
**Bottleneck sequence:** DB connections → Redis connections → Kafka consumer lag

---

## 13. Testing Strategy

### Philosophy

> Every test must prove a specific correctness guarantee, not just exercise code paths.

### Idempotency Tests

```typescript
describe('Idempotency', () => {
  it('same key + same body → same payment ID, 200 on replay')
  it('same key + different body → 409 Conflict')
  it('100 concurrent identical requests → 1 payment, 100 consistent responses')
  it('concurrent requests under DB lock contention → no duplicate payments')
  it('in-flight request → 409 "request in progress"')
  it('expired idempotency key → treated as new request')
})
```

### State Machine Tests

```typescript
describe('PaymentStateMachine', () => {
  // Legal transitions — all must succeed
  it.each(LEGAL_TRANSITIONS_LIST)('allows %s → %s', ...)
  
  // Illegal transitions — all must throw
  it('SUCCEEDED → PROCESSING throws InvalidStateTransitionException')
  it('FAILED → SUCCEEDED throws InvalidStateTransitionException')
  it('CANCELLED → any throws InvalidStateTransitionException')
  it('terminal states cannot be left')
})
```

### Processor Failure Tests

```typescript
describe('ProcessorFailures', () => {
  it('success → payment SUCCEEDED')
  it('timeout (10s) → payment UNKNOWN, attempt logged as TIMEOUT')
  it('processor returns 500 → payment FAILED, failure_code set')
  it('slow response (> 9.9s) → timeout handling correct')
  it('duplicate response → idempotency guards prevent double processing')
  it('unknown_result → payment UNKNOWN (cannot assume failure)')
})
```

### Reconciliation Tests

```typescript
describe('Reconciliation', () => {
  it('payment UNKNOWN → processor succeeded → payment becomes SUCCEEDED')
  it('payment UNKNOWN → processor failed → payment becomes FAILED')
  it('payment UNKNOWN → processor still unknown → remains UNKNOWN')
  it('reconciliation run is logged in reconciliation_runs')
  it('multiple UNKNOWN payments processed in single run')
  it('processor unavailable during reconciliation → payments remain UNKNOWN, run logged as partial')
})
```

### Outbox Tests

```typescript
describe('TransactionalOutbox', () => {
  it('payment created → outbox_event inserted in same transaction')
  it('payment DB commit succeeds + Kafka unavailable → outbox event retried')
  it('outbox worker crash mid-publish → event reprocessed (at-least-once)')
  it('FOR UPDATE SKIP LOCKED prevents two workers processing same event')
  it('event published → status set to PUBLISHED, not reprocessed')
  it('consumer receives duplicate event_id → skips processing')
})
```

### Ledger Tests

```typescript
describe('Ledger', () => {
  it('SUM(debits) == SUM(credits) for any payment')
  it('refund creates balanced reversal entries')
  it('partial refund: only refunded amount reversed')
  it('fee accounting: merchant receives amount - fee')
  it('ledger_entry and payment status update are atomic')
  it('cannot post to non-existent account (FK enforced)')
  it('cannot post negative amount (CHECK enforced)')
})
```

### Webhook Tests

```typescript
describe('Webhooks', () => {
  it('payment.succeeded event → webhook delivery created → merchant server called')
  it('merchant returns 200 → status=SUCCEEDED, no retry')
  it('merchant returns 500 → retry with backoff schedule')
  it('after 5 failures → status=DEAD (DLQ)')
  it('duplicate delivery prevented by idempotency_key UNIQUE constraint')
  it('HMAC signature verifiable by merchant')
  it('invalid signature → merchant can reject (test signature header format)')
  it('merchant server timeout → counts as failure, retry scheduled')
})
```

---

## 14. Failure Scenarios

| Scenario | Expected Behavior |
|---|---|
| Processor timeout during charge | Payment → UNKNOWN. No retry (avoids double-charge). Reconciliation resolves. |
| Processor succeeds, response lost | Same as timeout. UNKNOWN → reconciliation via `processor.getPayment()`. |
| DB unavailable during payment creation | 503. Idempotency key not stored (rollback). Safe to retry with same idempotency key. |
| Redis unavailable | API still works (degrade gracefully). Rate limiting may fail open. Idempotency falls back to DB-only path. |
| Kafka unavailable | Outbox events accumulate. Payments still created. Events published when Kafka recovers. |
| Outbox worker crash | Next worker run picks up PENDING events (`FOR UPDATE SKIP LOCKED`). At-least-once guarantee. |
| Webhook endpoint down | Retry with exponential backoff. After 5 failures → DLQ. |
| Duplicate payment attempt | Idempotency key prevents. Second request gets replayed response. |
| Concurrent cancels | DB UPDATE ... WHERE status='CREATED' + optimistic version check. One succeeds, one gets 409. |
| Partial refund exceeds payment | Validated in service layer. 400 returned. No ledger entries written. |
| Ledger imbalance | Should be impossible due to atomicity. Add daily reconciliation check: SELECT and assert SUM. |

---

## 15. Documentation Plan

```
docs/
├── architecture.md           ← System overview, module map, data flow diagrams
├── payment-lifecycle.md      ← State machine diagram, all transitions, terminal states
├── idempotency.md            ← Why, how, failure cases, expiry
├── concurrency.md            ← DB locks, FOR UPDATE SKIP LOCKED, optimistic locking
├── failure-handling.md       ← Timeout, UNKNOWN, reconciliation flow
├── reconciliation.md         ← Worker schedule, processor query, resolution logic
├── ledger.md                 ← Double-entry theory, account types, journal entries for each scenario
├── webhook-delivery.md       ← Registration, signing, retry schedule, DLQ
├── event-driven-architecture.md ← Kafka topics, event schemas, consumer groups
├── outbox-pattern.md         ← Why outbox, transaction boundary, worker logic
├── observability.md          ← Metrics, traces, log fields, Grafana dashboards
├── security.md               ← API key hashing, HMAC signing, rate limiting per merchant
├── scaling.md                ← Connection pooling, worker scaling, Kafka partition strategy
├── load-testing.md           ← k6 scripts, result analysis, bottleneck identification
└── tradeoffs.md              ← Why not microservices, why PostgreSQL for ledger, why BIGINT for amounts
```

**Each doc must answer WHY, not just WHAT.**

---

## 16. Risks and Tradeoffs

### Risk: Existing `Transaction` model naming collision
**Issue:** The `Transaction` Prisma model is personal finance (income/expense). The new `Payment` concept is different. Engineers unfamiliar with the codebase will conflate these.  
**Mitigation:** Never rename the existing `Transaction` table (migration risk). Instead: strong naming convention — `PaymentService`, `PaymentRepository`, clearly separate module. Document the distinction in architecture.md.

### Risk: Prisma client generated to `../generated/prisma`
**Issue:** The custom output path means TypeScript imports come from `'../../../generated/prisma/client'`. As new modules are added at different nesting levels, import paths vary. A misconfigured tsconfig.paths could silently break.  
**Mitigation:** Add a tsconfig path alias: `@/generated/prisma/client` → `generated/prisma/client`. Consistent import everywhere.

### Risk: Single-node Redis for idempotency
**Issue:** Redis failure takes down idempotency + caching. For idempotency specifically, the DB UNIQUE constraint is the final safety net, but Redis-level locking (for in-flight detection) fails.  
**Mitigation:** The DB UNIQUE constraint on `(merchant_id, key)` is the correctness guarantee. Redis is an optimization. Document this clearly.

### Risk: In-process workers compete with request serving
**Issue:** If the outbox worker does heavy DB work on the same process, it can degrade request latency.  
**Mitigation:** `FOR UPDATE SKIP LOCKED` with batch limits (100 events per run). Worker uses a separate DB connection pool. Measure before optimizing.

### Risk: Kafka introduces operational complexity
**Issue:** Kafka requires Zookeeper (or KRaft), topic management, consumer group coordination, and monitoring. This doubles the operations surface.  
**Mitigation:** Use KRaft mode (no Zookeeper). Use a single-broker setup for dev. Document that Kafka is optional — the outbox pattern works without Kafka if you replace the publisher with direct HTTP calls.

### Risk: At-least-once Kafka delivery
**Issue:** Kafka can redeliver events. Consumers must be idempotent.  
**Mitigation:** Every consumer checks `event_id` before processing. This is tested as a first-class requirement.

---

## 17. What NOT to Build

| Item | Why Not |
|---|---|
| Real payment processor integration | Requires API keys, test accounts, compliance. The simulator is superior for demonstrating correctness. |
| Microservices split | Premature. Adds network failures, distributed transactions, and service discovery complexity that obscures the core financial correctness story. |
| ML risk scoring | Deterministic rules are testable. ML requires training data, model serving, and feature pipelines — none of which demonstrate financial backend skills. |
| Currency conversion | Out of scope. Adds complexity without demonstrating the target skills. |
| UI / Frontend | This is a backend engineering project. Swagger docs suffice. |
| Stripe webhook compatibility | Building Stripe-compatible APIs is different from building reliable infrastructure. |
| Multi-region / geo-routing | Requires DNS, latency-based routing, and cross-region replication. Overkill for this scope. |
| GraphQL | REST + OpenAPI is sufficient and matches the existing API conventions. |
| gRPC | No inter-service communication (modular monolith). gRPC adds nothing here. |

---

## 18. Final Recommended Implementation Order

```
Phase 0 (2 days):     Fix Prisma URL, dashboard cache bug, PayFlowException, CORS
Phase 1 (1 week):     Merchants, Customers, Payments, State Machine, Processor skeleton
Phase 2 (1 week):     Idempotency, Concurrency tests, Refunds
Phase 3 (1 week):     Processor simulator failure modes, UNKNOWN, Reconciliation worker
Phase 4 (1.5 weeks):  Transactional Outbox, Kafka, Events, Consumer idempotency
Phase 5 (1 week):     Webhooks, HMAC signatures, Retry, DLQ
Phase 6 (1 week):     Double-entry Ledger, Fees, Settlement accounting
Phase 7 (1 week):     Risk engine, Prometheus metrics, OpenTelemetry traces
Phase 8 (ongoing):    Chaos injection, Load testing, Bottleneck analysis

Total estimated time: 8-10 weeks for one engineer working full-time
```

**Start Phase 0 first. Do not skip it.** The cache bug is a data privacy issue (User A seeing User B's cached data) and must be fixed before new features are added.

---

## 19. Definition of Done for Complete Project

The PayFlow project is complete when:

### Correctness
- [ ] 100 concurrent identical payment requests produce exactly 1 payment
- [ ] `SUM(ledger DEBIT) == SUM(ledger CREDIT)` invariant holds after 10,000 random payment operations
- [ ] No payment can skip the state machine — every illegal transition throws with the correct error
- [ ] A payment that was "charged" by the processor but whose response was lost is eventually resolved (not lost, not double-charged)

### Failure Recovery
- [ ] Application recovers to correct state after simulated processor timeout
- [ ] Outbox events are never permanently lost — published at-least-once even across worker crashes
- [ ] Webhook deliveries retry correctly and dead-letter after exhaustion
- [ ] Kafka unavailability does not prevent payment creation — only delays event publishing

### Observability
- [ ] Every payment has a traceable request ID, payment ID, and merchant ID in all logs
- [ ] Prometheus metrics endpoint exposes payment latency, success rate, and outbox lag
- [ ] A complete OpenTelemetry trace exists for `POST /v1/payments` → processor → Kafka → webhook

### Testing
- [ ] State machine: 100% coverage of all legal + illegal transitions
- [ ] Idempotency: concurrent duplicate request test passes
- [ ] Reconciliation: UNKNOWN → SUCCEEDED flow covered by integration test
- [ ] Ledger: balance invariant test with 1000 payments
- [ ] Webhook: retry + DLQ flow covered

### API
- [ ] All endpoints documented in Swagger with request/response examples
- [ ] Error responses include machine-readable `code` field
- [ ] `Idempotency-Key` is required for all mutating payment endpoints

### Security
- [ ] API keys stored as SHA-256 hashes (raw key shown only at creation)
- [ ] Webhook payloads signed with HMAC-SHA256
- [ ] Rate limiting applied per merchant, not just globally

### Documentation
- [ ] `docs/` directory contains all 15 planned documents
- [ ] Each document explains WHY, not just WHAT
- [ ] `tradeoffs.md` explicitly addresses: why not microservices, why BIGINT for money, why transactional outbox, why at-least-once + idempotent consumers

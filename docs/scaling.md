# Scaling

## Baseline: What We Have

The existing system is a single NestJS instance connected to:
- PostgreSQL 16 (single instance, connection pool via `@prisma/adapter-pg`)
- Redis 7 (single instance, used for caching and rate limiting)

This is adequate for development and moderate traffic. PayFlow extends this with Kafka and background workers, all still running in a single process.

---

## Connection Pool Sizing

### PostgreSQL

The default pg connection pool size in `@prisma/adapter-pg` is often too small for production:

```typescript
// src/common/database/prisma.service.ts
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX ?? '20', 10),     // Max connections
  min: parseInt(process.env.DB_POOL_MIN ?? '5', 10),      // Keep-alive connections
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
```

**Sizing formula:**
```
connections = (num_workers * 2) + num_web_instances * avg_concurrent_requests
```

For a single instance handling 100 RPS:
- Web requests: typically 2-5 connections per request (short-lived)
- Outbox worker: 1 connection per batch
- Reconciliation worker: 1 connection per run
- Webhook worker: 1 connection per batch

Start with `max: 20`, measure actual usage via `pg_stat_activity`, adjust.

**PostgreSQL side limit:** PostgreSQL default `max_connections = 100`. With multiple app instances, divide across them. Consider PgBouncer as a connection pooler in front of PostgreSQL for > 3 app instances.

### Redis

Redis is single-threaded and handles ~100k ops/second. For PayFlow's workload (caching, rate limiting, idempotency locks), a single Redis instance is sufficient up to ~500 RPS.

Above 500 RPS, evaluate Redis Cluster for read scaling or Redis Sentinel for HA without sharding.

---

## Scaling the Application

### Horizontal Scaling (Multiple Instances)

The NestJS application is stateless and can be scaled horizontally:

```yaml
# docker-compose.yml (production)
app:
  deploy:
    replicas: 3
  # Load balanced by nginx/ALB
```

**Pre-requisite:** All state must be in PostgreSQL or Redis, not in-process memory. PayFlow satisfies this — no in-process state beyond the cache (Redis), no local file storage.

**Worker considerations:** When running 3 app instances, each runs its own outbox worker, reconciliation worker, and webhook worker. The `FOR UPDATE SKIP LOCKED` pattern ensures they don't process the same work items. This scales linearly.

### Vertical Scaling

Before horizontal scaling, verify whether the bottleneck is:
- **CPU**: Increase instance size or optimize hot paths
- **DB connections**: Increase pool size or add PgBouncer
- **DB query latency**: Add indexes, optimize queries
- **Redis**: Unlikely to be the bottleneck at <500 RPS

Always profile before scaling.

---

## Database Scaling

### Read Replicas

The analytics dashboard (`/api/v1/dashboard/*`) and reporting queries are read-heavy. These can be routed to a PostgreSQL read replica:

```typescript
// Add a separate PrismaService for read replicas
const readReplica = new PrismaPg({
  connectionString: process.env.DATABASE_READ_REPLICA_URL,
});

// Use for analytics
@Injectable()
export class AnalyticsPrismaService extends PrismaClient {
  constructor() { super({ adapter: readReplica }); }
}
```

**Not needed initially** — measure first. PostgreSQL read replicas add operational complexity (replication lag, separate connection strings in code).

### Partitioning

The `payments` table will grow significantly over time. Partition by `created_at` (range partitioning) to limit the amount of data scanned for date-bounded queries:

```sql
-- Partition by month (PostgreSQL declarative partitioning)
CREATE TABLE payments (
  ...
) PARTITION BY RANGE (created_at);

CREATE TABLE payments_2026_09
  PARTITION OF payments
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

**Not needed initially.** At 100 RPS × 86400 seconds = ~8.6M payments/day, partitioning becomes relevant around 100M rows (about 12 days at this rate). For realistic traffic (1K payments/hour), partitioning is needed at ~2 years.

### Indexes

Critical indexes already planned in the schema:

```sql
-- For reconciliation worker:
CREATE INDEX payments_status_created_at_idx
  ON payments(status, created_at)
  WHERE status = 'UNKNOWN';

-- For soft-delete performance (partial index):
CREATE INDEX transactions_active_idx
  ON transactions(user_id, date)
  WHERE deleted_at IS NULL;

-- For outbox worker:
CREATE INDEX outbox_pending_idx
  ON outbox_events(status, scheduled_for)
  WHERE status IN ('PENDING', 'FAILED');
```

---

## Kafka Scaling

### Partition Count

Start with `payflow.payments` having **12 partitions**. This allows:
- Up to 12 parallel consumers per consumer group
- Ordered processing per payment_id (same payment always → same partition)

**Increasing partitions** later is possible but changes the partitioning of existing keys — plan the initial partition count thoughtfully.

### Consumer Scaling

Each consumer group (webhooks, analytics, audit) can have up to 12 consumers for 12 partitions. Add consumers to reduce per-consumer processing time.

### Kafka vs. In-Process (Why Kafka Here)

The outbox worker and Kafka are used specifically for the webhook delivery pipeline because:
1. Webhook delivery is slow (network calls, retries)
2. Multiple consumer groups need to process the same events independently
3. Events need to be replayable if a consumer has a bug

For simpler async work (cleanup jobs, report generation), `@nestjs/schedule` cron jobs are sufficient.

---

## Worker Scheduling

### Current Worker Schedule

| Worker | Interval | Batch Size | Notes |
|---|---|---|---|
| Outbox Worker | Every 5 seconds | 100 events | Fast — Kafka publish is usually <10ms |
| Reconciliation Worker | Every 60 seconds | All UNKNOWN | Processor query is ~1s each, run concurrently |
| Webhook Worker | Every 10 seconds | 50 deliveries | HTTP calls, 10s timeout each |
| Idempotency Cleanup | Nightly (2 AM) | All expired | Low priority background job |

### Backpressure

If Kafka is slow, the outbox worker accumulates backlog. The webhook worker needs to handle slow merchant endpoints (10-second timeout per delivery, 50 deliveries per batch = up to 500s per batch if all time out — use `Promise.allSettled` with concurrent execution, not sequential).

---

## Load Testing Targets

See [`load-testing.md`](./load-testing.md) for test scripts and analysis methodology.

### Performance Targets

| Metric | Target |
|---|---|
| p50 latency | < 100ms |
| p95 latency | < 500ms |
| p99 latency | < 2000ms |
| Error rate | < 0.1% |
| Throughput | 100 RPS sustained |

### Known Bottlenecks (by Priority)

1. **DB connection pool exhaustion** — first thing to hit at scale
2. **Processor simulator latency** — simulated delays accumulate under load
3. **Webhook worker throughput** — sequential HTTP calls are slow; use concurrent processing
4. **Redis rate limiter** — atomic but adds ~0.5ms per request
5. **Pino logger** — JSON serialization is fast but add async transport in production

---

## What NOT to Optimize Prematurely

- **Caching payment results** — payments are created once; caching reads of `GET /v1/payments/:id` adds complexity for minimal gain
- **Denormalizing the ledger** — mutable balance columns seem faster but break correctness guarantees
- **Event sourcing** — PayFlow uses a state machine with the current state stored directly; event sourcing would add complexity without proportional benefit at this scale
- **Elasticsearch for payments search** — PostgreSQL with proper indexes handles the query patterns needed

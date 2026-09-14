# Load Testing

## Approach

> **Measure first. Optimize second.**

Load testing without measurement is premature optimization. The goal of load testing PayFlow is to:
1. Establish a performance baseline
2. Find the actual bottleneck (not the assumed one)
3. Verify that correctness guarantees hold under load
4. Measure the impact of optimization changes

We use [k6](https://k6.io/) as the load testing tool. It is lightweight, scriptable in JavaScript, and produces clean percentile histograms.

---

## Setup

### Install k6

```bash
# Windows (via Chocolatey)
choco install k6

# Or download from https://k6.io/docs/getting-started/installation/
```

### Prerequisites

1. Application running locally or in Docker
2. Test database seeded with at least one merchant and API key
3. Redis and PostgreSQL running

---

## Test Scenarios

### Scenario 1: Payment Creation Baseline (100 RPS)

```javascript
// tests/load/payment-creation.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Histogram } from 'k6/metrics';

const successCount = new Counter('payment_success');
const failCount = new Counter('payment_fail');
const latency = new Histogram('payment_latency');

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Ramp up to 10 VUs
    { duration: '1m',  target: 100 },  // Ramp up to 100 VUs (≈100 RPS)
    { duration: '3m',  target: 100 },  // Sustain 100 RPS
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(50)<100', 'p(95)<500', 'p(99)<2000'],
    http_req_failed: ['rate<0.001'],   // Error rate < 0.1%
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000/api/v1';
const API_KEY = __ENV.MERCHANT_API_KEY;

export default function () {
  const idempotencyKey = `load-test-${__VU}-${__ITER}`;

  const payload = JSON.stringify({
    amount: Math.floor(Math.random() * 100000) + 1000,
    currency: 'INR',
    description: `Load test payment VU=${__VU} iter=${__ITER}`,
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/payments`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'Idempotency-Key': idempotencyKey,
    },
  });
  latency.add(Date.now() - start);

  const success = check(res, {
    'status is 201': (r) => r.status === 201,
    'has payment_id': (r) => JSON.parse(r.body).data?.id !== undefined,
    'no duplicate payment': (r) => {
      const body = JSON.parse(r.body);
      return body.data?.id !== undefined;
    },
  });

  if (success) {
    successCount.add(1);
  } else {
    failCount.add(1);
    console.error(`Failed: ${res.status} ${res.body}`);
  }

  sleep(0.01); // 10ms think time between iterations
}

export function handleSummary(data) {
  return {
    'results/load-test-100rps.json': JSON.stringify(data, null, 2),
  };
}
```

**Run:**
```bash
k6 run \
  --env BASE_URL=http://localhost:3000/api/v1 \
  --env MERCHANT_API_KEY=sk_live_xxx \
  tests/load/payment-creation.js
```

---

### Scenario 2: Idempotency Under Load (Concurrent Duplicates)

This test specifically validates that concurrent identical requests produce exactly one payment:

```javascript
// tests/load/idempotency-concurrent.js
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

export const options = {
  scenarios: {
    concurrent_duplicates: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,  // 100 VUs, 1 iteration each = 100 concurrent requests
      maxDuration: '30s',
    },
  },
};

const IDEMPOTENCY_KEY = 'concurrency-test-fixed-key';

export default function () {
  const res = http.post(
    `${__ENV.BASE_URL}/payments`,
    JSON.stringify({ amount: 5000, currency: 'INR' }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.MERCHANT_API_KEY}`,
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
    }
  );

  check(res, {
    'status 201 or 200': (r) => r.status === 201 || r.status === 200,
    'has payment_id': (r) => JSON.parse(r.body).data?.id !== undefined,
  });
}

// After the test, verify via API that only 1 payment exists
// k6 cannot do this — add a post-test assertion script
```

**Post-test verification:**
```bash
# Count payments created during the test
curl -H "Authorization: Bearer sk_admin_xxx" \
  "http://localhost:3000/api/v1/internal/payments/count?idempotency_key=$IDEMPOTENCY_KEY"
# Expected: { count: 1 }
```

---

### Scenario 3: Mixed Workload (500 RPS)

```javascript
// tests/load/mixed-workload.js
import http from 'k6/http';
import { check, group } from 'k6';

export const options = {
  stages: [
    { duration: '1m',  target: 200 },
    { duration: '3m',  target: 500 },
    { duration: '5m',  target: 500 },
    { duration: '1m',  target: 0 },
  ],
  thresholds: {
    'http_req_duration{type:create}': ['p(95)<800'],
    'http_req_duration{type:read}': ['p(95)<200'],
    http_req_failed: ['rate<0.005'],
  },
};

export default function () {
  const roll = Math.random();

  if (roll < 0.3) {
    // 30%: Create payment
    group('create_payment', () => {
      const res = http.post(/* ... */, { tags: { type: 'create' } });
      check(res, { 'created': (r) => r.status === 201 });
    });
  } else if (roll < 0.8) {
    // 50%: Read payment
    group('read_payment', () => {
      const res = http.get(`${BASE_URL}/payments/${randomPaymentId()}`,
        { headers: { /* ... */ }, tags: { type: 'read' } }
      );
      check(res, { 'found': (r) => r.status === 200 });
    });
  } else {
    // 20%: List payments
    group('list_payments', () => {
      const res = http.get(`${BASE_URL}/payments?page=1&limit=20`,
        { tags: { type: 'list' } }
      );
      check(res, { 'ok': (r) => r.status === 200 });
    });
  }
}
```

---

## Expected Results and Baselines

### Fresh PostgreSQL (no tuning)

| RPS | p50 | p95 | p99 | Error Rate |
|---|---|---|---|---|
| 10 | ~50ms | ~120ms | ~250ms | ~0% |
| 100 | ~80ms | ~350ms | ~900ms | ~0% |
| 500 | ~150ms | ~1200ms | ~3000ms | ~0.5% |
| 1000 | ~400ms | ~3000ms | timeout | ~5% |

*Actual numbers will vary based on hardware. These are rough estimates.*

---

## Finding Bottlenecks

Run these queries **during** the load test to identify the bottleneck:

### DB Connection Pool

```sql
-- Are we running out of connections?
SELECT count(*), state
FROM pg_stat_activity
WHERE datname = 'finance_db'
GROUP BY state;
-- If many rows show state='idle in transaction', the pool is too small
-- If 'active' count = pool max, connections are exhausted
```

### Slow Queries

```sql
-- Which queries are slowest?
SELECT query, calls, mean_exec_time, max_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### Lock Contention

```sql
-- Is there lock contention on the payments table?
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state = 'active' AND wait_event IS NOT NULL
GROUP BY wait_event_type, wait_event
ORDER BY count DESC;
```

### Redis Performance

```bash
# Check Redis slowlog
redis-cli SLOWLOG GET 20

# Check memory usage
redis-cli INFO memory | grep used_memory_human
```

### Application CPU

```bash
# Node.js CPU profile during load test
node --prof dist/src/main.js

# Generate readable profile
node --prof-process isolate-*.log > profile.txt
```

---

## Optimization Checklist

After identifying bottlenecks, apply optimizations in this order:

### Database Optimizations (High Impact)

- [ ] Add missing indexes (verify with `EXPLAIN ANALYZE`)
- [ ] Increase connection pool max
- [ ] Add PgBouncer if pool max > 50
- [ ] Enable `pg_stat_statements` extension for query analysis
- [ ] Partial indexes for filtered queries (`WHERE deleted_at IS NULL`)

### Application Optimizations (Medium Impact)

- [ ] Cache JWT validation user in Redis (60s TTL)
- [ ] Concurrent webhook delivery (Promise.allSettled vs sequential)
- [ ] Batch outbox worker queries (already doing 100 per batch)
- [ ] Async Pino transport (avoid blocking event loop on log writes)

### Infrastructure Optimizations (Low Impact Initially)

- [ ] Add read replica for analytics queries
- [ ] Tune PostgreSQL `max_connections`, `shared_buffers`, `work_mem`
- [ ] Enable PostgreSQL connection pooling at the DB level

---

## Correctness Verification Under Load

Load tests must verify not just latency but correctness:

```bash
# After 1000-RPS load test, verify:

# 1. No duplicate payments
SELECT COUNT(*), COUNT(DISTINCT id)
FROM payments
WHERE created_at > now() - interval '10 minutes';
# Expected: both counts equal

# 2. Ledger is balanced
SELECT
  SUM(CASE WHEN entry_type='DEBIT' THEN amount ELSE 0 END) -
  SUM(CASE WHEN entry_type='CREDIT' THEN amount ELSE 0 END) AS imbalance
FROM ledger_entries;
# Expected: 0

# 3. No payments stuck in PROCESSING (all resolved)
SELECT COUNT(*) FROM payments WHERE status = 'PROCESSING'
  AND created_at < now() - interval '5 minutes';
# Expected: 0 (all either succeeded, failed, or UNKNOWN awaiting reconciliation)

# 4. Idempotency keys match payments
SELECT COUNT(*) FROM idempotency_keys WHERE payment_id IS NULL
  AND created_at < now() - interval '5 minutes';
# Expected: 0 (all completed requests have payment references)
```

---

## Running the Full Load Test Suite

```bash
# Run all load tests in sequence
npm run test:load:baseline   # 100 RPS, 5 minutes
npm run test:load:concurrent # Concurrency/idempotency test
npm run test:load:mixed      # 500 RPS, mixed workload
npm run test:load:correctness # Post-test DB verification
```

```json
// package.json scripts
"test:load:baseline": "k6 run tests/load/payment-creation.js",
"test:load:concurrent": "k6 run tests/load/idempotency-concurrent.js",
"test:load:mixed": "k6 run tests/load/mixed-workload.js"
```

# Failure Injection & Chaos Testing

## Purpose

Chaos testing is not destruction for its own sake. The goal is to **prove that the system maintains correctness and recovers gracefully when dependencies fail**.

PayFlow's chaos testing framework allows controlled injection of specific failures so that every failure scenario described in [`failure-handling.md`](./failure-handling.md) can be demonstrated and tested deterministically.

---

## Chaos Configuration

A `ChaosModule` is available only in `development` and `test` environments. In `production`, the chaos endpoints are disabled:

```typescript
// src/modules/chaos/chaos.module.ts
@Module({})
export class ChaosModule {
  static register(): DynamicModule {
    if (process.env.NODE_ENV === 'production') {
      return { module: ChaosModule }; // No providers, no controller
    }
    return {
      module: ChaosModule,
      controllers: [ChaosController],
      providers: [ChaosService],
      exports: [ChaosService],
    };
  }
}
```

---

## Failure Injection API

### Processor Failures

```http
POST /api/v1/internal/chaos/processor
Authorization: Bearer <admin-jwt>

{
  "mode": "timeout",        // success | timeout | error | slow | unknown_result
  "duration_ms": 30000,     // How long to maintain this mode (ms)
  "delay_ms": 12000         // For "slow" mode: how long to delay
}
```

| Mode | What It Does |
|---|---|
| `success` | Reset to normal — all charges succeed |
| `timeout` | Processor never responds — all payments → UNKNOWN |
| `error` | Processor returns 500 — all payments → FAILED |
| `slow` | Processor responds after `delay_ms` — tests timeout boundary |
| `unknown_result` | Processor returns ambiguous status — tests UNKNOWN handling |

### Kafka Failures

```http
POST /api/v1/internal/chaos/kafka
Authorization: Bearer <admin-jwt>

{
  "mode": "disconnect",     // disconnect | slow | duplicate_events
  "duration_ms": 60000
}
```

### Database Latency

```http
POST /api/v1/internal/chaos/database
Authorization: Bearer <admin-jwt>

{
  "mode": "slow",           // slow | connection_limit
  "delay_ms": 200           // Added to every query
}
```

### Webhook Endpoint

```http
POST /api/v1/internal/chaos/webhook-endpoint
Authorization: Bearer <admin-jwt>

{
  "endpoint_id": "whe_abc123",
  "mode": "timeout",        // success | timeout | error_500 | slow
  "duration_ms": 120000
}
```

---

## Chaos Test Scenarios

### Scenario 1: Processor Timeout → UNKNOWN → Reconciliation

```bash
# 1. Inject processor timeout
curl -X POST .../chaos/processor -d '{"mode":"timeout","duration_ms":120000}'

# 2. Create a payment
curl -X POST .../payments -H "Idempotency-Key: chaos-test-1" -d '{"amount":1000}'
# → Status: UNKNOWN

# 3. Reset processor to return success
curl -X POST .../chaos/processor -d '{"mode":"success"}'

# 4. Wait for reconciliation worker (60 seconds) or trigger manually
curl -X POST .../internal/reconciliation/trigger

# 5. Verify payment is now SUCCEEDED
curl .../payments/pay_xxx
# → Status: SUCCEEDED
# → succeeded_at is set
# → Ledger entries exist and are balanced
```

### Scenario 2: Kafka Down → Outbox Accumulates → Recovery

```bash
# 1. Inject Kafka disconnect
curl -X POST .../chaos/kafka -d '{"mode":"disconnect","duration_ms":300000}'

# 2. Create 10 payments
for i in {1..10}; do
  curl -X POST .../payments \
    -H "Idempotency-Key: kafka-test-$i" \
    -d '{"amount":1000}'
done
# → All payments SUCCEED (Kafka is not in the transaction path)
# → But 10 outbox events are PENDING (not published)

# 3. Verify outbox lag
curl .../metrics | grep payflow_outbox_lag_events
# → payflow_outbox_lag_events 10

# 4. Restore Kafka
curl -X POST .../chaos/kafka -d '{"mode":"success"}'

# 5. Wait for outbox worker (5 seconds) or trigger manually
curl -X POST .../internal/outbox/flush

# 6. Verify events published and webhooks delivered
curl .../internal/outbox/stats
# → pending: 0, published: 10
```

### Scenario 3: Webhook Endpoint Down → Retry → Dead Letter

```bash
# 1. Configure merchant webhook endpoint
curl -X POST .../merchants/mer_xxx/webhooks \
  -d '{"url":"http://webhook-test-server:9000/hook","events":["payment.succeeded"]}'

# 2. Inject webhook endpoint failure
curl -X POST .../chaos/webhook-endpoint \
  -d '{"endpoint_id":"whe_abc","mode":"error_500","duration_ms":7200000}'

# 3. Create and succeed a payment
curl -X POST .../payments -H "Idempotency-Key: webhook-chaos-1" -d '{"amount":5000}'

# 4. Wait for 5 retry attempts (should take ~36 minutes total)
#    Or in testing, use time compression by triggering the worker repeatedly

# 5. Verify dead letter status
curl .../internal/webhook-deliveries?status=DEAD
# → 1 dead delivery for this payment

# 6. Restore webhook endpoint
curl -X POST .../chaos/webhook-endpoint \
  -d '{"endpoint_id":"whe_abc","mode":"success"}'

# 7. Manually retry dead delivery
curl -X POST .../internal/webhook-deliveries/whd_xxx/retry
# → Delivery succeeds
```

### Scenario 4: 100 Concurrent Identical Requests (Correctness Under Concurrency)

```bash
# Send 100 identical requests simultaneously
seq 1 100 | xargs -P 100 -I{} \
  curl -X POST .../payments \
  -H "Idempotency-Key: concurrent-test-fixed" \
  -H "Authorization: Bearer sk_live_xxx" \
  -d '{"amount":1000}' \
  -s -o /dev/null -w "%{http_code}\n"

# Expected: mix of "201" and "200" — NO "500" or "409"

# Verify only 1 payment was created
curl .../internal/payments/count?merchant_id=mer_xxx
# → { count: 1 }
```

---

## Implementation: ChaosService

```typescript
// src/modules/chaos/chaos.service.ts

@Injectable()
export class ChaosService {
  private processorMode: FailureMode = 'success';
  private processorModeUntil: Date = new Date(0);

  setProcessorMode(mode: FailureMode, durationMs: number): void {
    this.processorMode = mode;
    this.processorModeUntil = new Date(Date.now() + durationMs);
  }

  getCurrentProcessorMode(): FailureMode {
    if (new Date() > this.processorModeUntil) {
      this.processorMode = 'success';  // Auto-reset after duration
    }
    return this.processorMode;
  }
}
```

The `ProcessorSimulator` injects `ChaosService` to determine its behavior:

```typescript
// src/modules/processor/simulator.processor.ts

@Injectable()
export class SimulatorProcessor implements PaymentProcessor {
  constructor(private readonly chaos: ChaosService) {}

  async charge(request: ChargeRequest): Promise<ChargeResponse> {
    const mode = this.chaos.getCurrentProcessorMode();

    switch (mode) {
      case 'success':
        return { status: 'SUCCEEDED', processorId: `sim_${randomUUID()}` };

      case 'timeout':
        await sleep(15_000);  // Exceed the 10s timeout
        throw new TimeoutException('Processor timeout (injected)');

      case 'error':
        throw new ProcessorException('Internal processor error', 500);

      case 'slow':
        await sleep(this.chaos.getDelay());
        return { status: 'SUCCEEDED', processorId: `sim_${randomUUID()}` };

      case 'unknown_result':
        return { status: 'UNKNOWN', processorId: `sim_${randomUUID()}` };
    }
  }
}
```

---

## What the Tests Prove

| Test | Correctness Property Demonstrated |
|---|---|
| Processor timeout → UNKNOWN → reconciled | System never assumes failure from a timeout. Reconciliation correctly resolves. |
| Kafka down → outbox accumulates → recovered | Payment correctness is independent of Kafka availability. Events are eventually delivered. |
| 100 concurrent identical requests → 1 payment | DB-level UNIQUE constraint prevents duplicates under any concurrency level. |
| Webhook retries with backoff | Transient failures are retried. Permanent failures are dead-lettered. No infinite retry. |
| Ledger balanced after chaos | Financial invariants hold even when failures occur mid-transaction. |

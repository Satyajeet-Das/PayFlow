# Observability

## Philosophy

An unobservable system is an unmaintainable system. When something goes wrong in production — and something always goes wrong — you need to answer three questions quickly:

1. **What happened?** (Logs)
2. **When did it start and how severe is it?** (Metrics)
3. **Which requests were affected and why?** (Traces)

PayFlow implements all three pillars. Observability is not an afterthought — it is built into every payment state transition, every processor call, and every worker iteration.

---

## Structured Logging (Pino)

The existing system already uses [nestjs-pino](https://github.com/iamolegga/nestjs-pino) with structured JSON output. PayFlow extends this with consistent field names across all payment operations.

### Required Log Fields

Every payment-related log entry must include:

```json
{
  "time": "2026-09-11T13:45:23.000Z",
  "level": "info",
  "req": { "id": "req_01j9k2m3", "method": "POST", "url": "/api/v1/payments" },
  "event": "payment_succeeded",
  "payment_id": "pay_abc123",
  "merchant_id": "mer_xyz789",
  "customer_id": "cus_def456",
  "amount": 100000,
  "currency": "INR",
  "duration_ms": 342,
  "processor_latency_ms": 287
}
```

### Log Events Catalogue

| Event | Level | When |
|---|---|---|
| `payment.created` | info | New payment record created |
| `payment.processing` | info | Submitted to processor |
| `payment.succeeded` | info | Processor confirmed success |
| `payment.failed` | warn | Processor returned failure |
| `payment.unknown` | warn | Processor timed out |
| `reconciliation.resolved_succeeded` | info | UNKNOWN resolved to success |
| `reconciliation.resolved_failed` | warn | UNKNOWN resolved to failure |
| `reconciliation.still_unknown` | warn | Payment remains UNKNOWN after query |
| `outbox.batch_processed` | debug | Outbox worker completed a batch |
| `outbox.publish_failed` | error | Failed to publish event to Kafka |
| `webhook.delivered` | info | Merchant received webhook |
| `webhook.delivery_failed` | warn | Webhook attempt failed |
| `webhook.dead_lettered` | error | Delivery permanently failed |
| `risk.declined` | warn | Payment declined by risk engine |
| `idempotency.replay` | info | Returning cached response |
| `idempotency.conflict` | warn | Key reused with different body |

### Redacted Fields

The Pino logger is configured to redact sensitive information:

```typescript
// src/app.module.ts (existing configuration, extended)
pinoHttp: {
  redact: [
    'req.headers.authorization',    // JWT and API keys
    'req.headers.cookie',
    'req.body.password',
    'req.body.card_number',          // Payment card data (PCI)
    'req.body.cvv',
    '*.webhook_secret',
    '*.api_key_raw',
  ],
}
```

---

## Metrics (Prometheus)

PayFlow exposes a Prometheus-compatible metrics endpoint:

```
GET /metrics
```

This endpoint is restricted to internal networks / monitoring systems and should not be publicly accessible.

### Payment Metrics

```typescript
// src/modules/observability/metrics.service.ts

// Counter: total payments by status
const paymentsTotal = new Counter({
  name: 'payflow_payments_total',
  help: 'Total number of payments by final status',
  labelNames: ['status', 'currency', 'merchant_id'],
});

// Histogram: end-to-end payment processing time
const paymentLatency = new Histogram({
  name: 'payflow_payment_latency_seconds',
  help: 'Payment processing latency from creation to terminal state',
  labelNames: ['status'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
});

// Histogram: processor call latency only
const processorLatency = new Histogram({
  name: 'payflow_processor_latency_seconds',
  help: 'Processor API call latency',
  labelNames: ['outcome'],   // 'success', 'failure', 'timeout'
  buckets: [0.1, 0.5, 1, 2, 5, 10, 15],
});

// Gauge: current UNKNOWN payments count
const unknownPayments = new Gauge({
  name: 'payflow_unknown_payments_current',
  help: 'Number of payments currently in UNKNOWN state',
});

// Counter: reconciliation outcomes
const reconciliationTotal = new Counter({
  name: 'payflow_reconciliation_total',
  help: 'Reconciliation outcomes',
  labelNames: ['outcome'],   // 'succeeded', 'failed', 'still_unknown', 'error'
});
```

### Outbox / Kafka Metrics

```typescript
// Gauge: outbox backlog
const outboxLag = new Gauge({
  name: 'payflow_outbox_lag_events',
  help: 'Number of events pending publication to Kafka',
});

// Counter: Kafka publish outcomes
const kafkaPublishTotal = new Counter({
  name: 'payflow_kafka_publish_total',
  help: 'Kafka publish attempts',
  labelNames: ['topic', 'outcome'],  // 'success', 'failure'
});
```

### Webhook Metrics

```typescript
// Counter: webhook delivery outcomes
const webhookDeliveriesTotal = new Counter({
  name: 'payflow_webhook_deliveries_total',
  help: 'Webhook delivery attempts',
  labelNames: ['outcome'],   // 'success', 'failure', 'dead'
});

// Gauge: webhook retry backlog
const webhookRetryBacklog = new Gauge({
  name: 'payflow_webhook_retry_backlog',
  help: 'Number of webhook deliveries awaiting retry',
});

// Counter: dead-lettered deliveries
const webhookDeadTotal = new Counter({
  name: 'payflow_webhook_dead_total',
  help: 'Webhook deliveries permanently failed (dead-lettered)',
  labelNames: ['merchant_id'],
});
```

### Risk Engine Metrics

```typescript
// Histogram: risk scores distribution
const riskScoreDistribution = new Histogram({
  name: 'payflow_risk_score',
  help: 'Distribution of risk scores',
  buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

// Counter: risk decisions
const riskDecisionsTotal = new Counter({
  name: 'payflow_risk_decisions_total',
  help: 'Risk engine decisions',
  labelNames: ['decision'],   // 'allow', 'review', 'decline'
});
```

---

## Distributed Tracing (OpenTelemetry)

Every payment request generates a trace that follows the full execution path. This allows you to see exactly which operations were slow, where errors occurred, and how long each step took.

### Trace Anatomy for POST /v1/payments

```
POST /v1/payments [342ms]
├── IdempotencyService.checkOrLock [3ms]
├── RiskService.evaluate [15ms]
│   ├── VelocityRule.evaluate [8ms]
│   └── AmountRule.evaluate [2ms]
├── PaymentsRepository.create [12ms]
│   └── DB: INSERT INTO payments [10ms]
├── LedgerService.recordPaymentCreated [8ms]
│   └── DB: INSERT INTO ledger_entries [6ms]
├── ProcessorService.charge [287ms]
│   └── HTTP: POST processor/v1/charges [285ms]
├── PaymentsRepository.transitionStatus [5ms]
│   └── DB: UPDATE payments [4ms]
└── OutboxService.publish [3ms]
    └── DB: INSERT INTO outbox_events [2ms]
```

When an UNKNOWN payment is reconciled, the trace shows:

```
ReconciliationWorker.run [1200ms]
├── PaymentsRepository.findUnknown [45ms]
├── ProcessorService.getPayment [890ms]
│   └── HTTP: GET processor/v1/charges/:id [888ms]
└── PaymentsService.resolveAsSucceeded [120ms]
    ├── DB: UPDATE payments [8ms]
    ├── LedgerService.recordPaymentSuccess [25ms]
    └── OutboxService.writeEvent [15ms]
```

### Setup

```typescript
// src/modules/observability/tracing.service.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { KafkaJsInstrumentation } from 'opentelemetry-instrumentation-kafkajs';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: [
    new HttpInstrumentation(),      // Traces all HTTP calls (including processor)
    new PgInstrumentation(),        // Traces all DB queries
    new KafkaJsInstrumentation(),   // Traces Kafka publish/consume
  ],
});

sdk.start();
```

---

## Health Check Extension

The existing `/api/v1/health` endpoint is extended to include Kafka:

```typescript
// src/modules/health/health.controller.ts (extended)

@Public()
@Get()
async check() {
  const [dbStatus, redisStatus, kafkaStatus] = await Promise.allSettled([
    this.checkDatabase(),
    this.checkRedis(),
    this.checkKafka(),
  ]);

  return {
    status: allOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION ?? 'unknown',
    services: {
      database: dbStatus.status === 'fulfilled' ? 'ok' : 'error',
      redis:    redisStatus.status === 'fulfilled' ? 'ok' : 'error',
      kafka:    kafkaStatus.status === 'fulfilled' ? 'ok' : 'error',
    },
  };
}
```

---

## Alerting Rules (Prometheus Alertmanager)

```yaml
# Example alerting rules
groups:
  - name: payflow
    rules:
      - alert: HighPaymentFailureRate
        expr: rate(payflow_payments_total{status="FAILED"}[5m]) /
              rate(payflow_payments_total[5m]) > 0.1
        for: 2m
        annotations:
          summary: "Payment failure rate > 10%"

      - alert: OutboxLagCritical
        expr: payflow_outbox_lag_events > 10000
        for: 5m
        annotations:
          summary: "Outbox has >10k pending events. Kafka may be down."

      - alert: WebhookDeadLetterSpike
        expr: rate(payflow_webhook_dead_total[10m]) > 5
        for: 1m
        annotations:
          summary: "Multiple webhook endpoints are failing permanently"

      - alert: ReconciliationNotRunning
        expr: time() - payflow_last_reconciliation_run_timestamp > 300
        for: 1m
        annotations:
          summary: "Reconciliation worker has not run in >5 minutes"

      - alert: UnknownPaymentsAccumulating
        expr: payflow_unknown_payments_current > 50
        for: 10m
        annotations:
          summary: "Large number of UNKNOWN payments - processor may be down"
```

---

## Key Operational Dashboards

### Payment Health Dashboard
- Payment success rate (5min window) — target > 99%
- Payment latency p50 / p95 / p99
- UNKNOWN payments count (should be near zero)
- Processor latency trend

### Pipeline Health Dashboard
- Outbox lag (events pending Kafka publish)
- Kafka consumer lag per consumer group
- Webhook retry backlog
- Dead-lettered deliveries (by merchant)

### Financial Integrity Dashboard
- Ledger balance (should always be 0 imbalance)
- Total payment volume (today vs. yesterday)
- Reconciliation run outcomes (resolved vs. failed)

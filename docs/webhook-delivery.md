# Webhook Delivery

## Overview

When a payment event occurs (succeeded, failed, refunded), merchants need to be notified so their systems can update order status, trigger fulfillment, send receipts, etc. PayFlow delivers these notifications via **webhooks** — HTTP POST requests to a merchant-configured URL.

Webhook delivery is **not simple HTTP forwarding.** Merchant endpoints go down. Networks fail. The webhook worker must handle all of this with reliability guarantees.

---

## Registration

Merchants register webhook endpoints via the management API:

```http
POST /api/v1/merchants/:merchantId/webhooks
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "url": "https://merchant.example.com/payflow/webhooks",
  "events": ["payment.succeeded", "payment.failed", "payment.refunded"]
}
```

Response:

```json
{
  "success": true,
  "data": {
    "id": "whe_abc123",
    "url": "https://merchant.example.com/payflow/webhooks",
    "events": ["payment.succeeded", "payment.failed", "payment.refunded"],
    "secret": "whsec_9f8e7d6c5b4a3928...",
    "created_at": "2026-09-11T13:00:00.000Z"
  }
}
```

**The `secret` is shown exactly once.** It is never retrievable again. Merchants must store it securely — it is used to verify that webhook requests come from PayFlow (not an attacker).

The secret is stored in the database as a **bcrypt hash**, not plaintext.

---

## Payload Format

Every webhook request has a consistent envelope:

```json
{
  "id": "whe_evt_01j9k2m3n4p5",
  "type": "payment.succeeded",
  "created": 1726054523,
  "data": {
    "payment_id": "pay_abc123",
    "amount": 100000,
    "currency": "INR",
    "status": "SUCCEEDED",
    "merchant_id": "mer_xyz789",
    "customer_id": "cus_def456",
    "metadata": {}
  }
}
```

---

## HMAC Signature

Every webhook request includes a signature that merchants use to verify the request is from PayFlow and has not been tampered with.

### How the Signature is Generated

```typescript
// src/modules/webhooks/webhooks.signer.ts

export class WebhookSigner {
  sign(secret: string, payload: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Signed payload = "<timestamp>.<body>"
    const signedPayload = `${timestamp}.${payload}`;

    const signature = createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');

    return `t=${timestamp},v1=${signature}`;
  }
}
```

### Headers Sent with Every Request

```http
POST /payflow/webhooks HTTP/1.1
Content-Type: application/json
X-PayFlow-Signature: t=1726054523,v1=5257a869559...
X-PayFlow-Event-Type: payment.succeeded
X-PayFlow-Delivery-Id: whe_del_01j9k...

{ ...payload... }
```

### How Merchants Verify

```typescript
// Example merchant verification code
function verifyWebhook(
  payload: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const parts = signatureHeader.split(',');
  const timestamp = parts.find(p => p.startsWith('t='))?.slice(2);
  const receivedSig = parts.find(p => p.startsWith('v1='))?.slice(3);

  // Prevent replay attacks: reject timestamps older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - Number(timestamp);
  if (age > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  // Constant-time comparison prevents timing attacks
  return timingSafeEqual(Buffer.from(receivedSig!), Buffer.from(expected));
}
```

### Why Include Timestamp?

Without a timestamp, an attacker who captures a valid webhook request could replay it hours later. The timestamp + 5-minute window prevents replay attacks.

---

## Delivery Flow

```
1. Kafka consumer receives 'payment.succeeded' event
        │
2. WebhooksService.createDeliveriesForEvent(event)
   → Find all active webhook_endpoints for this merchant
     that are subscribed to this event type
   → For each endpoint: INSERT INTO webhook_deliveries
     (idempotent: skip if idempotency_key already exists)
        │
3. Webhook worker polls webhook_deliveries every 10 seconds
   → SELECT WHERE status IN ('PENDING', 'FAILED')
     AND next_attempt_at <= now()
     FOR UPDATE SKIP LOCKED
        │
4. For each delivery:
   a. Sign the payload
   b. POST to webhook URL (10-second timeout)
   c. Expect 2xx response
        │
   Success: status = SUCCEEDED
   Failure: schedule retry (see backoff table)
   After 5 failures: status = DEAD
```

---

## Retry Schedule

| Attempt | Delay After Previous | Cumulative Time |
|---|---|---|
| 1 | Immediate | 0s |
| 2 | 5 seconds | 5s |
| 3 | 30 seconds | 35s |
| 4 | 5 minutes | ~5m 35s |
| 5 | 30 minutes | ~35m |
| Dead | No more retries | — |

```typescript
private calculateNextAttemptAt(attemptNumber: number): Date {
  const delays = [
    0,           // Attempt 1: immediate
    5_000,       // Attempt 2: 5s
    30_000,      // Attempt 3: 30s
    5 * 60_000,  // Attempt 4: 5 min
    30 * 60_000, // Attempt 5: 30 min
  ];
  const delay = delays[attemptNumber] ?? 30 * 60_000;
  return new Date(Date.now() + delay);
}
```

---

## Dead-Letter Queue

After 5 failed delivery attempts, the delivery is marked `DEAD`. Dead deliveries:
- Are not retried automatically
- Appear in the admin dashboard as requiring attention
- Can be manually retried: `POST /api/v1/internal/webhook-deliveries/:id/retry`
- Are available for the merchant to query: `GET /v1/webhooks/deliveries?status=DEAD`

Dead deliveries are a signal that the merchant's endpoint has a persistent problem (wrong URL, permanent error, certificate expired).

---

## Idempotent Delivery

The same event must not be delivered to the same endpoint twice.

This is enforced by the `idempotency_key` column on `webhook_deliveries`:

```sql
UNIQUE(idempotency_key)

-- Value format: {endpoint_id}:{event_id}
-- e.g.: whe_abc123:evt_01j9k2m3n4p5q6r7
```

When the Kafka consumer creates delivery records, it uses this key:

```typescript
await tx.webhookDelivery.upsert({
  where: {
    idempotencyKey: `${endpoint.id}:${event.event_id}`,
  },
  create: {
    webhookEndpointId: endpoint.id,
    eventType: event.event_type,
    payload: event,
    idempotencyKey: `${endpoint.id}:${event.event_id}`,
  },
  update: {}, // If already exists, do nothing
});
```

If the Kafka consumer processes the same event twice (at-least-once delivery), the second attempt hits the unique constraint and the `update: {}` clause does nothing. No duplicate delivery is created.

---

## What Counts as Success?

Any `2xx` HTTP status code from the merchant endpoint is considered success. PayFlow does NOT inspect the response body.

```
200 OK        → SUCCESS
201 Created   → SUCCESS
204 No Content→ SUCCESS
400 Bad Request → FAILURE (retry)
404 Not Found → FAILURE (retry)
500 Server Error → FAILURE (retry)
Timeout (>10s)  → FAILURE (retry)
Connection refused → FAILURE (retry)
```

**Why retry on 400?** Merchant endpoints sometimes return 4xx for transient issues (misconfigured validation, rate limiting on their side). PayFlow retries anyway because it cannot distinguish between a permanent bad request and a transient one.

---

## Merchant-Side Acknowledgment Pattern

Merchants should process webhooks asynchronously:

```
PayFlow sends webhook
        ↓
Merchant endpoint immediately returns 200
(without waiting for internal processing)
        ↓
Merchant internally queues the event for processing
```

If a merchant takes 15 seconds to process and respond, PayFlow's 10-second timeout fires and the delivery is marked failed — even though the merchant received and processed it successfully. The correct pattern is to respond immediately and process asynchronously.

---

## Testing Webhooks

```typescript
describe('Webhook Delivery', () => {
  it('delivers payment.succeeded to subscribed endpoint', async () => {
    // Start a local webhook receiver
    const receiver = await startWebhookReceiver();

    // Register it as a webhook endpoint
    await registerWebhook(merchant.id, {
      url: receiver.url,
      events: ['payment.succeeded'],
    });

    // Create and succeed a payment
    const payment = await createAndSucceedPayment();

    // Run the webhook worker
    await webhookWorker.processBatch();

    // Assert delivery
    const received = await receiver.waitForRequest(5000);
    expect(received.headers['x-payflow-event-type']).toBe('payment.succeeded');
    expect(received.body.data.payment_id).toBe(payment.id);

    // Verify signature
    const isValid = WebhookSigner.verify(
      received.headers['x-payflow-signature'],
      received.rawBody,
      merchant.webhookSecret,
    );
    expect(isValid).toBe(true);
  });

  it('retries after 500 response with correct backoff', async () => {
    // ... setup ...

    // First attempt: endpoint returns 500
    receiver.setNextStatus(500);
    await webhookWorker.processBatch();

    const delivery = await getDelivery(deliveryId);
    expect(delivery.attempts).toBe(1);
    expect(delivery.status).toBe('FAILED');
    expect(delivery.nextAttemptAt).toBeAfter(addSeconds(new Date(), 4)); // ~5s delay

    // Second attempt after backoff
    await advanceTimeTo(delivery.nextAttemptAt);
    receiver.setNextStatus(200);
    await webhookWorker.processBatch();

    const updated = await getDelivery(deliveryId);
    expect(updated.status).toBe('SUCCEEDED');
  });

  it('dead-letters after 5 consecutive failures', async () => {
    receiver.setAlwaysStatus(500);

    for (let i = 0; i < 5; i++) {
      await advanceTimeTo(getNextAttemptTime(i));
      await webhookWorker.processBatch();
    }

    const delivery = await getDelivery(deliveryId);
    expect(delivery.status).toBe('DEAD');
    expect(delivery.attempts).toBe(5);
  });
});
```

# Security

## Overview

PayFlow handles financial transactions and must be built with security as a first-class concern. This document covers the security model, API key design, webhook signing, secret management, and threat model.

---

## Authentication Model

### Internal Users (JWT)

Internal users (employees, operators, analysts) authenticate with email + password and receive a JWT:

```
POST /api/v1/auth/login
→ { accessToken: "eyJhbGc..." }
```

JWT properties:
- **Algorithm:** HS256 (HMAC-SHA256)
- **Secret:** minimum 32 characters, set via `JWT_SECRET` env var, validated at startup via Joi
- **Expiry:** 7 days (configurable via `JWT_EXPIRES_IN`)
- **Claims:** `{ sub: userId, email, role, iat, exp }`
- **Validation on every request:** The `JwtStrategy.validate()` method queries the database to check the user still exists and is ACTIVE

**Why validate against DB on every request?**

If a user is deactivated, their JWT is still cryptographically valid until expiry (7 days). Without a DB check, a deactivated user could still make API calls for up to 7 days. The DB check ensures deactivation takes effect immediately.

**Performance note:** At high request volumes, this DB hit on every request becomes expensive. Cache the user record in Redis with a short TTL (60 seconds) to avoid per-request DB queries while still detecting deactivation quickly.

### Merchant API Keys

Merchants use API keys to authenticate payment API calls:

```http
Authorization: Bearer sk_live_9f8e7d6c5b4a3928...
```

**Key format:** `sk_live_` prefix + 32 random bytes (hex-encoded) = 72-character key

**Storage:** API keys are stored as **SHA-256 hashes** in the `api_keys` table. The raw key is shown exactly once (at creation) and never stored.

```typescript
// Key generation
const rawKey = `sk_live_${randomBytes(32).toString('hex')}`;
const keyHash = createHash('sha256').update(rawKey).digest('hex');
const keyPrefix = rawKey.slice(0, 12);  // "sk_live_9f8e" for display

await prisma.apiKey.create({
  data: {
    merchantId,
    keyHash,      // Stored
    keyPrefix,    // Stored (for display/identification)
    // rawKey is NOT stored
  },
});

return rawKey;  // Returned ONCE to the caller
```

**Validation on every request:**

```typescript
// src/common/guards/api-key.guard.ts

@Injectable()
export class MerchantApiKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer sk_')) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const rawKey = authHeader.slice(7);
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { keyHash },
      include: { merchant: true },
    });

    if (!apiKey || apiKey.revokedAt) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Attach merchant to request context
    request.merchant = apiKey.merchant;

    // Update last_used_at (fire and forget — do not block request)
    this.prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => {}); // Non-critical

    return true;
  }
}
```

---

## Webhook Signatures (HMAC-SHA256)

Every webhook request is signed to prove it came from PayFlow:

```
Signature = HMAC-SHA256(webhook_secret, "{timestamp}.{payload}")
```

See [`webhook-delivery.md`](./webhook-delivery.md) for implementation details.

**Threat:** An attacker sends a fake webhook to a merchant endpoint to trigger unauthorized fulfillment.  
**Mitigation:** HMAC signature verification. The attacker doesn't know the webhook secret.

**Threat:** An attacker replays a captured valid webhook.  
**Mitigation:** Timestamp in the signed payload + 5-minute window check on merchant side.

**Secret storage:** Webhook secrets are stored as **bcrypt hashes** in the database. The raw secret is shown once at endpoint creation.

---

## Rate Limiting

### Global Rate Limiting (Existing)

The existing `ThrottlerGuard` provides global rate limiting:
```
100 requests / 60 seconds / IP address
```

### Per-Merchant Rate Limiting (New)

The merchant API has stricter, per-merchant limits:

```typescript
// Redis-backed per-merchant rate limiter
const key = `rate:merchant:${merchant.id}:${Math.floor(Date.now() / 60000)}`;
const count = await this.redis.incr(key);
await this.redis.expire(key, 60);

if (count > MERCHANT_RATE_LIMIT) {
  throw new TooManyRequestsException('Rate limit exceeded');
}
```

Limits:
- **100 API requests / minute / merchant** (general)
- **10 payment creation attempts / minute / customer** (anti-fraud)

### Why Redis for Rate Limiting?

Redis counters are atomic (`INCR` is a single operation) and fast (~0.1ms). A PostgreSQL `UPDATE` would be ~5ms and create lock contention at high request rates.

---

## Input Validation

All request bodies are validated by `ValidationPipe` (existing, configured globally):

```typescript
new ValidationPipe({
  whitelist: true,            // Strip unknown properties
  forbidNonWhitelisted: true, // Reject unknown properties with 400
  transform: true,            // Auto-transform to DTO instances
})
```

**`whitelist: true`** is the most important setting. Without it, extra fields in the request body are silently ignored. With it, they are stripped. This prevents mass assignment attacks where a malicious client sends unexpected fields.

---

## SQL Injection Prevention

PayFlow uses Prisma exclusively for database access. Prisma uses parameterized queries — values are never interpolated into SQL strings.

For raw SQL (used only in `TransactionsRepository.getMonthlyTrends` and outbox worker), PayFlow uses Prisma's tagged template literals:

```typescript
// SAFE: Prisma.sql uses parameterized binding
const conditions: Prisma.Sql[] = [];
if (options.userId) {
  conditions.push(Prisma.sql`"user_id" = ${options.userId}`);
}

// NEVER do this:
// Prisma.sql`"user_id" = '${options.userId}'`  // String interpolation — UNSAFE
```

---

## Secret Management

### Environment Variables

All secrets are injected via environment variables and validated at startup:

```typescript
// src/app.module.ts (existing)
validationSchema: Joi.object({
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  // ... etc
})
```

If a required secret is missing or too short, the application **refuses to start**. There is no silent fallback to a weak default.

### New Secrets (PayFlow)

```env
# Added for PayFlow
KAFKA_BROKERS=kafka:9092
KAFKA_CLIENT_ID=payflow
KAFKA_GROUP_ID=payflow-payments
ENCRYPTION_KEY=<32-byte hex string>   # For encrypting stored webhook secrets
```

### Secrets NOT to Store in Source Control

- `.env` is in `.gitignore` (already configured)
- Docker Compose has placeholder values like `change-me-in-production` — these must be replaced with real secrets via environment injection (Kubernetes secrets, AWS Secrets Manager, etc.) before production deployment
- `docker-compose.yml` is safe to commit because it contains only placeholder values, not real secrets

---

## CORS Configuration

The existing CORS configuration allows `Idempotency-Key` as an allowed header (added in Phase 0):

```typescript
// src/main.ts
app.enableCors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'Idempotency-Key',  // Added for PayFlow
  ],
  credentials: true,
});
```

---

## Helmet Configuration

The existing Helmet configuration is maintained:

```typescript
app.use(helmet({
  contentSecurityPolicy: env === 'production' ? undefined : false,
  crossOriginEmbedderPolicy: env === 'production',
}));
```

---

## Threat Model

| Threat | Mitigation |
|---|---|
| API key theft | SHA-256 hash stored, not plaintext. Attacker needs the raw key. |
| JWT theft | Short expiry (7d). DB check on every request catches deactivated users. |
| Duplicate payment injection | `UNIQUE(merchant_id, key)` in DB + idempotency logic. |
| Webhook forgery | HMAC-SHA256 signature. Merchant verifies before acting. |
| Webhook replay attack | Timestamp in signed payload + 5-minute window. |
| Mass assignment | `whitelist: true` in ValidationPipe strips unknown fields. |
| SQL injection | Prisma parameterized queries throughout. |
| Information leakage | GlobalExceptionFilter never exposes stack traces to clients. Internal errors logged server-side only. |
| Brute force login | ThrottlerGuard limits to 100 req/min per IP. |
| Merchant rate abuse | Per-merchant Redis rate limiter on payment endpoints. |
| Unauthorized cross-merchant access | All queries scoped by `merchant_id` from authenticated context, never from request body. |
| Admin privilege escalation | Separate JWT auth + role check for admin operations. No `sudo` via API key. |

---

## What is NOT in Scope (And Why)

**PCI-DSS compliance:** PayFlow does not handle raw card data. The processor simulator handles card details. In a real system, the processor would handle card tokenization (Stripe.js, Braintree SDK) so card data never touches PayFlow servers.

**mTLS between services:** PayFlow is a monolith — internal module communication is function calls, not network calls. mTLS applies to microservices.

**Fraud detection:** The risk engine provides rule-based scoring but is not a full fraud detection system. ML-based fraud detection (transaction graph analysis, device fingerprinting) is out of scope.

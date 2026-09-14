# Double-Entry Ledger

## Why a Ledger?

A mutable balance column is not a financial system — it is a number that can be corrupted by any bug. If `merchant.balance += 1000` is called twice due to a retry, the balance is wrong and there is no way to detect or recover from this without auditing every transaction.

A double-entry ledger is different. Every financial movement is recorded as two entries — a debit and a credit — such that the sum of all debits always equals the sum of all credits. This makes corruption detectable (the balance equation breaks) and recoverable (replay all entries to recompute any balance).

**PayFlow uses a double-entry ledger as the authoritative record of all financial movements.** The `payments` table records the status and intent. The `ledger_entries` table records the actual money movement.

---

## Double-Entry Accounting Primer

In double-entry bookkeeping, every transaction has at least two entries:
- A **debit** to one account
- A **credit** to another account

For every transaction: `SUM(debits) = SUM(credits)`

This is not a convention — it is a mathematical invariant enforced by the structure of the system.

### Account Types and Normal Balances

| Account Type | Normal Balance | Increased by | Decreased by |
|---|---|---|---|
| ASSET | DEBIT | Debit | Credit |
| LIABILITY | CREDIT | Credit | Debit |
| REVENUE | CREDIT | Credit | Debit |
| EXPENSE | DEBIT | Debit | Credit |

---

## PayFlow's Chart of Accounts

```
System Accounts (created at startup, never deleted):

CUSTOMER_FUNDS      TYPE: ASSET      NORMAL: DEBIT
  → Represents money held on behalf of customers
  → Increases when customers fund their accounts
  → Decreases when payments succeed or are refunded

CLEARING            TYPE: LIABILITY  NORMAL: CREDIT
  → In-transit funds between customer and merchant
  → Holds funds while payment is being processed
  → Zeroed out when payment succeeds or fails

MERCHANT_PAYABLE    TYPE: LIABILITY  NORMAL: CREDIT
  → Money owed to merchants after successful payments
  → Increases when payments succeed
  → Decreases when funds are settled to merchant's bank

REVENUE_FEES        TYPE: REVENUE    NORMAL: CREDIT
  → PayFlow's fee income
  → Increases when payments succeed (fee deducted from merchant payout)
```

---

## Journal Entries for Every Scenario

### Payment Created (CREATED state)

```
DEBIT   CUSTOMER_FUNDS    1000  INR
CREDIT  CLEARING          1000  INR
```

The customer's money is reserved and held in clearing while processing occurs.

### Payment SUCCEEDED

```
DEBIT   CLEARING          1000  INR   (clearing resolved)
CREDIT  MERCHANT_PAYABLE   950  INR   (merchant receives 95%)
CREDIT  REVENUE_FEES         50  INR   (PayFlow takes 5% fee)
```

### Payment FAILED or CANCELLED

```
DEBIT   CLEARING          1000  INR   (reversal)
CREDIT  CUSTOMER_FUNDS    1000  INR   (money returned)
```

The initial debit to CUSTOMER_FUNDS and credit to CLEARING is reversed. Net effect: zero.

### Full Refund (REFUNDED state)

```
Phase 1 — Refund submission:
DEBIT   MERCHANT_PAYABLE  1000  INR   (merchant's balance reduced)
CREDIT  CLEARING          1000  INR   (funds back in transit)

Phase 2 — Refund confirmed:
DEBIT   CLEARING          1000  INR   (transit resolved)
CREDIT  CUSTOMER_FUNDS    1000  INR   (money back to customer)
```

### Partial Refund (e.g., ₹300 refund on ₹1000 payment)

```
DEBIT   MERCHANT_PAYABLE   300  INR
CREDIT  CLEARING            300  INR

DEBIT   CLEARING            300  INR
CREDIT  CUSTOMER_FUNDS      300  INR
```

The remaining ₹700 stays in MERCHANT_PAYABLE for eventual settlement.

---

## Database Schema

### `ledger_accounts`

```sql
CREATE TABLE ledger_accounts (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,    -- e.g. 'CUSTOMER_FUNDS'
  name            TEXT NOT NULL,
  type            account_type NOT NULL,
  normal_balance  TEXT NOT NULL,           -- 'DEBIT' or 'CREDIT'
  merchant_id     TEXT REFERENCES merchants(id),  -- NULL = system account
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Accounts with `merchant_id = NULL` are system accounts shared across all merchants. Merchant-specific accounts (for per-merchant balance tracking) have a `merchant_id`.

### `ledger_transactions`

```sql
CREATE TABLE ledger_transactions (
  id              TEXT PRIMARY KEY,
  reference_type  TEXT NOT NULL,     -- 'payment', 'refund', 'settlement', 'fee'
  reference_id    TEXT NOT NULL,     -- payment.id, refund.id, etc.
  description     TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,  -- Prevents double-posting
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `ledger_entries`

```sql
CREATE TABLE ledger_entries (
  id                    TEXT PRIMARY KEY,
  ledger_transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_id            TEXT NOT NULL REFERENCES ledger_accounts(id),
  entry_type            TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  amount                BIGINT NOT NULL CHECK (amount > 0),
  currency              TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Critical constraints:**
- `amount > 0` — ledger entries are always positive. Direction is captured by `entry_type`, not by negative numbers.
- `entry_type IN ('DEBIT', 'CREDIT')` — no ambiguity.

---

## Implementation

```typescript
// src/modules/ledger/ledger.service.ts

async recordPaymentSuccess(
  tx: PrismaTransactionClient,
  payment: Payment,
): Promise<void> {
  const idempotencyKey = `payment_success:${payment.id}`;

  // Idempotent: if already recorded, skip
  const existing = await tx.ledgerTransaction.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return;

  const fee = this.calculateFee(payment.amount);
  const merchantPayout = payment.amount - fee;

  const clearingAccount = await this.getAccount('CLEARING');
  const merchantPayableAccount = await this.getAccount('MERCHANT_PAYABLE');
  const feesAccount = await this.getAccount('REVENUE_FEES');

  await tx.ledgerTransaction.create({
    data: {
      referenceType: 'payment',
      referenceId: payment.id,
      description: `Payment ${payment.id} succeeded`,
      idempotencyKey,
      entries: {
        create: [
          // Debit clearing (resolve in-transit funds)
          {
            accountId: clearingAccount.id,
            entryType: 'DEBIT',
            amount: payment.amount,
            currency: payment.currency,
          },
          // Credit merchant payable (merchant gets funds)
          {
            accountId: merchantPayableAccount.id,
            entryType: 'CREDIT',
            amount: merchantPayout,
            currency: payment.currency,
          },
          // Credit fees (PayFlow takes its cut)
          {
            accountId: feesAccount.id,
            entryType: 'CREDIT',
            amount: fee,
            currency: payment.currency,
          },
        ],
      },
    },
  });
}
```

---

## The Balance Invariant

The invariant is verified by this query — it must always return zero:

```sql
SELECT
  SUM(CASE WHEN entry_type = 'DEBIT'  THEN amount ELSE 0 END) -
  SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)
  AS imbalance
FROM ledger_entries;
```

If `imbalance ≠ 0`, there is a bug. The amount of imbalance tells you exactly how much money is unaccounted for.

### Automated Invariant Check

```typescript
// Runs daily (or after each reconciliation run)
async verifyLedgerBalance(): Promise<void> {
  const result = await this.prisma.$queryRaw<[{ imbalance: bigint }]>`
    SELECT
      SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) -
      SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE 0 END)
    AS imbalance
    FROM ledger_entries
  `;

  const imbalance = result[0].imbalance;
  if (imbalance !== 0n) {
    await this.alertingService.critical({
      alert: 'LEDGER_IMBALANCE',
      imbalance: imbalance.toString(),
      detectedAt: new Date().toISOString(),
    });
  }
}
```

---

## Why BIGINT for Amounts?

All monetary amounts in the ledger (and in the `payments` table) are stored as `BIGINT` representing the smallest currency unit:
- INR → paise (₹1 = 100 paise, so ₹10.50 = 1050)
- USD → cents ($1 = 100 cents, so $10.50 = 1050)

**Why not DECIMAL?**

`DECIMAL(15,2)` appears precise but introduces risk:
- Application code may accidentally convert to JavaScript `number` (which is a 64-bit float)
- Floating-point arithmetic on floats loses precision: `0.1 + 0.2 !== 0.3`
- Summing thousands of DECIMAL values in application code accumulates rounding errors

`BIGINT` is an exact integer. There are no decimals and therefore no decimal precision issues. The application always works in the smallest unit and only formats for display.

```typescript
// Always store as integer
const amountInPaise = 10050;  // ₹100.50

// Format for display
const formatted = (amountInPaise / 100).toFixed(2);  // "100.50"
```

The existing `transactions` table uses `DECIMAL(15,2)` (inherited from the personal finance module). New PayFlow entities use `BIGINT`. This inconsistency is acceptable — they serve different purposes and the migration cost of changing the existing table is not worth it.

---

## Testing the Ledger

```typescript
describe('Ledger', () => {
  it('maintains balance invariant across 1000 random payments', async () => {
    // Create 1000 random payments with mixed outcomes
    for (let i = 0; i < 1000; i++) {
      const outcome = randomOutcome(); // 60% success, 30% fail, 10% refund
      await simulatePayment(outcome);
    }

    // Verify the invariant
    const imbalance = await ledgerService.computeImbalance();
    expect(imbalance).toBe(0n);
  });

  it('records balanced entries for a full refund', async () => {
    const payment = await createAndSucceedPayment(1000);
    await createRefund(payment.id, 1000);

    const entries = await getLedgerEntriesForPayment(payment.id);
    const debits = entries.filter(e => e.entryType === 'DEBIT').reduce((s, e) => s + e.amount, 0n);
    const credits = entries.filter(e => e.entryType === 'CREDIT').reduce((s, e) => s + e.amount, 0n);

    expect(debits).toBe(credits);
  });
});
```

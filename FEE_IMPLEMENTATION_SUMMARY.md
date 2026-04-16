# Fee Implementation Summary

## Overview

Implemented a percentage-based fee system for Bitcoin DCA transactions. Fees are deducted from the package amount before calculating satoshis, ensuring users receive the correct amount of Bitcoin after fees.

## Changes Made

### 1. Environment Configuration

**File:** `.env.template`

Added new configuration variable:
```bash
FEE_BASIS_POINTS=100  # Platform fee in basis points (1 bp = 0.01%, 100 = 1%)
```

**Basis Points Reference:**
- 50 bps = 0.5%
- 100 bps = 1.0%
- 150 bps = 1.5%
- 250 bps = 2.5%
- 500 bps = 5.0%
- 1000 bps = 10.0%

### 2. Database Migration

**File:** `src/migrations/20260416114813_add_fee_columns_to_transaction.ts`

Added four new columns to the `transaction` table:

| Column | Type | Description |
|--------|------|-------------|
| `gross_amount` | decimal(18,2) | Original package amount from PayHere |
| `fee_basis_points` | integer | Fee percentage at transaction time (for historical tracking) |
| `fee_amount` | decimal(18,2) | Calculated fee in LKR |
| `net_amount` | decimal(18,2) | Amount after fee deduction (used for Bitcoin purchase) |

**To apply migration:**
```bash
pnpm migrate
```

### 3. Transaction Service Updates

**File:** `src/modules/transaction/transaction.service.ts`

#### Updated Interface

Added fee fields to the `Transaction` interface:
```typescript
export interface Transaction {
  // ... existing fields
  gross_amount?: number;
  fee_basis_points?: number;
  fee_amount?: number;
  net_amount?: number;
  // ... existing fields
}
```

#### Updated Fee Calculation Logic

Modified `fetchBitcoinDataForTransaction()` method to:

1. **Get fee configuration from environment:**
   ```typescript
   const feeBasisPoints = parseInt(process.env.FEE_BASIS_POINTS || '100', 10);
   ```

2. **Calculate fee amount:**
   ```typescript
   const feeAmount = new Big(grossAmount)
     .times(feeBasisPoints)
     .div(10000)
     .toNumber();
   ```

3. **Calculate net amount:**
   ```typescript
   const netAmount = new Big(grossAmount).minus(feeAmount).toNumber();
   ```

4. **Use net amount for satoshi calculation:**
   ```typescript
   const bitcoinCalculation =
     await this.bitcoinPriceService.calculateSatoshis(netAmount, currency);
   ```

5. **Return all fee-related data:**
   ```typescript
   return {
     btc_price_at_purchase: bitcoinCalculation.btc_price,
     satoshis_purchased: bitcoinCalculation.satoshis,
     price_currency: bitcoinCalculation.currency,
     coingecko_timestamp: bitcoinCalculation.timestamp,
     gross_amount: grossAmount,
     fee_basis_points: feeBasisPoints,
     fee_amount: feeAmount,
     net_amount: netAmount,
   };
   ```

### 4. Documentation Updates

**File:** `CLAUDE.md`

Added comprehensive fee system documentation:
- Configuration details
- Fee calculation formulas
- Transaction fee fields explanation
- Example calculation
- Test script reference

### 5. Test Script

**File:** `scripts/test-fee-calculation.ts`

Created test script to demonstrate fee calculations with different scenarios.

**Run test:**
```bash
npx ts-node scripts/test-fee-calculation.ts
```

## How It Works

### Fee Calculation Flow

1. **PayHere webhook receives payment:**
   - Gross amount: 1000 LKR
   - Status: SUCCESS

2. **Fee calculation (assuming 100 bps = 1%):**
   - Fee amount: 1000 × (100 ÷ 10000) = 10 LKR
   - Net amount: 1000 - 10 = 990 LKR

3. **Bitcoin calculation (assuming BTC price = 50,000,000 LKR):**
   - Satoshis: (990 ÷ 50,000,000) × 100,000,000 = 1,980 sats

4. **Transaction record:**
   ```json
   {
     "payhere_pay_id": "abc123",
     "gross_amount": 1000,
     "fee_basis_points": 100,
     "fee_amount": 10,
     "net_amount": 990,
     "btc_price_at_purchase": 50000000,
     "satoshis_purchased": 1980,
     "price_currency": "LKR"
   }
   ```

## API Response Changes

Fee data is automatically included in transaction API responses:

### GET /transaction/list

```json
{
  "transactions": [
    {
      "payhere_pay_id": "abc123",
      "status": "SUCCESS",
      "gross_amount": 1000,
      "fee_basis_points": 100,
      "fee_amount": 10,
      "net_amount": 990,
      "btc_price_at_purchase": 50000000,
      "satoshis_purchased": 1980,
      "price_currency": "LKR",
      "created_at": "2026-04-16T10:30:00Z"
    }
  ],
  "total_count": 1,
  "current_page": 1,
  "has_more": false
}
```

### GET /transaction/latest

Returns the same transaction structure with fee fields included.

### GET /transaction/dca-summary

DCA summary calculations use `satoshis_purchased` (which is already calculated from net amount), so no changes needed. The summary correctly reflects the actual Bitcoin received.

## Benefits

1. **Transparency:** Users can see exactly how much they paid in fees
2. **Historical Tracking:** Fee basis points are stored per transaction, so if fees change, historical data remains accurate
3. **Accurate Bitcoin Calculations:** Satoshis are calculated using net amount only
4. **Flexible Configuration:** Fees can be adjusted via environment variable without code changes
5. **Detailed Records:** All fee-related data is stored for auditing and reporting

## Testing Recommendations

1. **Test with different fee rates:**
   ```bash
   FEE_BASIS_POINTS=100  # 1%
   FEE_BASIS_POINTS=250  # 2.5%
   FEE_BASIS_POINTS=500  # 5%
   ```

2. **Verify calculations:**
   - Check that gross_amount - fee_amount = net_amount
   - Verify satoshis are calculated from net_amount
   - Confirm fee_basis_points is stored correctly

3. **Test PayHere webhook:**
   - Create a test subscription
   - Process a payment through PayHere
   - Verify all fee fields are populated correctly
   - Check that satoshis match expected value based on net amount

4. **API response verification:**
   - Call GET /transaction/list
   - Verify fee fields are present
   - Confirm calculations are correct

## Migration Notes

- The migration adds nullable columns, so existing transactions won't have fee data
- Only new transactions (after migration) will have fee information
- Consider adding a data migration script if you need to backfill fee data for historical transactions

## Formula Reference

```
Fee Amount = Gross Amount × (Fee Basis Points ÷ 10,000)
Net Amount = Gross Amount - Fee Amount
Satoshis = (Net Amount ÷ BTC Price in Currency) × 100,000,000
```

## Configuration Examples

**Low Fee (0.5%):**
```bash
FEE_BASIS_POINTS=50
```

**Standard Fee (1%):**
```bash
FEE_BASIS_POINTS=100
```

**Higher Fee (2.5%):**
```bash
FEE_BASIS_POINTS=250
```

## Security Considerations

- Fee basis points are read from environment at transaction time
- Once stored in the transaction record, fee data cannot be changed
- Fee calculation uses Big.js for precise decimal arithmetic
- All fee amounts are properly logged for audit trails

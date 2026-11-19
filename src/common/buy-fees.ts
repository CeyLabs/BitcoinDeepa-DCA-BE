import Big from 'big.js';

export interface BuyFees {
  gross: number;
  paymentProcessorFeeBps: number;
  paymentProcessorFee: number;
  bitcoindeepaFeeBps: number;
  bitcoindeepaFee: number;
  totalFees: number;
  /** What actually buys BTC */
  net: number;
}

/**
 * Fees on a buy (subscription charge or one-time), from the env basis points:
 * each fee = gross × bps / 10000, net = gross - both fees.
 */
export function computeBuyFees(gross: number): BuyFees {
  const paymentProcessorFeeBps = parseInt(
    process.env.PAYHERE_FEE_BASIS_POINTS || '0',
    10,
  );
  const bitcoindeepaFeeBps = parseInt(
    process.env.BITCOINDEEPA_FEE_BASIS_POINTS || '0',
    10,
  );

  const g = new Big(gross);
  const paymentProcessorFee = g.times(paymentProcessorFeeBps).div(10000);
  const bitcoindeepaFee = g.times(bitcoindeepaFeeBps).div(10000);
  const totalFees = paymentProcessorFee.plus(bitcoindeepaFee);

  return {
    gross,
    paymentProcessorFeeBps,
    paymentProcessorFee: paymentProcessorFee.toNumber(),
    bitcoindeepaFeeBps,
    bitcoindeepaFee: bitcoindeepaFee.toNumber(),
    totalFees: totalFees.toNumber(),
    net: g.minus(totalFees).toNumber(),
  };
}

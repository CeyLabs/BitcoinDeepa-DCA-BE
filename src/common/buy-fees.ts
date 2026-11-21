import { basisPointsOf, toApiNumber, toMoney } from './money';

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
 * each fee = gross × bps / 10000, net = gross - both fees. Computed as
 * decimals; the numbers returned are exact for 2-dp LKR and the fee bps
 * resolution (1 bp of a cent is 6 dp, well within a double).
 */
export function computeBuyFees(gross: number | string): BuyFees {
  const paymentProcessorFeeBps = parseInt(
    process.env.PAYHERE_FEE_BASIS_POINTS || '0',
    10,
  );
  const bitcoindeepaFeeBps = parseInt(
    process.env.BITCOINDEEPA_FEE_BASIS_POINTS || '0',
    10,
  );

  const g = toMoney(gross);
  const paymentProcessorFee = basisPointsOf(g, paymentProcessorFeeBps);
  const bitcoindeepaFee = basisPointsOf(g, bitcoindeepaFeeBps);
  const totalFees = paymentProcessorFee.plus(bitcoindeepaFee);

  return {
    gross: toApiNumber(g),
    paymentProcessorFeeBps,
    paymentProcessorFee: toApiNumber(paymentProcessorFee),
    bitcoindeepaFeeBps,
    bitcoindeepaFee: toApiNumber(bitcoindeepaFee),
    totalFees: toApiNumber(totalFees),
    net: toApiNumber(g.minus(totalFees)),
  };
}

// Minswap's swap-exact-in quote and the adapter's price floor, mirroring
// onchain/lib/apps/minswap/math.ak and place.ak exactly (integer arithmetic).
export const FEE_DENOMINATOR = 10_000n;

/** Minswap `calculate_amount_out`: what `amountIn` buys from a pool, after its trading fee. */
export function amountOut(reserveIn: bigint, reserveOut: bigint, amountIn: bigint, feeNumerator: bigint): bigint {
  const inWithFee = (FEE_DENOMINATOR - feeNumerator) * amountIn;
  return (inWithFee * reserveOut) / (FEE_DENOMINATOR * reserveIn + inWithFee);
}

/** The adapter's floor: `minimum * 10000 >= fair * (10000 - slippage)`. */
export const floorOk = (minimum: bigint, fair: bigint, slippageBps: bigint) =>
  minimum * FEE_DENOMINATOR >= fair * (FEE_DENOMINATOR - slippageBps);

/** The smallest minimum the floor accepts (ceiling division: never one unit short). */
export function minimumFor(fair: bigint, slippageBps: bigint): bigint {
  const n = fair * (FEE_DENOMINATOR - slippageBps);
  return n <= 0n ? 0n : (n + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
}

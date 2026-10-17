// Minswap's swap-exact-in quote and the adapter's price floor, mirroring
// onchain/lib/apps/minswap/math.ak and place.ak exactly (integer arithmetic).
import { sha3_256 } from "@noble/hashes/sha3";
import { fromHex, toHex } from "../../bytes.js";

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

/** Minswap's `compute_lp_asset_name`: sha3_256(sha3_256(A) ++ sha3_256(B)) of a pool's two assets (hex). */
export function lpNameOf(p: { assetA: { policy: string; name: string }; assetB: { policy: string; name: string } }): string {
  const id = (a: { policy: string; name: string }) => sha3_256(fromHex(a.policy + a.name));
  const a = id(p.assetA);
  const b = id(p.assetB);
  const pair = new Uint8Array(a.length + b.length);
  pair.set(a);
  pair.set(b, a.length);
  return toHex(sha3_256(pair));
}

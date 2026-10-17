// Off-chain mirror of the Minswap adapter (onchain/lib/apps/minswap/place.ak) and the
// AgentTrade routing (allowance.ak `agent_trade`) for one order. The chain decides; this
// lets the SDK, the signer and the relay refuse a doomed trade with a readable reason.
import type { AllowanceDatum, ConfigDatum, PlutusAddress } from "../../data.js";
import { settingsFromData, type MinswapOrder, type MinswapPool, type MinswapSettings } from "./data.js";
import { amountOut, floorOk, lpNameOf } from "./quote.js";

export const MAX_POOLS = 8;
export const MAX_ORDERS = 3;
export const MAX_SLIPPAGE_BPS = 2000n;

const sameAddress = (a: PlutusAddress, b: PlutusAddress) => JSON.stringify(a) === JSON.stringify(b);

/** The vault's Minswap settings for this adapter, if enabled and readable. */
export function minswapSettings(config: ConfigDatum, adapter: string): MinswapSettings | undefined {
  const app = config.apps.find((a) => a.adapter === adapter);
  if (!app) return undefined;
  try {
    return settingsFromData(app.settings);
  } catch {
    return undefined;
  }
}

export function tradeProblems(t: {
  config: ConfigDatum;
  allowance: AllowanceDatum;
  /** This network's adapter hash. */
  adapter: string;
  lpPolicy: string;
  /** The vault's canonical address. */
  vault: PlutusAddress;
  /** The tx's upper validity bound (POSIX ms, exclusive, as the script sees it). */
  upper: bigint;
  order: MinswapOrder;
  pool: MinswapPool;
  /** The order output's value. */
  orderValue: Record<string, bigint>;
}): string[] {
  const p: string[] = [];
  const app = t.config.apps.find((a) => a.adapter === t.adapter);
  if (!app) return ["Minswap isn't enabled on this vault"];
  if (!t.allowance.apps.includes(app.name)) return ["this agent isn't allowed to use Minswap"];
  const s = minswapSettings(t.config, t.adapter);
  if (!s) return ["the vault's Minswap settings are unreadable"];
  if (s.pools.length > MAX_POOLS || s.maxSlippageBps > MAX_SLIPPAGE_BPS) return ["the vault's Minswap settings are out of range"];
  const o = t.order;
  if (o.adapter !== t.adapter) p.push("the order's canceller isn't the adapter");
  if (!sameAddress(o.receiver, t.vault)) p.push("the order doesn't pay the vault");
  if (o.amount <= 0n) p.push("the swap amount must be positive");
  if (o.lp.policy !== t.lpPolicy || !s.pools.includes(o.lp.name)) p.push("that pool isn't allowed");
  // The floor is read from this pool: its own assets must derive the order's LP name (else it's another pool).
  if (lpNameOf(t.pool) !== o.lp.name) p.push("the pool data doesn't belong to the order's pool");
  if (o.maxBatcherFee < 0n || o.maxBatcherFee > s.maxBatcherFee) p.push(`batcher fee over the vault's ${s.maxBatcherFee} lovelace`);
  if (o.expiry > t.upper + s.maxOrderTtlMs) p.push("the order lives longer than the vault allows");
  if (o.tip < 0n || o.tip > s.maxCancelTip) p.push("the cancel tip is over the vault's limit");
  const [assetIn, rIn, rOut, fee] = o.aToB ? [t.pool.assetA, t.pool.reserveA, t.pool.reserveB, t.pool.feeA] : [t.pool.assetB, t.pool.reserveB, t.pool.reserveA, t.pool.feeB];
  const unitIn = assetIn.policy === "" ? "lovelace" : assetIn.policy + assetIn.name;
  if (Object.entries(t.orderValue).some(([u, q]) => q !== 0n && u !== "lovelace" && u !== unitIn)) p.push("the order carries a token other than the one it sells");
  if (!floorOk(o.minimumReceive, amountOut(rIn, rOut, o.amount, fee), s.maxSlippageBps)) p.push("the minimum received is below the vault's price floor");
  return p;
}

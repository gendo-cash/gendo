// tradeOnce: the idempotent agent trade, the twin of payOnce (same journal and chain checks:
// one order per intent id, never two).
import { buildAgentTrade, type BuiltTrade, type TradeRequest } from "./apps/minswap/trade.js";
import { spendOnce, type OnceDeps } from "./pay.js";

export type TradeResult = { status: "traded"; txHash: string; built: BuiltTrade } | { status: "already-traded"; txHash: string; source: "journal" | "chain" };

export async function tradeOnce(req: Omit<TradeRequest, "allowance" | "config"> & { allowanceUnit: string }, deps: OnceDeps): Promise<TradeResult> {
  const r = await spendOnce(req, deps, buildAgentTrade);
  return r.status === "paid" ? { status: "traded", txHash: r.txHash, built: r.built } : { status: "already-traded", txHash: r.txHash, source: r.source };
}

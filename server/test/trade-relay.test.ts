// The submit relay and agent trades: it accepts the agent's own AgentTrade (one zero
// withdrawal, from this network's Minswap adapter) and nothing looser.
import { describe, expect, it } from "vitest";
import { buildAgentTrade } from "../../sdk/src/core/apps/minswap/trade.js";
import { buildAgentSpend } from "../../sdk/src/core/agent.js";
import { ADA } from "../../sdk/test/helpers.js";
import { tradeWorld } from "../../sdk/test/trade-world.js";
import { agentTxProblem } from "../src/pending.js";

describe("relaying an agent's trade", async () => {
  const w = await tradeWorld({ pools: ["860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n });
  const ctx = await w.agentCtx();
  const ref = `${ctx.allowance.utxo.txHash}#${ctx.allowance.utxo.outputIndex}`;
  const trade = (await buildAgentTrade({ ...ctx, pool: "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f", amountIn: 2n * ADA, aToB: true, intentId: "relay-1", purpose: "p" })).tx.toCBOR();

  it("accepts the agent's own trade", () => {
    expect(agentTxProblem(trade, w.vault.hash, ref, w.agent.pkh, "Custom")).toBeUndefined();
  });
  it("refuses a trade whose withdrawal isn't this network's adapter", () => {
    expect(agentTxProblem(trade, w.vault.hash, ref, w.agent.pkh, "Preprod")).toMatch(/adapter/);
  });
  it("refuses a trade that isn't signed by the agent", () => {
    expect(agentTxProblem(trade, w.vault.hash, ref, w.b.pkh, "Custom")).toMatch(/agent key must sign/);
  });
  it("still accepts an ordinary payment", async () => {
    const pay = (await buildAgentSpend({ ...ctx, payments: [{ to: w.payee.address, assets: { lovelace: 2n * ADA } }], intentId: "relay-2", purpose: "p" })).tx.toCBOR();
    expect(agentTxProblem(pay, w.vault.hash, ref, w.agent.pkh, "Custom")).toBeUndefined();
  });
});

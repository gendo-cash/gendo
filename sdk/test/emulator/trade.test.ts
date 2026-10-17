// Agent trades on Minswap in the Lucid emulator. Every build runs the real vault and the
// real adapter through Lucid's local evaluator; the pool is a devnet-style fixture (the
// catalogue's Custom deployment: open mint policy, pool at the always-fail holder).
import { beforeAll, describe, expect, it } from "vitest";
import { SLOT_CONFIG_NETWORK, scriptFromNative, type Emulator, type LucidEvolution } from "@lucid-evolution/lucid";
import { createSigner, policyFromAllowance } from "../../src/node/signer/core.js";
import { evaluate } from "../../src/node/signer/policy.js";
import { readAllowance, readConfig } from "../../src/core/chain.js";
import { appFor } from "../../src/core/apps/catalogue.js";
import { minswapAdapter, minswapAppConfig } from "../../src/core/apps/minswap/adapter.js";
import { orderDatumFromData, poolDatumToData, type MinswapSettings } from "../../src/core/apps/minswap/data.js";
import { amountOut, minimumFor } from "../../src/core/apps/minswap/quote.js";
import { buildAgentTrade, ORDER_DEPOSIT } from "../../src/core/apps/minswap/trade.js";
import { LimitError } from "../../src/core/limits.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, signAndSubmit } from "../helpers.js";
import { RESERVE_A, RESERVE_B, tradeWorld } from "../trade-world.js";

let w: Awaited<ReturnType<typeof tradeWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
let unit: string;
const HOUR = 3_600_000n;
const dep = appFor("minswap", "Custom")!.network;
const settings: MinswapSettings = { pools: ["4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: HOUR, maxCancelTip: 500_000n };
const RA = RESERVE_A, RB = RESERVE_B;

const asOwner = () => lucid.selectWallet.fromPrivateKey(w.a.privateKey);
const ctx = () => w.agentCtx();

beforeAll(async () => {
  w = await tradeWorld(settings);
  ({ lucid, emulator, vault, unit } = w);
});

describe("agent trades on Minswap (emulator)", () => {
  it("an honest swap builds through the vault and the adapter, and lands", async () => {
    const before = await readAllowance(lucid, vault, unit);
    const built = await buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 5n * ADA, aToB: true, intentId: "swap-1", purpose: "test swap" });
    await signAndSubmit(lucid, emulator, built.tx, [w.agent]);
    const [o] = (await lucid.utxosAt(dep.orderAddress)).filter((u) => u.datum);
    const order = orderDatumFromData(o!.datum!)!;
    expect(order.amount).toBe(5n * ADA);
    expect(order.minimumReceive).toBe(minimumFor(amountOut(RA, RB, 5n * ADA, 30n), 300n));
    expect(order.maxBatcherFee).toBe(2_000_000n);
    expect(order.tip).toBe(500_000n);
    expect(order.adapter).toBe(minswapAdapter("Custom").hash);
    expect(o!.assets.lovelace).toBe(5n * ADA + 2_000_000n + ORDER_DEPOSIT + 500_000n);
    const after = await readAllowance(lucid, vault, unit);
    expect(after.datum.spent[0]).toBe(before.datum.spent[0]! + o!.assets.lovelace! + built.fee);
  });

  it("the adapter itself refuses an order one unit under the price floor (local script evaluation)", async () => {
    const err = await buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 1n * ADA, aToB: true, intentId: "swap-floor", purpose: "x", skipPreflight: true, tamper: (o) => ({ ...o, minimumReceive: o.minimumReceive - 1n }) }).then(() => undefined, (e: Error) => e);
    // The withdraw redeemer (the adapter) is what fails, not the vault's spend.
    expect(String(err?.message ?? err)).toMatch(/failed script execution Withdraw\[0\]/);
  });

  it("the budget counts the deposit and fees: an amount that fits alone but not with them is refused before building", async () => {
    // tx cap 20 ADA: 17 ADA + 2 fee + 2 deposit + 0.5 tip > 20.
    await expect(buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 17n * ADA, aToB: true, intentId: "swap-big", purpose: "too big" })).rejects.toMatchObject({ code: "TX_CAP" });
  });

  it("a pool the vault doesn't allow is refused", async () => {
    await expect(buildAgentTrade({ ...(await ctx()), pool: "4c51", amountIn: 1n * ADA, aToB: true, intentId: "swap-x", purpose: "x" })).rejects.toBeInstanceOf(LimitError);
  });

  it("the signer signs an honest trade and counts the whole order against its daily budget", async () => {
    const al = await readAllowance(lucid, vault, unit);
    const built = await buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 2n * ADA, aToB: true, intentId: "swap-sign", purpose: "sign" });
    const policy = policyFromAllowance({ datum: al.datum, unit, vault, network: "Custom", slot: SLOT_CONFIG_NETWORK.Custom! });
    const d = evaluate(policy, { signed: [], intents: {} }, built.tx.toCBOR(), emulator.now());
    expect(d).toMatchObject({ ok: true });
    expect(d.ok && d.out.lovelace).toBe(built.orderValue.lovelace! + built.fee);
  });

  it("the full signer (intent check, dedupe, policy) signs an honest trade", async () => {
    const al = await readAllowance(lucid, vault, unit);
    const built = await buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 2n * ADA, aToB: true, intentId: "swap-signer", purpose: "sign" });
    const signer = createSigner({ privateKey: w.agent.privateKey, policy: policyFromAllowance({ datum: al.datum, unit, vault, network: "Custom", slot: SLOT_CONFIG_NETWORK.Custom! }), now: () => emulator.now() });
    await expect(signer.sign(built.tx.toCBOR())).resolves.toMatch(/^[0-9a-f]+$/);
  });

  it("the signer refuses a trade for an app the allowance doesn't grant", async () => {
    const al = await readAllowance(lucid, vault, unit);
    const built = await buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 2n * ADA, aToB: true, intentId: "swap-sign-2", purpose: "sign" });
    const policy = policyFromAllowance({ datum: { ...al.datum, apps: [] }, unit, vault, network: "Custom", slot: SLOT_CONFIG_NETWORK.Custom! });
    expect(evaluate(policy, { signed: [], intents: {} }, built.tx.toCBOR(), emulator.now())).toMatchObject({ ok: false, reason: expect.stringMatching(/withdraw|app/i) });
  });

  it("after the owners disable Minswap, the agent's trade is refused with a readable reason", async () => {
    asOwner();
    await signAndSubmit(lucid, emulator, await owner.disableApp(lucid, vault, await readConfig(lucid, vault), "minswap", [w.a.pkh, w.b.pkh]), [w.a, w.b]);
    await expect(buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 1n * ADA, aToB: true, intentId: "swap-2", purpose: "x" })).rejects.toThrow(/isn't enabled/);
  });
});

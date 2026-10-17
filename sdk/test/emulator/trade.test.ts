// Agent trades on Minswap in the Lucid emulator. Every build runs the real vault and the
// real adapter through Lucid's local evaluator; the pool is a devnet-style fixture (the
// catalogue's Custom deployment: open mint policy, pool at the always-fail holder).
import { beforeAll, describe, expect, it } from "vitest";
import { scriptFromNative, type Emulator, type LucidEvolution } from "@lucid-evolution/lucid";
import { readAllowance, readConfig } from "../../src/core/chain.js";
import { appFor } from "../../src/core/apps/catalogue.js";
import { minswapAdapter, minswapAppConfig } from "../../src/core/apps/minswap/adapter.js";
import { orderDatumFromData, poolDatumToData, type MinswapSettings } from "../../src/core/apps/minswap/data.js";
import { amountOut, minimumFor } from "../../src/core/apps/minswap/quote.js";
import { buildAgentTrade, ORDER_DEPOSIT } from "../../src/core/apps/minswap/trade.js";
import { LimitError } from "../../src/core/limits.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../helpers.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
let unit: string;
const HOUR = 3_600_000n;
const dep = appFor("minswap", "Custom")!.network;
const P = dep.deployment.lpPolicy;
const settings: MinswapSettings = { pools: ["4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: HOUR, maxCancelTip: 500_000n };
const RA = 1_000_000_000_000n, RB = 2_000_000_000_000n;

const asOwner = () => lucid.selectWallet.fromPrivateKey(w.a.privateKey);
async function ctx() {
  const collateral = await collateralOf(lucid, w.agent);
  lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
  return { lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now() };
}

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  asOwner();
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  // The fixture pool: MSP + LP minted under the open policy, at the always-fail holder.
  const open = scriptFromNative({ type: "all", scripts: [] });
  const poolTx = await lucid
    .newTx()
    .mintAssets({ [P + "4d5350"]: 1n, [P + "4c50"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
    .attach.MintingPolicy(open)
    .pay.ToContract(dep.poolAddress, { kind: "inline", value: poolDatumToData({ assetA: { policy: "", name: "" }, assetB: { policy: P, name: "54455354" }, totalLiquidity: 1_000_000n, reserveA: RA, reserveB: RB, feeA: 30n, feeB: 30n, batchingStakeScript: "fb".repeat(28) }) }, { lovelace: 5n * ADA, [P + "4d5350"]: 1n, [P + "4c50"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
    .complete();
  await signAndSubmit(lucid, emulator, poolTx, [w.a]);
  // The adapter's stake credential, once per network.
  await signAndSubmit(lucid, emulator, await lucid.newTx().register.Stake(minswapAdapter("Custom").rewardAddress).complete(), [w.a]);
  await signAndSubmit(lucid, emulator, await owner.enableApp(lucid, vault, await readConfig(lucid, vault), minswapAppConfig("Custom", settings), [w.a.pkh, w.b.pkh]), [w.a, w.b]);
  const now = BigInt(emulator.now());
  const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault), {
    agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 50n * ADA, txCap: 20n * ADA }],
    periodMs: 86_400_000n, windowStart: now - HOUR, expiresAt: now + 30n * 86_400_000n, maxFee: 1_500_000n, fund: { lovelace: 60n * ADA }, apps: ["minswap"],
  }, [w.a.pkh, w.b.pkh]);
  unit = g.unit;
  await signAndSubmit(lucid, emulator, g.tx, [w.a, w.b]);
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

  it("after the owners disable Minswap, the agent's trade is refused with a readable reason", async () => {
    asOwner();
    await signAndSubmit(lucid, emulator, await owner.disableApp(lucid, vault, await readConfig(lucid, vault), "minswap", [w.a.pkh, w.b.pkh]), [w.a, w.b]);
    await expect(buildAgentTrade({ ...(await ctx()), pool: "4c50", amountIn: 1n * ADA, aToB: true, intentId: "swap-2", purpose: "x" })).rejects.toThrow(/isn't enabled/);
  });
});

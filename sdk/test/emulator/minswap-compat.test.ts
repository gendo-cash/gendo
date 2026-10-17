// Our orders under Minswap's own validators (deployed/preprod at c3293ad), evaluated
// locally: an order we place must be decodable by Minswap, or its funds are stuck
// forever (two research orders were, see docs). Here an expired order of ours is refunded
// to the vault through Minswap's own CancelExpiredOrderByAnyone path.
import { beforeAll, describe, expect, it } from "vitest";
import { Constr, Data, scriptFromNative, validatorToRewardAddress, validatorToScriptHash, type Emulator, type LucidEvolution, type Script } from "@lucid-evolution/lucid";
import scripts from "../fixtures/minswap-preprod-scripts.json" with { type: "json" };
import { readAllowance, readConfig, treasuryUtxos } from "../../src/core/chain.js";
import { appFor } from "../../src/core/apps/catalogue.js";
import { minswapAdapter, minswapAppConfig } from "../../src/core/apps/minswap/adapter.js";
import { poolDatumToData, type MinswapSettings } from "../../src/core/apps/minswap/data.js";
import { buildAgentTrade } from "../../src/core/apps/minswap/trade.js";
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
const settings: MinswapSettings = { pools: ["860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 600_000n, maxCancelTip: 500_000n };
const orderScript = scripts.orderScript as Script;
const cancelScript = scripts.expiredOrderCancelScript as Script;

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  const open = scriptFromNative({ type: "all", scripts: [] });
  const pool = await lucid
    .newTx()
    .mintAssets({ [P + "4d5350"]: 1n, [P + "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
    .attach.MintingPolicy(open)
    .pay.ToContract(dep.poolAddress, { kind: "inline", value: poolDatumToData({ assetA: { policy: "", name: "" }, assetB: { policy: P, name: "54455354" }, totalLiquidity: 1_000_000n, reserveA: 10n ** 12n, reserveB: 2n * 10n ** 12n, feeA: 30n, feeB: 30n, batchingStakeScript: "fb".repeat(28) }) }, { lovelace: 5n * ADA, [P + "4d5350"]: 1n, [P + "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
    .complete();
  await signAndSubmit(lucid, emulator, pool, [w.a]);
  for (const reward of [minswapAdapter("Custom").rewardAddress, validatorToRewardAddress("Custom", cancelScript)])
    await signAndSubmit(lucid, emulator, await lucid.newTx().register.Stake(reward).complete(), [w.a]);
  await signAndSubmit(lucid, emulator, await owner.enableApp(lucid, vault, await readConfig(lucid, vault), minswapAppConfig("Custom", settings), [w.a.pkh, w.b.pkh]), [w.a, w.b]);
  const now = BigInt(emulator.now());
  const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault), {
    agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 50n * ADA, txCap: 20n * ADA }],
    periodMs: 86_400_000n, windowStart: now - HOUR, expiresAt: now + 30n * 86_400_000n, maxFee: 1_500_000n, fund: { lovelace: 60n * ADA }, apps: ["minswap"],
  }, [w.a.pkh, w.b.pkh]);
  unit = g.unit;
  await signAndSubmit(lucid, emulator, g.tx, [w.a, w.b]);
});

describe("our orders under Minswap's own validators (emulator)", () => {
  it("the catalogue's order script is the one Minswap deployed", () => {
    expect(validatorToScriptHash(orderScript)).toBe(dep.deployment.orderScript);
    expect(validatorToRewardAddress("Preprod", cancelScript)).toBe(scripts.expiredOrderCancelAddress);
  });

  it("an expired order of ours is refunded to the vault through Minswap's CancelExpiredOrderByAnyone", async () => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    const built = await buildAgentTrade({ lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now(), pool: "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f", amountIn: 5n * ADA, aToB: true, intentId: "compat-1", purpose: "compat" });
    await signAndSubmit(lucid, emulator, built.tx, [w.agent]);
    const [order] = (await lucid.utxosAt(dep.orderAddress)).filter((u) => u.datum);
    // Past the order's expiry (10 minutes after the trade's upper bound).
    emulator.awaitSlot(Number(settings.maxOrderTtlMs / 1000n) + 1200);
    lucid.selectWallet.fromPrivateKey(w.c.privateKey);
    const before = (await treasuryUtxos(lucid, vault)).reduce((n, u) => n + u.assets.lovelace!, 0n);
    const cancel = await lucid
      .newTx()
      .collectFrom([order!], Data.to(new Constr(2, []))) // CancelExpiredOrderByAnyone
      .attach.SpendingValidator(orderScript)
      .withdraw(validatorToRewardAddress("Custom", cancelScript), 0n, Data.void())
      .attach.WithdrawalValidator(cancelScript)
      .pay.ToAddress(vault.address, { lovelace: order!.assets.lovelace! - built.order.tip })
      .validFrom(emulator.now() - 60_000)
      .complete();
    // Minswap's validator really runs: the same cancel paying anyone else is refused.
    const thief = lucid
      .newTx()
      .collectFrom([order!], Data.to(new Constr(2, [])))
      .attach.SpendingValidator(orderScript)
      .withdraw(validatorToRewardAddress("Custom", cancelScript), 0n, Data.void())
      .attach.WithdrawalValidator(cancelScript)
      .pay.ToAddress(w.c.address, { lovelace: order!.assets.lovelace! - built.order.tip })
      .validFrom(emulator.now() - 60_000)
      .complete();
    await expect(thief).rejects.toThrow(/failed script execution/);
    await signAndSubmit(lucid, emulator, cancel, [w.c]);
    const after = (await treasuryUtxos(lucid, vault)).reduce((n, u) => n + u.assets.lovelace!, 0n);
    expect(after - before).toBe(order!.assets.lovelace! - built.order.tip);
  });
});

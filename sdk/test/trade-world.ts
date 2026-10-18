// An emulator world ready for Minswap trades: a 2-of-3 vault with Minswap enabled, the
// devnet-style fixture pool (open mint policy, at the always-fail holder), the adapter's
// stake credential registered, and an agent granted Minswap.
import { scriptFromNative, type Emulator, type LucidEvolution } from "@lucid-evolution/lucid";
import { appFor } from "../src/core/apps/catalogue.js";
import { minswapAdapter, minswapAppConfig } from "../src/core/apps/minswap/adapter.js";
import { poolDatumToData, type MinswapSettings } from "../src/core/apps/minswap/data.js";
import { lpNameOf } from "../src/core/apps/minswap/quote.js";
import { readAllowance, readConfig } from "../src/core/chain.js";
import * as owner from "../src/core/owner.js";
import type { Vault } from "../src/core/vault.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "./helpers.js";

export const HOUR = 3_600_000n;
export const RESERVE_A = 1_000_000_000_000n;
export const RESERVE_B = 2_000_000_000_000n;
export const DEVNET = appFor("minswap", "Custom")!.network;

/** A fixture pool ADA / (devnet policy + `tokenHex`), as genuine as the devnet's; returns its LP name. */
export async function mintPool(lucid: LucidEvolution, emulator: Emulator, signer: { privateKey: string }, tokenHex: string): Promise<string> {
  const P = DEVNET.deployment.lpPolicy;
  const assetB = { policy: P, name: tokenHex };
  const lp = lpNameOf({ assetA: { policy: "", name: "" }, assetB });
  const tx = await lucid
    .newTx()
    .mintAssets({ [P + "4d5350"]: 1n, [P + lp]: 1_000_000n, [P + tokenHex]: 1_000_000n })
    .attach.MintingPolicy(scriptFromNative({ type: "all", scripts: [] }))
    .pay.ToContract(
      DEVNET.poolAddress,
      { kind: "inline", value: poolDatumToData({ assetA: { policy: "", name: "" }, assetB, totalLiquidity: 1_000_000n, reserveA: RESERVE_A, reserveB: RESERVE_B, feeA: 30n, feeB: 30n, batchingStakeScript: "fb".repeat(28) }) },
      { lovelace: 5n * ADA, [P + "4d5350"]: 1n, [P + lp]: 1_000_000n, [P + tokenHex]: 1_000_000n },
    )
    .complete();
  await signAndSubmit(lucid, emulator, tx, [signer]);
  return lp;
}

export async function tradeWorld(settings: MinswapSettings, extraStake: string[] = []) {
  const w = await emulatorWorld();
  const { lucid, emulator } = w;
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  const vault: Vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await mintPool(lucid, emulator, w.a, "54455354"); // ADA ↔ TEST, the catalogue's devnet pool
  for (const reward of [minswapAdapter("Custom").rewardAddress, ...extraStake])
    await signAndSubmit(lucid, emulator, await lucid.newTx().register.Stake(reward).complete(), [w.a]);
  await signAndSubmit(lucid, emulator, await owner.enableApp(lucid, vault, await readConfig(lucid, vault), minswapAppConfig("Custom", settings), [w.a.pkh, w.b.pkh]), [w.a, w.b]);
  const now = BigInt(emulator.now());
  const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault), {
    agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 50n * ADA, txCap: 20n * ADA }],
    periodMs: 86_400_000n, windowStart: now - HOUR, expiresAt: now + 30n * 86_400_000n, maxFee: 1_500_000n, fund: { lovelace: 60n * ADA }, apps: ["minswap"],
  }, [w.a.pkh, w.b.pkh]);
  await signAndSubmit(lucid, emulator, g.tx, [w.a, w.b]);
  const unit = g.unit;
  /** What buildAgentTrade needs, as the agent (selects the agent's collateral as the wallet). */
  const agentCtx = async () => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    return { lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now() };
  };
  return { ...w, lucid: lucid as LucidEvolution, emulator: emulator as Emulator, vault, unit, agentCtx };
}

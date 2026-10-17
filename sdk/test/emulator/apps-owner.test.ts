// Owners enable, change and disable an app, and grant it to an agent; the review explains it.
import { beforeAll, describe, expect, it } from "vitest";
import { CML, type Emulator, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { readAllowance, readConfig } from "../../src/core/chain.js";
import { describeTx } from "../../src/core/cosign.js";
import { appChanges, explainTx } from "../../src/core/explain.js";
import { minswapAppConfig } from "../../src/core/apps/minswap/adapter.js";
import { settingsFromData, type MinswapSettings } from "../../src/core/apps/minswap/data.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, emulatorWorld, signAndSubmit } from "../helpers.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
const HOUR = 3_600_000n;
const settings: MinswapSettings = { pools: ["4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: HOUR, maxCancelTip: 500_000n };

const inputsOf = async (cbor: string): Promise<UTxO[]> => {
  const body = CML.Transaction.from_cbor_hex(cbor).body();
  const refs = describeTx(cbor).inputs.map((r) => ({ txHash: r.split("#")[0]!, outputIndex: Number(r.split("#")[1]) }));
  const ci = body.collateral_inputs();
  for (let i = 0; ci && i < ci.len(); i++) refs.push({ txHash: ci.get(i).transaction_id().to_hex(), outputIndex: Number(ci.get(i).index()) });
  return lucid.utxosByOutRef(refs);
};

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 200n * ADA }), [w.a]);
});

describe("apps on a vault (emulator)", () => {
  it("owners enable Minswap at threshold; the review shows what it enables", async () => {
    const app = minswapAppConfig("Custom", settings);
    const tx = await owner.enableApp(lucid, vault, await readConfig(lucid, vault), app, [w.a.pkh, w.b.pkh]);
    const ex = explainTx(tx.toCBOR(), vault, await inputsOf(tx.toCBOR()));
    const c = ex.changes.find((x) => x.kind === "config");
    expect(c && c.kind === "config" && appChanges(c.before, c.after)).toEqual({ added: [app], removed: [], changed: [] });
    await signAndSubmit(lucid, emulator, tx, [w.a, w.b]);
    const cfg = (await readConfig(lucid, vault)).config;
    expect(cfg.apps).toHaveLength(1);
    expect(settingsFromData(cfg.apps[0]!.settings)).toEqual(settings);
  });

  it("enabling the same app twice is refused before building", async () => {
    await expect(owner.enableApp(lucid, vault, await readConfig(lucid, vault), minswapAppConfig("Custom", settings), [w.a.pkh, w.b.pkh])).rejects.toThrow(/already enabled/);
  });

  it("owners change its settings; the review shows the change", async () => {
    const next = minswapAppConfig("Custom", { ...settings, maxSlippageBps: 100n });
    const tx = await owner.updateApp(lucid, vault, await readConfig(lucid, vault), next, [w.a.pkh, w.c.pkh]);
    const ex = explainTx(tx.toCBOR(), vault, await inputsOf(tx.toCBOR()));
    const c = ex.changes.find((x) => x.kind === "config")!;
    const diff = c.kind === "config" ? appChanges(c.before, c.after) : undefined;
    expect(diff?.changed.map((x) => x.name)).toEqual(["minswap"]);
    await signAndSubmit(lucid, emulator, tx, [w.a, w.c]);
    expect(settingsFromData((await readConfig(lucid, vault)).config.apps[0]!.settings).maxSlippageBps).toBe(100n);
  });

  it("a grant can let the agent use the app", async () => {
    const now = BigInt(emulator.now());
    const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault), {
      agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 86_400_000n, windowStart: now, expiresAt: now + 30n * 86_400_000n, maxFee: 1_000_000n, fund: { lovelace: 30n * ADA }, apps: ["minswap"],
    }, [w.a.pkh, w.b.pkh]);
    await signAndSubmit(lucid, emulator, g.tx, [w.a, w.b]);
    expect((await readAllowance(lucid, vault, g.unit)).datum.apps).toEqual(["minswap"]);
  });

  it("owners disable it", async () => {
    const tx = await owner.disableApp(lucid, vault, await readConfig(lucid, vault), "minswap", [w.a.pkh, w.b.pkh]);
    await signAndSubmit(lucid, emulator, tx, [w.a, w.b]);
    expect((await readConfig(lucid, vault)).config.apps).toEqual([]);
  });

  it("one owner alone can't enable an app", async () => {
    await expect(owner.enableApp(lucid, vault, await readConfig(lucid, vault), minswapAppConfig("Custom", settings), [w.a.pkh])).rejects.toThrow(/needs 2 current owners/);
  });
});

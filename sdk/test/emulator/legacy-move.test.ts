// Moving a version-1 vault (from before apps) into a current vault, through the old validator.
import { beforeAll, describe, expect, it } from "vitest";
import type { Emulator, LucidEvolution } from "@lucid-evolution/lucid";
import { readConfig } from "../../src/core/chain.js";
import { explainTx } from "../../src/core/explain.js";
import { vaultVersionOf } from "../../src/core/legacy.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, emulatorWorld, signAndSubmit } from "../helpers.js";
import { createV1Vault, grantV1 } from "../v1-world.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let old: Vault;
let fresh: Vault;
let units: string[];

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  old = await createV1Vault(lucid, emulator, w.a, [w.a.pkh, w.b.pkh, w.c.pkh], 2n);
  units = [
    await grantV1(lucid, emulator, old, w.a, [w.a, w.b], w.agent.pkh, w.payee.address, 20n * ADA),
    await grantV1(lucid, emulator, old, w.a, [w.a, w.b], w.payee2.pkh, w.payee.address, 7n * ADA),
  ];
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: 3_600_000n, apps: [] });
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  fresh = created.vault;
});

const sum = async (address: string, unit = "lovelace") => (await lucid.utxosAt(address)).reduce((n, u) => n + (u.assets[unit] ?? 0n), 0n);

describe("moving an old vault to the current version (emulator)", () => {
  it("an old vault's id still names it, as version 1", () => {
    expect(vaultVersionOf({ network: "Custom", seed: old.seed }, old.hash)?.version).toBe(1);
    expect(vaultVersionOf({ network: "Custom", seed: fresh.seed }, fresh.hash)?.version).toBe(2);
    expect(vaultVersionOf({ network: "Custom", seed: fresh.seed }, old.hash)).toBeUndefined();
  });

  it("refuses a destination with other owners or another threshold", async () => {
    const cfg = (await readConfig(lucid, fresh)).config;
    await expect(owner.moveToCurrentVault(lucid, old, fresh, { ...cfg, owners: [w.a.pkh, w.b.pkh] }, [w.a.pkh, w.b.pkh])).rejects.toThrow(/same owners/);
    await expect(owner.moveToCurrentVault(lucid, old, fresh, { ...cfg, threshold: 1n }, [w.a.pkh, w.b.pkh])).rejects.toThrow(/same owners/);
  });

  it("the old validator refuses a move signed below the threshold", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const cfg = (await readConfig(lucid, fresh)).config;
    await expect(owner.moveToCurrentVault(lucid, old, fresh, cfg, [w.a.pkh])).rejects.toThrow(/failed script execution|Spend|Mint/i);
  });

  it("moves the treasury and every budget, burns the old tokens, and leaves only the old config", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const before = await sum(fresh.address);
    const oldTotal = (await lucid.utxosAt(old.address)).filter((u) => !u.assets[old.configUnit]).reduce((n, u) => n + u.assets.lovelace!, 0n);
    expect(oldTotal).toBe(127n * ADA);
    const cfg = (await readConfig(lucid, fresh)).config;
    const tx = await owner.moveToCurrentVault(lucid, old, fresh, cfg, [w.a.pkh, w.b.pkh]);

    // What a co-owner reviews: two budgets closed, everything else leaves for the new vault.
    const inputs = await lucid.utxosByOutRef((await lucid.utxosAt(old.address)).map((u) => ({ txHash: u.txHash, outputIndex: u.outputIndex })));
    const ex = explainTx(tx.toCBOR(), old, [...inputs, ...(await lucid.utxosAt(w.a.address))], { viewer: w.b.pkh, version: 1 });
    const revokes = ex.changes.filter((c) => c.kind === "revoke") as { unit: string; before: { agent: string } | null }[];
    expect(revokes.map((c) => c.unit).sort()).toEqual([...units].sort());
    expect(revokes.map((c) => c.before?.agent).sort()).toEqual([w.agent.pkh, w.payee2.pkh].sort()); // old datums read as version 1
    expect(ex.flows.find((f) => f.address === fresh.address)?.delta.lovelace).toBe(127n * ADA);

    await signAndSubmit(lucid, emulator, tx, [w.a, w.b]);
    expect(await sum(fresh.address) - before).toBe(127n * ADA);
    const left = await lucid.utxosAt(old.address);
    expect(left).toHaveLength(1);
    expect(left[0]!.assets[old.configUnit]).toBe(1n);
    for (const u of units) expect(await sum(old.address, u)).toBe(0n);
  });

  it("then there's nothing left to move", async () => {
    const cfg = (await readConfig(lucid, fresh)).config;
    await expect(owner.moveToCurrentVault(lucid, old, fresh, cfg, [w.a.pkh, w.b.pkh])).rejects.toThrow(/nothing left/);
  });
});

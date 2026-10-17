// sdk/test/emulator/explain.test.ts
// explainTx must say exactly what each owner/escalation tx does, from the tx and its inputs alone.
import { beforeAll, describe, expect, it } from "vitest";
import { CML, credentialToRewardAddress, mintingPolicyToId, scriptFromNative, type Emulator, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { buildOverLimitSpend } from "../../src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../src/core/chain.js";
import { describeTx } from "../../src/core/cosign.js";
import { explainTx, verifiedOutputs } from "../../src/core/explain.js";
import * as owner from "../../src/core/owner.js";
import type { Vault } from "../../src/core/vault.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../helpers.js";

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
let emulator: Emulator;
let vault: Vault;
let unit: string;
const HOUR = 3_600_000n;

// Inputs and collateral inputs, as the app resolves them.
const inputsOf = async (cbor: string): Promise<UTxO[]> => {
  const body = CML.Transaction.from_cbor_hex(cbor).body();
  const refs = describeTx(cbor).inputs.map((r) => ({ txHash: r.split("#")[0]!, outputIndex: Number(r.split("#")[1]) }));
  const ci = body.collateral_inputs();
  for (let i = 0; ci && i < ci.len(); i++) refs.push({ txHash: ci.get(i).transaction_id().to_hex(), outputIndex: Number(ci.get(i).index()) });
  return lucid.utxosByOutRef(refs);
};
const explain = async (cbor: string, viewer?: string) => explainTx(cbor, vault, await inputsOf(cbor), { viewer });

beforeAll(async () => {
  w = await emulatorWorld();
  ({ lucid, emulator } = w);
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh, w.c.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 500n * ADA }), [w.a]);
  const now = BigInt(emulator.now());
  const granted = await owner.grantAllowance(
    lucid, vault, await readConfig(lucid, vault),
    { agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 100n * ADA } },
    [w.a.pkh, w.b.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) },
  );
  unit = granted.unit;
  await signAndSubmit(lucid, emulator, granted.tx, [w.a, w.b]);
}, 120_000);

describe("explainTx", () => {
  it("an edit: the allowance before and after, nothing leaves the vault", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const al = await readAllowance(lucid, vault, unit);
    const next = { ...al.datum, caps: [{ ...al.datum.caps[0]!, txCap: 5n * ADA }] };
    const tx = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, next, [w.a.pkh, w.c.pkh]);
    const e = await explain(tx.toCBOR(), w.a.pkh);
    expect(e.changes).toEqual([{ kind: "edit", unit, before: al.datum, after: next, lovelaceBefore: 100n * ADA, lovelaceAfter: 100n * ADA }]);
    expect(e.leavesVault).toEqual({});
    expect(e.requiredSigners.sort()).toEqual([w.a.pkh, w.c.pkh].sort());
    expect(e.warnings).toEqual([]);
  });

  it("a single-owner pause: the config before and after", async () => {
    const cfg = await readConfig(lucid, vault);
    const e = await explain((await owner.pause(lucid, vault, cfg, [w.a.pkh])).toCBOR());
    expect(e.changes).toEqual([{ kind: "config", before: cfg.config, after: { ...cfg.config, paused: true } }]);
    expect(e.requiredSigners).toEqual([w.a.pkh]);
    expect(e.ttlSlot).toBeTypeOf("number");
  });

  it("a creation: the new config and the ADA held with it, apart from the treasury deposit", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const init = { owners: [w.a.pkh, w.b.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] };
    const { tx, vault: v } = await owner.createVault(lucid, init, { fund: 20n * ADA, signer: w.a.pkh });
    const cbor = tx.toCBOR();
    const e = explainTx(cbor, v, await inputsOf(cbor), { viewer: w.a.pkh });
    const cfgOut = tx.toTransaction().body().outputs().get(0).amount().coin();
    expect(e.changes).toEqual([{ kind: "config", before: null, after: init, deposit: cfgOut }]);
    expect(e.flows.find((f) => f.address === v.address)?.delta.lovelace).toBe(cfgOut + 20n * ADA);
  });

  it("a revoke returns the funds to the vault", async () => {
    const al = await readAllowance(lucid, vault, unit);
    const e = await explain((await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), al, [w.a.pkh, w.b.pkh])).toCBOR());
    expect(e.changes).toEqual([{ kind: "revoke", unit, before: al.datum, lovelace: 100n * ADA }]);
    expect(e.leavesVault).toEqual({});
  });

  it("a treasury payment shows exactly what leaves the vault and to whom", async () => {
    const from = await treasuryUtxos(lucid, vault);
    const tx = await owner.treasuryPay(lucid, vault, await readConfig(lucid, vault), from, [{ to: w.stranger.address, assets: { lovelace: 7n * ADA } }], [w.a.pkh, w.b.pkh]);
    const e = await explain(tx.toCBOR());
    expect(e.changes).toEqual([]);
    expect(e.leavesVault).toEqual({ lovelace: 7n * ADA });
    expect(e.flows).toContainEqual({ address: w.stranger.address, delta: { lovelace: 7n * ADA } });
  });

  it("an escalation: a co-signed spend of the allowance, with its intent", async () => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    const built = await buildOverLimitSpend({
      lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now(),
      payments: [{ to: w.stranger.address, assets: { lovelace: 40n * ADA } }],
      intentId: "INV-9", purpose: "vendor prepayment", cosigners: [w.a.pkh, w.c.pkh],
    });
    const e = await explain(built.tx.toCBOR());
    expect(e.changes).toHaveLength(1);
    expect(e.changes[0]).toMatchObject({ kind: "spend", unit, redeemer: "CoSignedSpend" });
    expect(e.intent).toMatchObject({ id: "INV-9", purpose: "vendor prepayment" });
    expect(e.flows).toContainEqual({ address: w.stranger.address, delta: { lovelace: 40n * ADA } });
    expect(e.leavesVault.lovelace).toBeGreaterThanOrEqual(40n * ADA); // the fee comes out of the allowance too
    expect(e.collateralAtRisk).toEqual([{ address: w.agent.address, lovelace: expect.any(BigInt) }]);
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  });

  it("warns when it can't see an input, so nothing unseen gets signed", async () => {
    const cfg = await readConfig(lucid, vault);
    const cbor = (await owner.pause(lucid, vault, cfg, [w.a.pkh])).toCBOR();
    const e = explainTx(cbor, vault, []);
    expect(e.warnings.join(" ")).toMatch(/couldn't see/);
  });

  it("a tx that also spends a co-owner's own wallet says so to that owner", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const [bUtxo] = await lucid.utxosAt(w.b.address);
    const tx = await lucid.newTx().collectFrom([bUtxo!]).pay.ToAddress(w.stranger.address, { lovelace: 50n * ADA }).addSignerKey(w.b.pkh).complete();
    const e = await explain(tx.toCBOR(), w.b.pkh);
    expect(e.warnings.join(" ")).toMatch(/takes .* from your wallet/);
    expect(e.flows.find((f) => f.address === w.b.address)!.delta.lovelace).toBeLessThan(-49n * ADA);
  });

  it("reports minting under another policy and staking certificates", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const script = scriptFromNative({ type: "sig", keyHash: w.a.pkh });
    const tok = mintingPolicyToId(script) + "74";
    const tx = await lucid.newTx().mintAssets({ [tok]: 1n }).attach.MintingPolicy(script)
      .registerStake(credentialToRewardAddress("Custom", { type: "Key", hash: w.a.pkh })).complete();
    const e = await explain(tx.toCBOR(), w.a.pkh);
    expect(e.warnings.join(" ")).toMatch(/mints or burns tokens of another policy/);
    expect(e.warnings.join(" ")).toMatch(/staking/);
  });

  it("an owner change that drops the viewer says so", async () => {
    const cfg = await readConfig(lucid, vault);
    const e = await explain((await owner.rotateOwners(lucid, vault, cfg, [w.a.pkh, w.b.pkh], 2n, [w.a.pkh, w.b.pkh])).toCBOR(), w.c.pkh);
    expect(e.warnings.join(" ")).toMatch(/removes you as an owner/);
  });

  it("native tokens leaving the treasury are counted, not just ADA", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const script = scriptFromNative({ type: "sig", keyHash: w.a.pkh });
    const tok = mintingPolicyToId(script) + "75";
    await signAndSubmit(lucid, emulator, await lucid.newTx().mintAssets({ [tok]: 5n }).attach.MintingPolicy(script).complete(), [w.a]);
    await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 2n * ADA, [tok]: 5n }), [w.a]);
    const from = (await treasuryUtxos(lucid, vault)).filter((u) => (u.assets[tok] ?? 0n) > 0n);
    const tx = await owner.treasuryPay(lucid, vault, await readConfig(lucid, vault), from, [{ to: w.stranger.address, assets: { lovelace: 2n * ADA, [tok]: 5n } }], [w.a.pkh, w.b.pkh]);
    const e = await explain(tx.toCBOR());
    expect(e.leavesVault[tok]).toBe(5n);
  });

  it("rebuilds inputs from the txs that created them, refusing a forged one", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const made = (await owner.fundTreasury(lucid, vault, { lovelace: 9n * ADA })).toCBOR();
    const other = (await owner.fundTreasury(lucid, vault, { lovelace: 8n * ADA })).toCBOR();
    const hash = describeTx(made).hash;
    const [u] = await verifiedOutputs(async () => made, [`${hash}#0`]);
    expect(u).toMatchObject({ txHash: hash, outputIndex: 0, address: vault.address, assets: { lovelace: 9n * ADA } });
    await expect(verifiedOutputs(async () => other, [`${hash}#0`])).rejects.toThrow(/doesn't match/);
  });
  it("'your wallet' covers every key the viewer's wallet holds", async () => {
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const [bUtxo] = await lucid.utxosAt(w.b.address);
    const tx = await lucid.newTx().collectFrom([bUtxo!]).pay.ToAddress(w.stranger.address, { lovelace: 50n * ADA }).addSignerKey(w.b.pkh).complete();
    const e = explainTx(tx.toCBOR(), vault, await inputsOf(tx.toCBOR()), { viewer: [w.c.pkh, w.b.pkh] });
    expect(e.warnings.join(" ")).toMatch(/takes .* from your wallet/);
  });
});


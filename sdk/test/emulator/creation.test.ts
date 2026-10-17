// sdk/test/emulator/creation.test.ts
// creationOf must accept exactly a gendo vault creation, and say which vault it makes.
import { beforeAll, describe, expect, it } from "vitest";
import { CML, mintingPolicyToId, scriptFromNative, type LucidEvolution } from "@lucid-evolution/lucid";
import { creationOf } from "../../src/core/creation.js";
import { configToData, mintRedeemer } from "../../src/core/data.js";
import * as owner from "../../src/core/owner.js";
import { formatVaultId, makeVault, refHolderAddress } from "../../src/core/vault.js";
import { ADA, emulatorWorld, signAndSubmit } from "../helpers.js";
import { blindEvaluator } from "../yaci/attacker.js"; // builds without running the scripts

let w: Awaited<ReturnType<typeof emulatorWorld>>;
let lucid: LucidEvolution;
const init = () => ({ owners: [w.a.pkh, w.b.pkh], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] });

beforeAll(async () => {
  w = await emulatorWorld();
  lucid = w.lucid;
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
}, 60_000);

describe("creationOf", () => {
  it("a creation with a reference script and treasury funding: the vault, its id and the funding", async () => {
    const { tx, vault } = await owner.createVault(lucid, init(), { refScriptAddress: refHolderAddress("Custom"), fund: 20n * ADA, signer: w.a.pkh });
    const c = creationOf(tx.toCBOR(), "Custom");
    expect(c.vault.hash).toBe(vault.hash);
    expect(c.config).toEqual(init());
    expect(c.treasuryLovelace).toBe(20n * ADA);
    expect(c.id.seed).toEqual(vault.seed);
    expect(c.id.refScript?.txHash).toBe(tx.toHash());
    // The id names the output that really holds the reference script.
    const ref = tx.toTransaction().body().outputs().get(c.id.refScript!.outputIndex);
    expect(ref.script_ref()?.hash().to_hex()).toBe(vault.hash);
    expect(tx.toTransaction().body().required_signers()?.get(0).to_hex()).toBe(w.a.pkh);
    // And it lands: the vault exists afterwards.
    await signAndSubmit(lucid, w.emulator, tx, [w.a]);
    expect(formatVaultId(c.id)).toMatch(/^gendo:custom:[0-9a-f]{64}#\d+:[0-9a-f]{64}#\d+$/);
  });
  it("a creation without a reference script has a one-part id", async () => {
    const { tx } = await owner.createVault(lucid, init());
    expect(creationOf(tx.toCBOR(), "Custom").id.refScript).toBeUndefined();
  });
  it("refuses a plain payment", async () => {
    const tx = await lucid.newTx().pay.ToAddress(w.b.address, { lovelace: 2n * ADA }).complete();
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/mints exactly one token/);
  });
  it("refuses a config token sent somewhere other than the vault", async () => {
    const seed = (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1)!;
    const vault = makeVault("Custom", { txHash: seed.txHash, outputIndex: seed.outputIndex });
    const tx = await lucid.newTx().collectFrom([seed])
      .mintAssets({ [vault.configUnit]: 1n }, mintRedeemer("InitConfig")).attach.MintingPolicy(vault.script)
      .pay.ToAddressWithData(w.b.address, { kind: "inline", value: configToData(init()) }, { lovelace: 2n * ADA, [vault.configUnit]: 1n })
      .complete({ evaluator: blindEvaluator, setCollateral: 4n * ADA });
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/vault's token leaves the vault/);
  });
  it("refuses an invalid config (threshold above the owner count)", async () => {
    await expect(owner.createVault(lucid, { ...init(), threshold: 3n })).rejects.toThrow(/threshold out of range/);
  });
  it("refuses a reference script parked anywhere but the always-fail holder (someone could spend it)", async () => {
    const { tx } = await owner.createVault(lucid, init(), { refScriptAddress: w.b.address });
    expect(() => creationOf(tx.toCBOR(), "Custom")).toThrow(/unexpected reference script/);
  });
  it("a wallet holding tokens can create: its own tokens come back to it as change", async () => {
    const policy = scriptFromNative({ type: "sig", keyHash: w.a.pkh });
    const unit = mintingPolicyToId(policy) + "746f6b";
    // All of A's ADA ends up next to the token, except one small plain output for the seed.
    const mint = await lucid.newTx().collectFrom(await lucid.wallet().getUtxos()).mintAssets({ [unit]: 5n }).attach.MintingPolicy(policy)
      .pay.ToAddress(w.a.address, { lovelace: 3n * ADA }).complete();
    await signAndSubmit(lucid, w.emulator, mint, [w.a]);
    const { tx } = await owner.createVault(lucid, init(), { refScriptAddress: refHolderAddress("Custom"), signer: w.a.pkh });
    expect(creationOf(tx.toCBOR(), "Custom").config).toEqual(init());
  });
  it("refuses a tx with more inputs than a creation needs, before any script work", async () => {
    const { tx } = await owner.createVault(lucid, init());
    const body = tx.toTransaction().body();
    const ins = CML.TransactionInputList.new();
    for (let i = 0; i < 400; i++) ins.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(i.toString(16).padStart(64, "0")), 0n));
    const big = CML.TransactionBody.new(ins, body.outputs(), body.fee());
    big.set_mint(body.mint()!);
    const cbor = CML.Transaction.new(big, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
    const t0 = performance.now();
    expect(() => creationOf(cbor, "Custom")).toThrow(/too many inputs/);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

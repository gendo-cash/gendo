// The in-process signer applies the same policy as the daemon: it signs an allowed spend and refuses an unapproved payee.
import { describe, expect, it } from "vitest";
import { buildAgentSpend } from "../../src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../src/core/chain.js";
import * as owner from "../../src/core/owner.js";
import { createSigner, policyFromAllowance } from "../../src/node/signer/core.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../helpers.js";

describe("in-process signer", async () => {
  const w = await emulatorWorld();
  const { lucid, emulator } = w;
  const HOUR = 3_600_000n;
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh], threshold: 1n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  const vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 300n * ADA }), [w.a]);
  const now = BigInt(emulator.now());
  const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault),
    { agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 100n * ADA } },
    [w.a.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) });
  await signAndSubmit(lucid, emulator, g.tx, [w.a]);
  const al = await readAllowance(lucid, vault, g.unit);
  const slot = { zeroTime: lucid.slotToUnixTime(0), zeroSlot: 0, slotLength: lucid.slotToUnixTime(1) - lucid.slotToUnixTime(0) };
  const signer = createSigner({ privateKey: w.agent.privateKey, policy: policyFromAllowance({ datum: al.datum, unit: g.unit, vault, network: "Custom", slot }), now: () => emulator.now() });
  const spend = async (to: string, id: string) => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    return (await buildAgentSpend({ lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: al, now: emulator.now(),
      payments: [{ to, assets: { lovelace: 3n * ADA } }], intentId: id, purpose: "p", skipPreflight: true })).tx.toCBOR();
  };

  it("derives its policy from the allowance", () => {
    const p = policyFromAllowance({ datum: al.datum, unit: g.unit, vault, network: "Custom", slot });
    expect(p).toMatchObject({ agentKeyHash: w.agent.pkh, allowanceUnit: g.unit, destinations: [w.payee.address], maxPerDay: { lovelace: 20n * ADA } });
  });
  it("signs a spend to an approved payee", async () => expect(await signer.sign(await spend(w.payee.address, "INV-1"))).toMatch(/^[0-9a-f]+$/));
  it("refuses what its policy doesn't allow, like the daemon", async () => {
    // A payee list stricter than the chain's: the tx is valid on chain, the signer still says no.
    const strict = createSigner({ privateKey: w.agent.privateKey, policy: { ...policyFromAllowance({ datum: al.datum, unit: g.unit, vault, network: "Custom", slot }), destinations: [] }, now: () => emulator.now() });
    await expect(strict.sign(await spend(w.payee.address, "INV-2"))).rejects.toThrow(/^signer refused:/);
  });
});

// The paired agent's signer: it reads its rules from the allowance on every payment (owners' edits apply
// without a restart) and asks the chain about an earlier tx for the same intent (a dropped payment can be retried).
import { describe, expect, it } from "vitest";
import { buildAgentSpend } from "../../sdk/src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../sdk/src/core/chain.js";
import type { ChainQuery } from "../../sdk/src/core/idempotency.js";
import * as owner from "../../sdk/src/core/owner.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../../sdk/test/helpers.js";
import { pairedSigner } from "../src/signer.js";

describe("the paired agent's signer", async () => {
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
  const spend = async (lovelace: bigint, id: string) => {
    const collateral = await collateralOf(lucid, w.agent);
    lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
    return (await buildAgentSpend({ lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: al, now: emulator.now(),
      payments: [{ to: w.payee.address, assets: { lovelace } }], intentId: id, purpose: "p" })).tx.toCBOR();
  };
  const base = { privateKey: w.agent.privateKey, unit: g.unit, vault, network: "Custom" as const, slot: { zeroTime: lucid.slotToUnixTime(0), zeroSlot: 0, slotLength: lucid.slotToUnixTime(1) - lucid.slotToUnixTime(0) }, now: () => emulator.now() };

  it("follows the allowance as it is now: a payee the owners just approved is accepted without a restart", async () => {
    let payees = [] as typeof al.datum.destinations;
    const s = pairedSigner({ ...base, readDatum: async () => ({ ...al.datum, destinations: payees }), chain: undefined });
    const tx = await spend(3n * ADA, "INV-1");
    await expect(s.sign(tx)).rejects.toThrow(/^signer refused:/);
    payees = al.datum.destinations; // the owners' edit landed
    expect(await s.sign(tx)).toMatch(/^[0-9a-f]+$/);
  });
  it("a payment that can never land (its input went elsewhere) may be rebuilt and signed again", async () => {
    const dead: ChainQuery = { txExists: async () => false, spenderOf: async () => "ff".repeat(32), txInputs: async () => undefined, tipMs: async () => emulator.now(), metadata: async () => undefined } as unknown as ChainQuery;
    const s = pairedSigner({ ...base, readDatum: async () => al.datum, chain: dead });
    await s.sign(await spend(3n * ADA, "INV-2"));
    expect(await s.sign(await spend(4n * ADA, "INV-2"))).toMatch(/^[0-9a-f]+$/);
  });
});

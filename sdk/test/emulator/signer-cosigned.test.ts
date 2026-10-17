// sdk/test/emulator/signer-cosigned.test.ts
// Escalations live for hours (owners sign on their own machines); the agent's own spends
// for minutes. The signer needs a separate cap for each.
import { describe, expect, it } from "vitest";
import { buildOverLimitSpend } from "../../src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../src/core/chain.js";
import * as owner from "../../src/core/owner.js";
import { evaluate, type SignerPolicy } from "../../src/node/signer/policy.js";
import { emptyState } from "../../src/node/signer/state.js";
import { ADA, collateralOf, emulatorWorld, signAndSubmit } from "../helpers.js";

describe("signer TTL caps", async () => {
  const w = await emulatorWorld();
  const { lucid, emulator } = w;
  const HOUR = 3_600_000n;
  lucid.selectWallet.fromPrivateKey(w.a.privateKey);
  const created = await owner.createVault(lucid, { owners: [w.a.pkh, w.b.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  const vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [w.a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 300n * ADA }), [w.a]);
  const now = BigInt(emulator.now());
  const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault),
    { agent: w.agent.pkh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
      periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 100n * ADA } },
    [w.a.pkh, w.b.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) });
  await signAndSubmit(lucid, emulator, g.tx, [w.a, w.b]);
  const collateral = await collateralOf(lucid, w.agent);
  lucid.selectWallet.fromAddress(w.agent.address, [collateral]);
  const built = await buildOverLimitSpend({
    lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, g.unit), now: emulator.now(),
    payments: [{ to: w.payee.address, assets: { lovelace: 15n * ADA } }], intentId: "INV-7", purpose: "p", cosigners: [w.a.pkh, w.b.pkh], validityMs: 2 * 3_600_000,
  });
  const base: SignerPolicy = {
    agentKeyHash: w.agent.pkh, vaultAddress: vault.address, allowanceUnit: g.unit, destinations: [w.payee.address],
    maxTxPerHour: 10, maxPerDay: { lovelace: 100n * ADA }, maxTtlMs: 15 * 60_000, allowCoSigned: true,
    // The emulator keeps its own slot clock; the shared Custom config stays zeroed.
    slot: { zeroTime: lucid.slotToUnixTime(0), zeroSlot: 0, slotLength: lucid.slotToUnixTime(1) - lucid.slotToUnixTime(0) },
  };

  it("refuses a 2 h escalation under the agent's 15 min cap alone", () =>
    expect(evaluate(base, emptyState(), built.tx.toCBOR(), emulator.now())).toMatchObject({ ok: false, reason: expect.stringMatching(/ttl/) }));
  it("signs it under a co-signed cap of 3 h", () =>
    expect(evaluate({ ...base, maxCoSignedTtlMs: 3 * 3_600_000 }, emptyState(), built.tx.toCBOR(), emulator.now())).toMatchObject({ ok: true }));
  it("an escalation doesn't spend the agent's own daily budget or need its payee list: the owners authorize it", () => {
    const tight = { ...base, maxCoSignedTtlMs: 3 * 3_600_000, maxPerDay: { lovelace: 1n * ADA }, destinations: [] };
    expect(evaluate(tight, emptyState(), built.tx.toCBOR(), emulator.now())).toMatchObject({ ok: true, coSigned: true });
  });
});

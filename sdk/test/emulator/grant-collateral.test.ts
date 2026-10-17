import { describe, expect, it } from "vitest";
import { credentialToAddress } from "@lucid-evolution/lucid";
import { readConfig, treasuryUtxos } from "../../src/core/chain.js";
import * as owner from "../../src/core/owner.js";
import { ADA, emulatorWorld, signAndSubmit } from "../helpers.js";

describe("a grant that sends the agent its collateral", () => {
  it("pays the agent's key address in the same tx", async () => {
    const w = await emulatorWorld();
    const { lucid, emulator } = w;
    lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    const created = await owner.createVault(lucid, { owners: [w.a.pkh], threshold: 1n, paused: false, maxTxValidityMs: 3_600_000n, apps: [] });
    await signAndSubmit(lucid, emulator, created.tx, [w.a]);
    await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, created.vault, { lovelace: 100n * ADA }), [w.a]);
    const fresh = "ab".repeat(28); // a key with no ADA yet
    const now = BigInt(emulator.now());
    const g = await owner.grantAllowance(lucid, created.vault, await readConfig(lucid, created.vault),
      { agent: fresh, destinations: [w.payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
        periodMs: 86_400_000n, windowStart: now - 60_000n, expiresAt: now + 86_400_000n * 30n, maxFee: 2n * ADA, fund: { lovelace: 40n * ADA } },
      [w.a.pkh], { fromTreasury: await treasuryUtxos(lucid, created.vault), agentCollateral: 5n * ADA });
    await signAndSubmit(lucid, emulator, g.tx, [w.a]);
    const utxos = await lucid.utxosAt(credentialToAddress("Custom", { type: "Key", hash: fresh }));
    expect(utxos.map((u) => u.assets)).toEqual([{ lovelace: 5n * ADA }]);
  });
});

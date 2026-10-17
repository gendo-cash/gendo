// server/test/requests.test.ts — agent requests against real escalations from the emulator:
// the server accepts only a CoSignedSpend of the token's own allowance, signed by its agent key.
import { describe, expect, it } from "vitest";
import { Emulator, Lucid } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { buildOverLimitSpend } from "../../sdk/src/core/agent.js";
import { readAllowance, readConfig, treasuryUtxos } from "../../sdk/src/core/chain.js";
import { witness } from "../../sdk/src/core/cosign.js";
import * as owner from "../../sdk/src/core/owner.js";
import { ADA, collateralOf, party, signAndSubmit } from "../../sdk/test/helpers.js";
import { createApp } from "../src/app.js";
import { json, signIn, store } from "./helpers.js";

const HOUR = 3_600_000n;

describe("agent requests", async () => {
  const [a, b, agent, payee] = [party(2_000n * ADA), party(500n * ADA), party(10n * ADA), party(2n * ADA)];
  const emulator = new Emulator([a, b, agent, payee]);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(a.privateKey);
  const created = await owner.createVault(lucid, { owners: [a.pkh, b.pkh], threshold: 2n, paused: false, maxTxValidityMs: HOUR, apps: [] });
  const vault = created.vault;
  await signAndSubmit(lucid, emulator, created.tx, [a]);
  await signAndSubmit(lucid, emulator, await owner.fundTreasury(lucid, vault, { lovelace: 300n * ADA }), [a]);
  const grant = async () => {
    const now = BigInt(emulator.now());
    const g = await owner.grantAllowance(lucid, vault, await readConfig(lucid, vault),
      { agent: agent.pkh, destinations: [payee.address], caps: [{ policy: "", name: "", windowCap: 20n * ADA, txCap: 10n * ADA }],
        periodMs: 24n * HOUR, windowStart: now - 120_000n, expiresAt: now + 30n * 24n * HOUR, maxFee: 2n * ADA, fund: { lovelace: 60n * ADA } },
      [a.pkh, b.pkh], { fromTreasury: await treasuryUtxos(lucid, vault) });
    await signAndSubmit(lucid, emulator, g.tx, [a, b]);
    return g.unit;
  };
  const X = await grant();
  const Y = await grant();
  const escalate = async (unit: string) => {
    const collateral = await collateralOf(lucid, agent);
    lucid.selectWallet.fromAddress(agent.address, [collateral]);
    const built = await buildOverLimitSpend({
      lucid, vault, collateral, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit), now: emulator.now(),
      payments: [{ to: payee.address, assets: { lovelace: 15n * ADA } }], intentId: "INV-1", purpose: "hosting", cosigners: [a.pkh, b.pkh],
    });
    lucid.selectWallet.fromPrivateKey(a.privateKey);
    const cbor = built.tx.toCBOR();
    return { cbor, agentWitness: await witness(lucid, cbor, agent.privateKey) };
  };

  const app = createApp({
    store: store(),
    upstream: async () => new Response("{}", { status: 404 }),
    owners: async (p) => (p === vault.hash ? [a.pkh, b.pkh] : undefined),
    allowanceOf: async (p, unit) => {
      if (p !== vault.hash) return undefined;
      const al = await readAllowance(lucid, vault, unit);
      return { ref: `${al.utxo.txHash}#${al.utxo.outputIndex}`, agent: al.datum.agent };
    },
    submit: async () => ({ ok: true, hash: "h" }),
  });
  const ownerA = { sk: a.privateKey, pkh: a.pkh, addressHex: "" };
  const { CML } = await import("../../sdk/src/core/index.js");
  ownerA.addressHex = CML.Address.from_bech32(a.address).to_hex();
  const ha = json({ authorization: `Bearer ${(await (await signIn(app, ownerA)).json()).token}` });
  const tokenFor = async (unit: string) =>
    (await (await app.request(`/vaults/${vault.hash}/agents/${unit}/token`, { method: "POST", headers: ha, body: "{}" })).json()).token as string;
  const send = (token: string, body: object) =>
    app.request("/requests", { method: "POST", headers: json({ authorization: `Bearer ${token}` }), body: JSON.stringify({ intentId: "INV-1", purpose: "hosting", reason: "over the cap", ...body }) });

  it("accepts the agent's escalation of its own allowance, signed by its key", async () => {
    const r = await send(await tokenFor(X), await escalate(X));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ kind: "request", status: "open", signedBy: [agent.pkh] });
  });
  it("refuses a token for one allowance posting an escalation of another", async () => {
    expect((await send(await tokenFor(Y), await escalate(X))).status).toBe(403);
  });
  it("refuses an owner-only change posted as a request", async () => {
    const al = await readAllowance(lucid, vault, X);
    const edit = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, { ...al.datum, destinations: al.datum.destinations }, [a.pkh, b.pkh]);
    const cbor = edit.toCBOR();
    const r = await send(await tokenFor(X), { cbor, agentWitness: await witness(lucid, cbor, agent.privateKey) });
    expect(r.status).toBe(400);
  });
  it("refuses an owner-level edit posted by a compromised agent with a fresh key of its own", async () => {
    const fresh = party(0n);
    const al = await readAllowance(lucid, vault, X);
    const edit = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, { ...al.datum, destinations: al.datum.destinations }, [a.pkh, b.pkh, fresh.pkh]);
    const cbor = edit.toCBOR();
    const r = await send(await tokenFor(X), { cbor, agentWitness: await witness(lucid, cbor, fresh.privateKey) });
    expect(r.status).toBe(400);
  });
});

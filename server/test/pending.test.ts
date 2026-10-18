// server/test/pending.test.ts
import { describe, expect, it } from "vitest";
import { CML, Emulator, Lucid, generateEmulatorAccountFromPrivateKey } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { witness } from "../../sdk/src/core/cosign.js";
import { hexToUtf8 } from "../../sdk/src/core/bytes.js";
import { createApp } from "../src/app.js";
import { json, policy, signIn, store, vault, vaultId, wallet } from "./helpers.js";

// Real txs from the emulator: a payment to the vault that names owners as required signers.
async function world() {
  const accs = [0, 1, 2].map(() => generateEmulatorAccountFromPrivateKey({ lovelace: 100_000_000n }));
  const lucid = await Lucid(new Emulator(accs), "Custom");
  const [A, B, C] = accs.map((a) => {
    const pkh = CML.PrivateKey.from_bech32(a.privateKey).to_public().hash().to_hex();
    const addressHex = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address().to_hex();
    return { sk: a.privateKey, pkh, addressHex, address: a.address };
  });
  lucid.selectWallet.fromPrivateKey(A!.sk);
  const txFor = async (signers: string[], to = vault.address) => {
    // Like every owner tx the SDK builds, it carries a TTL.
    let b = lucid.newTx().pay.ToAddress(to, { lovelace: 2_000_000n }).validTo(lucid.slotToUnixTime(lucid.currentSlot()) + 600_000);
    for (const s of signers) b = b.addSignerKey(s);
    return (await b.complete()).toCBOR();
  };
  const wit = (cbor: string, k: { sk: string }) => witness(lucid, cbor, k.sk);
  return { A: A!, B: B!, C: C!, txFor, wit };
}
type Submit = { ok: true; hash: string } | { ok: false; error: string; transient?: boolean };

async function setup(opts: { submit?: (cbor: string) => Promise<Submit>; upstream?: (p: string) => Promise<Response>; now?: () => number; maxOpenPerVault?: number; perMinute?: number } = {}) {
  const w = await world();
  const db = store();
  const submitted: string[] = [];
  const app = createApp({
    store: db,
    now: opts.now,
    perMinute: opts.perMinute,
    maxOpenPerVault: opts.maxOpenPerVault,
    upstream: opts.upstream ?? (async () => new Response("{}", { status: 404 })),
    owners: async (p) => (p === policy ? [w.A.pkh, w.B.pkh, w.C.pkh] : undefined),
    allowanceOf: async () => undefined,
    submit: async (cbor) => (submitted.push(cbor), opts.submit ? opts.submit(cbor) : { ok: true, hash: "h" }),
  });
  const session = async (k: typeof w.A) => {
    const h = json({ authorization: `Bearer ${(await (await signIn(app, k)).json()).token}` });
    await app.request("/me/vaults", { method: "POST", headers: h, body: JSON.stringify({ vaultId }) });
    return h;
  };
  const post = (path: string, headers: Record<string, string>, body: unknown) => app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const propose = async (k: typeof w.A, cbor: string) => post(`/vaults/${policy}/pending`, await session(k), { cbor, witness: await w.wit(cbor, k), title: "t" });
  return { ...w, app, db, submitted, session, post, propose };
}

describe("pending inbox", () => {
  it("a proposal signed by every required signer at once is submitted straight away (single-owner pause)", async () => {
    const { A, txFor, propose, submitted } = await setup();
    const r = await propose(A, await txFor([A.pkh]));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "submitted", signedBy: [A.pkh], requiredSigners: [A.pkh] });
    expect(submitted).toHaveLength(1);
  });

  it("2 of 3: waits for the second owner, then submits once", async () => {
    const { A, B, txFor, wit, app, post, session, propose, submitted } = await setup();
    const cbor = await txFor([A.pkh, B.pkh]);
    const p = await (await propose(A, cbor)).json();
    expect(p).toMatchObject({ status: "open", signedBy: [A.pkh] });
    const inbox = await (await app.request("/me/pending", { headers: await session(B) })).json();
    expect(inbox.map((x: { id: string }) => x.id)).toContain(p.id);
    expect(await (await post(`/pending/${p.id}/witness`, await session(B), { witness: await wit(cbor, B) })).json()).toMatchObject({ status: "submitted", txHash: "h" });
    expect((await (await post(`/pending/${p.id}/witness`, await session(B), { witness: await wit(cbor, B) })).json()).status).toBe("submitted");
    expect(submitted).toHaveLength(1);
  });

  it("the last two signatures arriving together submit once", async () => {
    const { A, B, C, txFor, wit, post, session, propose, submitted } = await setup();
    const cbor = await txFor([A.pkh, B.pkh, C.pkh]);
    const p = await (await propose(A, cbor)).json();
    const [hb, hc] = [await session(B), await session(C)];
    await Promise.all([post(`/pending/${p.id}/witness`, hb, { witness: await wit(cbor, B) }), post(`/pending/${p.id}/witness`, hc, { witness: await wit(cbor, C) })]);
    expect(submitted).toHaveLength(1);
  });

  it("refuses a witness from an owner who isn't a required signer, and stores nothing", async () => {
    const { A, B, C, txFor, wit, app, post, session, propose } = await setup();
    const cbor = await txFor([A.pkh, B.pkh]);
    const p = await (await propose(A, cbor)).json();
    expect((await post(`/pending/${p.id}/witness`, await session(C), { witness: await wit(cbor, C) })).status).toBe(403);
    const row = (await (await app.request(`/vaults/${policy}/pending`, { headers: await session(A) })).json()).find((x: { id: string }) => x.id === p.id);
    expect(row.signedBy).toEqual([A.pkh]);
  });

  it("refuses a witness for another body, a non-owner signer, and a tx that doesn't touch the vault", async () => {
    const { A, B, C, txFor, wit, post, session } = await setup();
    const h = await session(A);
    const cbor = await txFor([A.pkh, B.pkh]);
    expect((await post(`/vaults/${policy}/pending`, h, { cbor, witness: await wit(await txFor([A.pkh, B.pkh, C.pkh]), A), title: "t" })).status).toBe(400);
    const bad = await txFor([A.pkh, wallet().pkh]);
    expect((await post(`/vaults/${policy}/pending`, h, { cbor: bad, witness: await wit(bad, A), title: "t" })).status).toBe(400);
    const elsewhere = await txFor([A.pkh], C.address);
    const r = await post(`/vaults/${policy}/pending`, h, { cbor: elsewhere, witness: await wit(elsewhere, A), title: "t" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/doesn't touch this vault/);
  });

  it("a rejected submit marks it failed with the node's reason and doesn't retry", async () => {
    const { A, txFor, wit, post, session, propose, submitted } = await setup({ submit: async () => ({ ok: false, error: "BadInputsUTxO" }) });
    const cbor = await txFor([A.pkh]);
    const p = await (await propose(A, cbor)).json();
    expect(p).toMatchObject({ status: "failed", error: "BadInputsUTxO" });
    expect((await post(`/pending/${p.id}/witness`, await session(A), { witness: await wit(cbor, A) })).status).toBe(409);
    expect(submitted).toHaveLength(1);
  });

  it("a rejected submit of a tx that is already on chain marks it landed", async () => {
    const { A, txFor, propose } = await setup({
      submit: async () => ({ ok: false, error: "already submitted" }),
      upstream: async (p) => new Response("{}", { status: p.startsWith("/txs/") ? 200 : 404 }),
    });
    expect(await (await propose(A, await txFor([A.pkh]))).json()).toMatchObject({ status: "landed" });
  });

  it("a transient submit error keeps it open and the next read retries", async () => {
    let fail = true;
    const { A, txFor, app, session, propose, submitted } = await setup({ submit: async () => (fail ? { ok: false, error: "503", transient: true } : { ok: true, hash: "h" }) });
    const p = await (await propose(A, await txFor([A.pkh]))).json();
    expect(p).toMatchObject({ status: "open", error: "503" });
    fail = false;
    const rows = await (await app.request(`/vaults/${policy}/pending`, { headers: await session(A) })).json();
    expect(rows.find((x: { id: string }) => x.id === p.id)).toMatchObject({ status: "submitted" });
    expect(submitted).toHaveLength(2);
  });

  it("never submits an expired tx", async () => {
    const { A, txFor, propose, submitted } = await setup({
      upstream: async (p) => (p === "/blocks/latest" ? new Response(JSON.stringify({ slot: 10 ** 12 })) : new Response("{}", { status: 404 })),
    });
    expect(await (await propose(A, await txFor([A.pkh]))).json()).toMatchObject({ status: "failed", error: expect.stringMatching(/expired/) });
    expect(submitted).toHaveLength(0);
  });

  it("a submitted tx that never landed fails once the chain is past its expiry, and not before", async () => {
    let tip = 0;
    const { A, txFor, app, session, propose } = await setup({
      upstream: async (p) => (p === "/blocks/latest" ? new Response(JSON.stringify({ slot: tip })) : new Response("{}", { status: 404 })),
    });
    const cbor = await txFor([A.pkh]);
    const ttl = Number(CML.Transaction.from_cbor_hex(cbor).body().ttl());
    expect(await (await propose(A, cbor)).json()).toMatchObject({ status: "submitted" });
    const read = async () => ((await (await app.request("/me/pending", { headers: await session(A) })).json()) as { status: string; error?: string }[])[0]!;
    tip = ttl + 30; // just past it: the indexer may still be catching up
    expect((await read()).status).toBe("submitted");
    tip = ttl + 1_000;
    expect(await read()).toMatchObject({ status: "failed", error: expect.stringMatching(/expired before it reached the chain/) });
  });

  it("a row stuck in submitting (a crash mid-submit) is resolved on the next read", async () => {
    let t = 1_000_000;
    let hang = true;
    const { A, txFor, app, db, session, propose } = await setup({ now: () => t, submit: async () => (hang ? new Promise<Submit>(() => {}) : { ok: true, hash: "h" }) });
    const cbor = await txFor([A.pkh]);
    void propose(A, cbor);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = db.pendingFor(policy);
    expect(row!.status).toBe("submitting");
    hang = false;
    t += 3 * 60_000;
    const rows = await (await app.request(`/vaults/${policy}/pending`, { headers: await session(A) })).json();
    expect(rows[0]).toMatchObject({ status: "submitted" });
  });
});

describe("your vaults", () => {
  it("the inbox shows only vaults you added, and adding needs you to be an owner", async () => {
    const { A, B, txFor, app, post, propose } = await setup();
    await propose(A, await txFor([A.pkh, B.pkh]));
    const hb = json({ authorization: `Bearer ${(await (await signIn(app, B)).json()).token}` });
    expect(await (await app.request("/me/pending", { headers: hb })).json()).toEqual([]);
    expect((await post("/me/vaults", hb, { vaultId })).status).toBe(200);
    expect(await (await app.request("/me/pending", { headers: hb })).json()).toHaveLength(1);
    expect(await (await app.request("/me/vaults", { headers: hb })).json()).toEqual([{ policy, vaultId, name: null, listed: false }]);
    const stranger = wallet();
    const hs = json({ authorization: `Bearer ${(await (await signIn(app, stranger)).json()).token}` });
    expect((await post("/me/vaults", hs, { vaultId })).status).toBe(403);
    expect((await post("/me/vaults", hb, { vaultId: "gendo:mainnet:x" })).status).toBe(400);
  });

  it("an owner names the vault and chooses whether it's listed", async () => {
    const { A, app, session } = await setup();
    const h = await session(A);
    expect((await app.request(`/vaults/${policy}/listing`, { method: "PUT", headers: h, body: JSON.stringify({ name: "Bounty Payouts", listed: true }) })).status).toBe(200);
    expect(await (await app.request(`/public/${policy}`)).json()).toMatchObject({ name: "Bounty Payouts", listed: true });
  });
});

describe("limits", () => {
  it("caps open proposals per vault", async () => {
    const { A, B, txFor, propose } = await setup({ maxOpenPerVault: 2 });
    for (let i = 0; i < 2; i++) expect((await propose(A, await txFor([A.pkh, B.pkh]))).status).toBe(200);
    expect((await propose(A, await txFor([A.pkh, B.pkh]))).status).toBe(429);
  });
  it("rate-limits each client across the API", async () => {
    const { A, app } = await setup({ perMinute: 3 });
    const hit = () => app.request("/auth/challenge", { method: "POST", headers: json(), body: JSON.stringify({ address: A.addressHex }) });
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
  it("malformed JSON is a 400, not a crash", async () => {
    const { app } = await setup();
    expect((await app.request("/auth/challenge", { method: "POST", headers: json(), body: "{" })).status).toBe(400);
  });
  it("the sign-in message names the site and when it expires", async () => {
    const { A, app } = await setup();
    const ch = await (await app.request("http://app.gendo.test/auth/challenge", { method: "POST", headers: json(), body: JSON.stringify({ address: A.addressHex }) })).json();
    expect(hexToUtf8(ch.payload)).toMatch(/^Sign in to gendo\nsite: app\.gendo\.test\nnonce: [0-9a-f]{32}\nexpires: \d{4}-/);
  });
});

describe("agent tokens and names", () => {
  it("rotating a token kills the old one; a bad token gets 401", async () => {
    const { A, post, session } = await setup();
    const unitX = policy + "11".repeat(28);
    const t1 = (await (await post(`/vaults/${policy}/agents/${unitX}/token`, await session(A), {})).json()).token;
    expect(t1).toMatch(/^gnd_[0-9a-f]{64}$/);
    await post(`/vaults/${policy}/agents/${unitX}/token`, await session(A), {});
    expect((await post("/requests", json({ authorization: `Bearer ${t1}` }), { cbor: "00", agentWitness: "00", intentId: "I", purpose: "p", reason: "r" })).status).toBe(401);
  });
  it("owners name agents; the public listing shows the names", async () => {
    const { B, app, db, session } = await setup();
    db.put({ policy, name: "Acme payouts", listed: true });
    const unitX = policy + "11".repeat(28);
    expect((await app.request(`/vaults/${policy}/agents/${unitX}/label`, { method: "PUT", headers: await session(B), body: JSON.stringify({ name: "payout-bot" }) })).status).toBe(200);
    expect((await (await app.request(`/public/${policy}`)).json()).agents).toEqual({ [unitX]: "payout-bot" });
  });
});

describe("vaults from before apps", () => {
  it("an owner can add one by its id: the same id derives it with the old code", async () => {
    const { makeVaultV1 } = await import("../../sdk/src/core/legacy.js");
    const { parseVaultId } = await import("../../sdk/src/core/vault.js");
    const w = await world();
    const old = makeVaultV1(parseVaultId(vaultId).network, parseVaultId(vaultId).seed).hash;
    const app = createApp({
      store: store(),
      upstream: async () => new Response("{}", { status: 404 }),
      owners: async (p: string) => (p === old ? [w.A.pkh] : undefined),
      allowanceOf: async () => undefined,
      submit: async () => ({ ok: true, hash: "h" }),
    } as never);
    const h = json({ authorization: `Bearer ${(await (await signIn(app, w.A)).json()).token}` });
    const r = await app.request("/me/vaults", { method: "POST", headers: h, body: JSON.stringify({ vaultId }) });
    expect(await r.json()).toEqual({ policy: old, vaultId });
    expect(await (await app.request("/me/vaults", { headers: h })).json()).toEqual([{ policy: old, vaultId, name: null, listed: false }]);
  });
});

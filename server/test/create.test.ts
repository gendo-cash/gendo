// server/test/create.test.ts
// Creating a vault through the server: only a real creation naming the signed-in owner,
// registered once it lands, and offered (never forced) to the other owners.
import { describe, expect, it } from "vitest";
import { CML, Emulator, Lucid, generateEmulatorAccountFromPrivateKey } from "../../sdk/node_modules/@lucid-evolution/lucid/dist/index.js";
import { witness } from "../../sdk/src/core/cosign.js";
import { owner, refHolderAddress } from "../../sdk/src/core/index.js";
import { createApp } from "../src/app.js";
import { json, policy as knownPolicy, signIn, store, vaultId as knownVaultId } from "./helpers.js";

type Submit = { ok: true; hash: string } | { ok: false; error: string; transient?: boolean };

async function setup(o: { submit?: (cbor: string) => Promise<Submit>; landed?: () => boolean } = {}) {
  const accs = [0, 1, 2].map(() => generateEmulatorAccountFromPrivateKey({ lovelace: 200_000_000n }));
  const lucid = await Lucid(new Emulator(accs), "Custom");
  const [A, B, C] = accs.map((a) => {
    const pkh = CML.PrivateKey.from_bech32(a.privateKey).to_public().hash().to_hex();
    const addressHex = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(pkh))).to_address().to_hex();
    return { sk: a.privateKey, pkh, addressHex };
  });
  lucid.selectWallet.fromPrivateKey(A!.sk);
  const owners = new Map<string, string[]>();
  const db = store();
  const app = createApp({
    store: db, network: "Custom",
    upstream: async (p) => (p.startsWith("/txs/") && o.landed?.() ? new Response("{}", { status: 200 }) : new Response("{}", { status: 404 })),
    owners: async (p) => owners.get(p),
    allowanceOf: async () => undefined,
    submit: o.submit ?? (async () => ({ ok: true as const, hash: "h" })),
  });
  const session = async (k: typeof A) => ((await (await signIn(app, k!)).json()) as { token: string }).token;
  const call = async (method: string, path: string, token: string, body?: unknown) =>
    app.request(path, { method, headers: json({ authorization: `Bearer ${token}` }), ...(body ? { body: JSON.stringify(body) } : {}) });
  const create = async (ownersOf: string[], signer = A!.pkh, by = A!) => {
    const { tx, vault } = await owner.createVault(lucid, { owners: ownersOf, threshold: 1n, paused: false, maxTxValidityMs: 120_000n, apps: [] },
      { refScriptAddress: refHolderAddress("Custom"), fund: 5_000_000n, signer });
    const cbor = tx.toCBOR();
    return { cbor, vault, wit: await witness(lucid, cbor, by.sk) };
  };
  return { A: A!, B: B!, C: C!, app, db, owners, session, call, create };
}

describe("POST /vaults", () => {
  it("submits a creation by its owner and registers it once it has landed", async () => {
    let landed = false;
    const s = await setup({ landed: () => landed });
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh, s.B.pkh]);
    const r = await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Team" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { pending: { status: string; kind: string }; vaultId: string; policy: string };
    expect(j).toMatchObject({ policy: c.vault.hash, pending: { status: "submitted", kind: "create" } });
    expect(j.vaultId).toMatch(/^gendo:custom:[0-9a-f]{64}#\d+:[0-9a-f]{64}#\d+$/);
    expect(await (await s.call("GET", "/me/vaults", a)).json()).toEqual([]); // not before it lands
    landed = true;
    await s.call("GET", "/me/pending", a);
    expect(await (await s.call("GET", "/me/vaults", a)).json()).toEqual([{ policy: c.vault.hash, vaultId: j.vaultId, name: "Team", listed: false }]);
  });
  it("registers on the first inbox read after landing, whoever asks", async () => {
    let landed = false;
    const s = await setup({ landed: () => landed });
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh]);
    await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Solo" });
    landed = true;
    // A fresh session (the creator closed the tab and came back) sees it after one inbox read.
    const again = await s.session(s.A);
    await s.call("GET", "/me/pending", again);
    expect(((await (await s.call("GET", "/me/vaults", again)).json()) as unknown[]).length).toBe(1);
  });
  it("a creator who comes back sees the vault without opening the inbox", async () => {
    let landed = false;
    const s = await setup({ landed: () => landed });
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh]);
    await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Solo" });
    landed = true;
    const again = await s.session(s.A);
    expect(((await (await s.call("GET", "/me/vaults", again)).json()) as unknown[]).length).toBe(1);
  });
  it("a failed creation registers nothing", async () => {
    const s = await setup({ submit: async () => ({ ok: false, error: "BadInputsUTxO" }) });
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh]);
    const j = (await (await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "X" })).json()) as { pending: { status: string; error: string } };
    expect(j.pending).toMatchObject({ status: "failed", error: "BadInputsUTxO" });
    await s.call("GET", "/me/pending", a);
    expect(await (await s.call("GET", "/me/vaults", a)).json()).toEqual([]);
  });
  it("refuses a creation that doesn't name the signed-in owner", async () => {
    const s = await setup();
    const b = await s.session(s.B);
    const c = await s.create([s.A.pkh], s.B.pkh, s.B); // B signs a creation that names only A as owner
    const r = await s.call("POST", "/vaults", b, { cbor: c.cbor, witness: c.wit, name: "X" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/one of its owners/);
  });
  it("refuses a creation whose required signer isn't the signed-in owner", async () => {
    const s = await setup();
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh, s.B.pkh], s.B.pkh);
    expect((await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "X" })).status).toBe(400);
  });
  it("refuses a tx that isn't a creation, and a missing name", async () => {
    const s = await setup();
    const a = await s.session(s.A);
    const c = await s.create([s.A.pkh]);
    expect((await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: " " })).status).toBe(400);
    expect((await s.call("POST", "/vaults", a, { cbor: "84a0a0f5f6", witness: c.wit, name: "X" })).status).toBe(400);
  });
  it("needs a session", async () => {
    const s = await setup();
    expect((await s.app.request("/vaults", { method: "POST", headers: json(), body: "{}" })).status).toBe(401);
  });
});

describe("GET /me/suggested-vaults", () => {
  it("offers a known vault to an owner who hasn't added it, until they add it", async () => {
    const s = await setup({ landed: () => true });
    const a = await s.session(s.A);
    const b = await s.session(s.B);
    const c = await s.create([s.A.pkh, s.B.pkh]);
    const { vaultId } = (await (await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Team" })).json()) as { vaultId: string };
    await s.call("GET", "/me/pending", a); // landed: registered for A
    s.owners.set(c.vault.hash, [s.A.pkh, s.B.pkh]);
    expect(await (await s.call("GET", "/me/suggested-vaults", b)).json()).toEqual([{ policy: c.vault.hash, vaultId, name: "Team" }]);
    expect(await (await s.call("GET", "/me/suggested-vaults", await s.session(s.C))).json()).toEqual([]);
    expect(await (await s.call("GET", "/me/suggested-vaults", a)).json()).toEqual([]); // already added
    await s.call("POST", "/me/vaults", b, { vaultId });
    expect(await (await s.call("GET", "/me/suggested-vaults", b)).json()).toEqual([]);
  });
  it("a co-owner sees an app-created vault as soon as it's on chain, before the creator comes back", async () => {
    const s = await setup();
    const a = await s.session(s.A);
    const b = await s.session(s.B);
    const c = await s.create([s.A.pkh, s.B.pkh]);
    const { vaultId } = (await (await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Team" })).json()) as { vaultId: string };
    expect(await (await s.call("GET", "/me/suggested-vaults", b)).json()).toEqual([]); // not on chain yet
    s.owners.set(c.vault.hash, [s.A.pkh, s.B.pkh]);
    expect(await (await s.call("GET", "/me/suggested-vaults", b)).json()).toEqual([{ policy: c.vault.hash, vaultId, name: "Team" }]);
    s.owners.set(c.vault.hash, [s.A.pkh]); // the owners changed on chain: B isn't one anymore
    expect(await (await s.call("GET", "/me/suggested-vaults", b)).json()).toEqual([]);
  });
  it("a vault added by id is suggested to its other owners", async () => {
    const s = await setup();
    s.owners.set(knownPolicy, [s.A.pkh, s.B.pkh]);
    await s.call("POST", "/me/vaults", await s.session(s.A), { vaultId: knownVaultId });
    expect(await (await s.call("GET", "/me/suggested-vaults", await s.session(s.B))).json()).toEqual([{ policy: knownPolicy, vaultId: knownVaultId, name: null }]);
  });
  it("the creation stays out of the other owner's inbox (the opt-in inbox is pinned in pending.test.ts)", async () => {
    const s = await setup({ landed: () => true });
    const a = await s.session(s.A);
    const b = await s.session(s.B);
    const c = await s.create([s.A.pkh, s.B.pkh]);
    await s.call("POST", "/vaults", a, { cbor: c.cbor, witness: c.wit, name: "Team" });
    await s.call("GET", "/me/pending", a);
    expect(await (await s.call("GET", "/me/pending", b)).json()).toEqual([]);
  });
  it("needs a session", async () => {
    const s = await setup();
    expect((await s.app.request("/me/suggested-vaults")).status).toBe(401);
  });
});

describe("your vaults' order", () => {
  it("newest added first, and re-adding one doesn't move it", () => {
    const db = store();
    const pol = (c: string) => c.repeat(56);
    for (const c of ["c", "a", "b"]) db.addUserVault("me", pol(c), `id-${c}`);
    db.addUserVault("me", pol("c"), "id-c2");
    expect(db.userVaults("me").map((v) => v.vaultId)).toEqual(["id-b", "id-a", "id-c2"]);
  });
});

// server/src/pending.ts
// The inbox. The server stores proposals and owners' witnesses, checks every signature
// against the exact body, and broadcasts once all required signers have signed. It
// never decides what a tx does: each owner's browser recomputes that from the chain.
import { appFor } from "../../sdk/src/core/apps/catalogue.js";
import { minswapAdapter } from "../../sdk/src/core/apps/minswap/adapter.js";
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { CML, creationOf, formatVaultId, makeVault, makeVaultV1, parseVaultId, type Network } from "../../sdk/src/core/index.js";
import { describeTx } from "../../sdk/src/core/cosign.js";
import { bodyHash, requiredSignersOf, verifiedSigners, withWitnesses } from "../../sdk/src/core/witnesses.js";
import { sha256, type mountAuth } from "./auth.js";
import type { PendingRow, openStore } from "./store.js";

export type PendingView = {
  id: string; policy: string; kind: "proposal" | "request" | "create"; title: string; cbor: string; recipe: unknown;
  requiredSigners: string[]; signedBy: string[]; status: "open" | "submitting" | "submitted" | "landed" | "failed";
  txHash?: string; error?: string; createdBy: string; createdAt: number;
};
export type SubmitResult = { ok: true; hash: string } | { ok: false; error: string; transient?: boolean };
type Deps = {
  store: ReturnType<typeof openStore>;
  now: () => number;
  owners: (policy: string) => Promise<string[] | undefined>;
  submit: (txCbor: string) => Promise<SubmitResult>;
  upstream: (pathAndQuery: string) => Promise<Response>;
  /** The allowance's current UTxO (`txHash#index`) and agent key, read from the chain. */
  allowanceOf: (policy: string, unit: string) => Promise<{ ref: string; agent: string } | undefined>;
  network?: string;
  maxOpenPerVault: number;
  maxOpenPerKey: number;
};
type Auth = ReturnType<typeof mountAuth>;

const MAX_ATTEMPTS = 5;
/** Slots past a tx's expiry before "not on chain" is final: the indexer can trail the tip. */
const SETTLE_SLOTS = 120;
const STUCK_MS = 2 * 60_000;
const isHex = (s: unknown, max: number): s is string => typeof s === "string" && s.length <= max && /^[0-9a-f]+$/.test(s) && s.length % 2 === 0;
const isPolicy = (s: string) => /^[0-9a-f]{56}$/.test(s);

/** Does the tx create a UTxO at the vault's script, or mint/burn its tokens? */
function touchesVault(txCbor: string, policy: string): boolean {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  for (let i = 0; i < body.outputs().len(); i++)
    if (body.outputs().get(i).address().payment_cred()?.as_script()?.to_hex() === policy) return true;
  const mp = body.mint()?.keys();
  for (let i = 0; mp && i < mp.len(); i++) if (mp.get(i).to_hex() === policy) return true;
  // A move out of an old vault pays nothing back to it and may burn nothing: it carries the vault's script.
  const scripts = CML.Transaction.from_cbor_hex(txCbor).witness_set().plutus_v3_scripts();
  for (let i = 0; scripts && i < scripts.len(); i++) if (scripts.get(i).hash().to_hex() === policy) return true;
  return false;
}

/** An escalation spends exactly its allowance's current UTxO with CoSignedSpend, and nothing else. */
function escalationProblem(txCbor: string, policy: string, allowanceRef: string): string | undefined {
  const body = CML.Transaction.from_cbor_hex(txCbor).body();
  if (body.inputs().len() !== 1) return "an escalation spends exactly one input, its allowance";
  const i = body.inputs().get(0);
  if (`${i.transaction_id().to_hex()}#${i.index()}` !== allowanceRef) return "this tx doesn't spend your allowance's current UTxO";
  if (body.mint() || body.withdrawals() || body.certs() || body.voting_procedures() || body.proposal_procedures())
    return "an escalation may not mint, withdraw, certify or vote";
  const scriptAddr = CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(policy))).to_address().to_bech32();
  const kind = describeTx(txCbor, { vault: { hash: policy }, inputAddresses: { [allowanceRef]: scriptAddr } }).vaultSpends[allowanceRef];
  return kind === "CoSignedSpend" ? undefined : "an escalation must use the CoSignedSpend redeemer";
}

/**
 * An agent's own tx, the only kind the submit relay sends: its allowance's current UTxO, alone, signed by its key,
 * either a payment (AgentSpend, no withdrawal) or a trade (AgentTrade, exactly one zero withdrawal from this
 * network's app adapter). The chain checks everything else.
 */
export function agentTxProblem(txCbor: string, policy: string, allowanceRef: string, agent: string, network: Network): string | undefined {
  try {
    const body = CML.Transaction.from_cbor_hex(txCbor).body();
    if (body.inputs().len() !== 1) return "an agent spend has exactly one input, its allowance";
    const i = body.inputs().get(0);
    if (`${i.transaction_id().to_hex()}#${i.index()}` !== allowanceRef) return "this tx doesn't spend your allowance's current UTxO";
    const scriptAddr = CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(policy))).to_address().to_bech32();
    const kind = describeTx(txCbor, { vault: { hash: policy }, inputAddresses: { [allowanceRef]: scriptAddr } }).vaultSpends[allowanceRef];
    const wd = body.withdrawals();
    if (kind === "AgentSpend") {
      if (wd) return "a payment doesn't withdraw";
    } else if (kind === "AgentTrade") {
      const keys = wd?.keys();
      const adapter = appFor("minswap", network) ? minswapAdapter(network).rewardAddress : undefined;
      if (!wd || !keys || keys.len() !== 1 || wd.get(keys.get(0)) !== 0n || keys.get(0).to_address().to_bech32() !== adapter)
        return "a trade withdraws exactly zero, from this network's app adapter";
    } else return "only an ordinary agent spend or trade goes through here; escalations go to the owners' inbox";
    if (!requiredSignersOf(txCbor).includes(agent)) return "the agent key must sign";
    return undefined;
  } catch (e) {
    return `not a transaction: ${(e as Error).message}`;
  }
}

/** A fresh request token for an allowance (the previous one stops working). */
export function newAgentToken(store: ReturnType<typeof openStore>, policy: string, unit: string, now: number): string {
  const token = "gnd_" + randomBytes(32).toString("hex");
  store.rotateAgentToken(sha256(token), policy, unit, now);
  return token;
}

const ttlSlotOf = (txCbor: string) => {
  const t = CML.Transaction.from_cbor_hex(txCbor).body().ttl();
  return t === undefined ? undefined : Number(t);
};

export function mountPending(app: Hono, d: Deps, auth: Auth) {
  const view = (r: PendingRow): PendingView => ({
    id: r.id, policy: r.policy, kind: r.kind as PendingView["kind"], title: r.title, cbor: r.cbor, recipe: r.recipe ? JSON.parse(r.recipe) : null,
    requiredSigners: JSON.parse(r.required), signedBy: d.store.witnessesOf(r.id).map((w) => w.key_hash),
    status: r.status as PendingView["status"], ...(r.tx_hash ? { txHash: r.tx_hash } : {}), ...(r.error ? { error: r.error } : {}),
    createdBy: r.created_by, createdAt: r.created_at,
  });
  const onChain = async (hash: string) => {
    try {
      return (await d.upstream(`/txs/${hash}`)).status === 200;
    } catch {
      return false;
    }
  };
  const tipSlot = async () => {
    try {
      const r = await d.upstream("/blocks/latest");
      const slot = r.ok ? ((await r.json()) as { slot?: unknown }).slot : undefined;
      return typeof slot === "number" ? slot : undefined;
    } catch {
      return undefined;
    }
  };
  const allSigned = (r: PendingRow) => {
    const ws = d.store.witnessesOf(r.id);
    return (JSON.parse(r.required) as string[]).every((k) => ws.some((w) => w.key_hash === k));
  };
  /** Broadcast a row this caller moved to `submitting`; never an expired tx, never twice. */
  const submit = async (r: PendingRow) => {
    const ttl = ttlSlotOf(r.cbor);
    const tip = await tipSlot();
    if (ttl !== undefined && tip !== undefined && tip >= ttl)
      return void d.store.setStatus(r.id, "submitting", "failed", d.now(), { error: `expired at slot ${ttl}; build it again` });
    const res = await d.submit(withWitnesses(r.cbor, [...new Set(d.store.witnessesOf(r.id).map((w) => w.witness))]));
    if (res.ok) return void d.store.setStatus(r.id, "submitting", "submitted", d.now(), { txHash: res.hash });
    if (await onChain(r.body_hash)) return void d.store.setStatus(r.id, "submitting", "landed", d.now(), { txHash: r.body_hash });
    if (res.transient && r.attempts + 1 < MAX_ATTEMPTS) return void d.store.setStatus(r.id, "submitting", "open", d.now(), { error: res.error });
    d.store.setStatus(r.id, "submitting", "failed", d.now(), { error: res.error });
  };
  const trySubmit = async (r: PendingRow) => {
    if (allSigned(r) && r.attempts < MAX_ATTEMPTS && d.store.setStatus(r.id, "open", "submitting", d.now(), { error: r.error })) await submit(r);
  };
  /** A creation that landed: the creator's list and the vault's name (kept if an owner renamed it since). */
  const register = (r: PendingRow) => {
    const { vaultId, name } = JSON.parse(r.recipe!) as { vaultId: string; name: string };
    d.store.addUserVault(r.created_by, r.policy, vaultId);
    if (!d.store.get(r.policy)) d.store.put({ policy: r.policy, name, listed: false });
  };
  /** Bring a row up to date: landed, a stuck submit, a retry after a transient error. */
  const refresh = async (r: PendingRow) => {
    if (r.status === "submitted" && r.tx_hash) {
      if (await onChain(r.tx_hash)) d.store.setStatus(r.id, "submitted", "landed", d.now());
      else {
        // Dropped on the way (a node restart, a full mempool): once it's past its expiry it can never land.
        const ttl = ttlSlotOf(r.cbor);
        const tip = ttl === undefined ? undefined : await tipSlot();
        if (ttl !== undefined && tip !== undefined && tip > ttl + SETTLE_SLOTS)
          d.store.setStatus(r.id, "submitted", "failed", d.now(), { error: "it expired before it reached the chain; build it again" });
      }
    }
    if (r.status === "submitting" && d.now() - r.updated_at > STUCK_MS) {
      if (await onChain(r.body_hash)) d.store.setStatus(r.id, "submitting", "landed", d.now(), { txHash: r.body_hash });
      else d.store.setStatus(r.id, "submitting", "open", d.now(), { error: "the last submit didn't finish; retrying" });
    }
    const now = d.store.getPending(r.id)!;
    if (now.status === "open") await trySubmit(now);
    const latest = d.store.getPending(r.id)!;
    if (latest.kind === "create" && latest.status === "landed") register(latest);
    return view(latest);
  };
  /** Store each valid signature by a required signer; submit once everyone has signed. */
  const addWitness = async (r: PendingRow, witness: string) => {
    const required: string[] = JSON.parse(r.required);
    for (const k of verifiedSigners(r.cbor, witness)) if (required.includes(k)) d.store.putWitness(r.id, k, witness);
    await trySubmit(d.store.getPending(r.id)!);
    return view(d.store.getPending(r.id)!);
  };
  const insert = (row: Omit<Parameters<Deps["store"]["insertPending"]>[0], "id" | "createdAt" | "bodyHash">) => {
    const id = randomBytes(12).toString("hex");
    d.store.insertPending({ ...row, id, createdAt: d.now(), bodyHash: bodyHash(row.cbor) });
    return d.store.getPending(id)!;
  };
  const full = (c: Context, policy: string, by: string) =>
    d.store.openCount(policy) >= d.maxOpenPerVault || d.store.openBy(by) >= d.maxOpenPerKey
      ? c.json({ error: "too many open proposals; sign or let some expire first" }, 429)
      : undefined;

  app.post("/vaults/:policy/pending", async (c) => {
    const policy = c.req.param("policy");
    if (!isPolicy(policy)) return c.json({ error: "bad vault id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    const { cbor, witness, title, recipe } = await c.req.json<{ cbor?: unknown; witness?: unknown; title?: unknown; recipe?: unknown }>();
    if (!isHex(cbor, 64_000) || !isHex(witness, 4_000) || typeof title !== "string" || title.length > 200 || JSON.stringify(recipe ?? null).length > 8_000)
      return c.json({ error: "cbor, witness and title are required" }, 400);
    let required: string[];
    try {
      required = requiredSignersOf(cbor);
      if (!verifiedSigners(cbor, witness).includes(who)) return c.json({ error: "the witness isn't your signature over this tx" }, 400);
      if (!touchesVault(cbor, policy)) return c.json({ error: "this tx doesn't touch this vault" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const owners = (await d.owners(policy)) ?? [];
    if (!required.length || !required.every((k) => owners.includes(k))) return c.json({ error: "every required signer must be an owner of this vault" }, 400);
    if (!required.includes(who)) return c.json({ error: "you must be one of the tx's required signers" }, 400);
    const busy = full(c, policy, who);
    if (busy) return busy;
    const row = insert({ policy, kind: "proposal", title, cbor, recipe: recipe ?? null, required, createdBy: who });
    return c.json(await addWitness(row, witness));
  });

  app.get("/vaults/:policy/pending", async (c) => {
    const policy = c.req.param("policy");
    if (!isPolicy(policy)) return c.json({ error: "bad vault id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    return c.json(await Promise.all(d.store.pendingFor(policy).map(refresh)));
  });

  app.get("/me/pending", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const mine = d.store.pendingForSigner(who).filter((r) => (JSON.parse(r.required) as string[]).includes(who));
    return c.json(await Promise.all(mine.map(refresh)));
  });

  app.post("/pending/:id/witness", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const r = d.store.getPending(c.req.param("id"));
    if (!r) return c.json({ error: "no such proposal" }, 404);
    if (!(JSON.parse(r.required) as string[]).includes(who)) return c.json({ error: "you aren't a required signer of this tx" }, 403);
    if (r.status === "failed") return c.json({ error: `this tx failed: ${r.error}` }, 409);
    if (r.status !== "open") return c.json(view(r));
    const { witness } = await c.req.json<{ witness?: unknown }>();
    if (!isHex(witness, 4_000)) return c.json({ error: "witness required" }, 400);
    try {
      if (!verifiedSigners(r.cbor, witness).includes(who)) return c.json({ error: "the witness isn't your signature over this tx" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json(await addWitness(r, witness));
  });

  // --- creating a vault -------------------------------------------------------

  app.post("/vaults", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const { cbor, witness, name } = await c.req.json<{ cbor?: unknown; witness?: unknown; name?: unknown }>();
    if (!isHex(cbor, 64_000) || !isHex(witness, 4_000) || typeof name !== "string" || !name.trim() || name.length > 80)
      return c.json({ error: "cbor, witness and a name (1 to 80 characters) are required" }, 400);
    let made: ReturnType<typeof creationOf>;
    try {
      // The cheap checks first: only a signed-in owner's own signed tx gets the costlier creation check.
      const req = requiredSignersOf(cbor);
      if (req.length !== 1 || req[0] !== who) return c.json({ error: "the creation must name you, and only you, as its signer" }, 400);
      if (!verifiedSigners(cbor, witness).includes(who)) return c.json({ error: "the witness isn't your signature over this tx" }, 400);
      made = creationOf(cbor, (d.network ?? "Preprod") as "Preprod" | "Custom");
      if (!made.config.owners.includes(who)) return c.json({ error: "you must be one of its owners" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const policy = made.vault.hash;
    const busy = full(c, policy, who);
    if (busy) return busy;
    const vaultId = formatVaultId(made.id);
    const row = insert({ policy, kind: "create", title: `Create ${name.trim()}`, cbor, recipe: { vaultId, name: name.trim() }, required: [who], createdBy: who });
    for (const k of made.config.owners) if (k !== who) d.store.suggest(k, policy, vaultId, name.trim());
    return c.json({ pending: await addWitness(row, witness), vaultId, policy });
  });

  // --- your vaults ------------------------------------------------------------

  app.post("/me/vaults", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    const { vaultId } = await c.req.json<{ vaultId?: unknown }>();
    let policy: string;
    try {
      if (typeof vaultId !== "string" || vaultId.length > 200) throw new Error("vaultId required");
      const id = parseVaultId(vaultId);
      if (d.network && id.network !== d.network) throw new Error(`this app runs on ${d.network}; that vault is on ${id.network}`);
      policy = makeVault(id.network, id.seed).hash;
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    let owners = await d.owners(policy);
    // A vault from before apps: the same id derives it with the old code (its owners can still move it).
    if (!owners) {
      const id = parseVaultId(vaultId as string);
      const old = makeVaultV1(id.network, id.seed).hash;
      const oldOwners = await d.owners(old);
      if (oldOwners) [policy, owners] = [old, oldOwners];
    }
    if (!owners) return c.json({ error: "no vault with that id on chain" }, 404);
    if (!owners.includes(who)) return c.json({ error: "you aren't an owner of that vault" }, 403);
    d.store.addUserVault(who, policy, vaultId.trim());
    for (const k of owners) if (k !== who) d.store.suggest(k, policy, vaultId.trim(), d.store.get(policy)?.name ?? null);
    return c.json({ policy, vaultId: vaultId.trim() });
  });

  app.get("/me/vaults", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    // A creator who left before their vault landed finds it here when they come back.
    await Promise.all(d.store.unfinishedCreates(who).map(refresh));
    return c.json(
      d.store.userVaults(who).map((v) => {
        const l = d.store.get(v.policy);
        return { policy: v.policy, vaultId: v.vaultId, name: l?.name ?? null, listed: l?.listed ?? false };
      }),
    );
  });

  /** Vaults whose owners on chain include you, created or added here by another owner, that you haven't added. Adding stays your choice. */
  app.get("/me/suggested-vaults", async (c) => {
    const who = auth.sessionPkh(c);
    if (!who) return c.json({ error: "sign in first" }, 401);
    // Only vaults noted for you (bounded), each re-checked against its owners on chain.
    const out: { policy: string; vaultId: string; name: string | null }[] = [];
    for (const v of d.store.suggestionsFor(who)) {
      const owners = await d.owners(v.policy).catch(() => undefined);
      if (owners?.includes(who)) out.push({ policy: v.policy, vaultId: v.vaultId, name: d.store.get(v.policy)?.name ?? v.name });
      if (out.length >= 20) break;
    }
    return c.json(out);
  });

  app.put("/vaults/:policy/listing", async (c) => {
    const policy = c.req.param("policy");
    if (!isPolicy(policy)) return c.json({ error: "bad vault id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    const { name, listed } = await c.req.json<{ name?: unknown; listed?: unknown }>();
    if (typeof name !== "string" || !name.trim() || name.length > 80 || typeof listed !== "boolean") return c.json({ error: "name (1 to 80 characters) and listed are required" }, 400);
    d.store.put({ policy, name: name.trim(), listed });
    return c.json({ policy, name: name.trim(), listed });
  });

  // --- agents -----------------------------------------------------------------

  const unitOk = (policy: string, unit: string) => isPolicy(policy) && unit.startsWith(policy) && /^[0-9a-f]{58,120}$/.test(unit);

  app.post("/vaults/:policy/agents/:unit/token", async (c) => {
    const { policy, unit } = c.req.param() as { policy: string; unit: string };
    if (!unitOk(policy, unit)) return c.json({ error: "bad allowance id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    return c.json({ token: newAgentToken(d.store, policy, unit, d.now()) });
  });

  app.put("/vaults/:policy/agents/:unit/label", async (c) => {
    const { policy, unit } = c.req.param() as { policy: string; unit: string };
    if (!unitOk(policy, unit)) return c.json({ error: "bad allowance id" }, 400);
    const who = await auth.ownerOf(c, policy);
    if (typeof who !== "string") return who;
    const { name } = await c.req.json<{ name?: unknown }>();
    if (typeof name !== "string" || !name.trim() || name.length > 60) return c.json({ error: "name: 1 to 60 characters" }, 400);
    d.store.putLabel(policy, unit, name.trim());
    return c.json({ unit, name: name.trim() });
  });

  app.post("/requests", async (c) => {
    const m = /^Bearer (gnd_[0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "");
    const agent = m ? d.store.agentOfToken(sha256(m[1]!)) : undefined;
    if (!agent) return c.json({ error: "bad agent token" }, 401);
    const { cbor, agentWitness, intentId, purpose, reason } = await c.req.json<Record<string, unknown>>();
    if (!isHex(cbor, 64_000) || !isHex(agentWitness, 4_000) || typeof intentId !== "string" || intentId.length > 120 || typeof purpose !== "string" || typeof reason !== "string")
      return c.json({ error: "cbor, agentWitness, intentId, purpose and reason are required" }, 400);
    const allowance = await d.allowanceOf(agent.policy, agent.unit);
    if (!allowance) return c.json({ error: "this token's allowance isn't on chain any more" }, 403);
    let required: string[];
    let agentKeys: string[];
    try {
      const problem = escalationProblem(cbor, agent.policy, allowance.ref);
      if (problem) return c.json({ error: problem }, problem.includes("your allowance") ? 403 : 400);
      required = requiredSignersOf(cbor);
      agentKeys = verifiedSigners(cbor, agentWitness);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const owners = (await d.owners(agent.policy)) ?? [];
    const others = required.filter((k) => !owners.includes(k));
    if (!required.some((k) => owners.includes(k)) || others.length !== 1 || others[0] !== allowance.agent || !agentKeys.includes(allowance.agent))
      return c.json({ error: "an escalation names owners plus exactly this allowance's agent key, signed by it" }, 400);
    const busy = full(c, agent.policy, allowance.agent);
    if (busy) return busy;
    const row = insert({
      policy: agent.policy, kind: "request", title: purpose.slice(0, 200), cbor, unit: agent.unit,
      recipe: { intentId, purpose: purpose.slice(0, 300), reason: reason.slice(0, 500) }, required, createdBy: allowance.agent,
    });
    return c.json(await addWitness(row, agentWitness));
  });

  return { insert, addWitness };
}

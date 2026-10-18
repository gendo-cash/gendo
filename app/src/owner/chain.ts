// The chain, through the server's /chain proxy (the Blockfrost key stays on the server).
import {
  Blockfrost, CML, Lucid, SLOT_CONFIG_NETWORK, blockfrostQuery, connect, liveness, makeVault, owner, parseVaultId, txFacts, vaultVersionOf, verifiedOutputs, withProjectIdHeader, withRetries,
  type Liveness, type LucidEvolution, type UTxO, type Vault,
} from "../../../sdk/src/core/index.ts";
import { readVault, type Get } from "../../../sdk/src/read/index.ts";
import type { Net } from "./types.ts";
import { session } from "./api.ts";

const base = () => `${location.origin}/chain`;
// Sent as project_id to our proxy (which adds the real Blockfrost key): a signed-in owner's session
// token, so the proxy skips its cache for owners building txs. Before sign-in: cached reads.
const pid = () => session.get()?.token ?? "anonymous";

let headerFixed = false;
export async function openChain(net: Net): Promise<LucidEvolution> {
  // Behind Caddy, which drops header names with underscores, the session token must travel as X-Project-Id.
  if (!headerFixed) globalThis.fetch = withProjectIdHeader(globalThis.fetch.bind(globalThis), base());
  headerFixed = true;
  let l: LucidEvolution;
  if (net === "Custom") {
    const g = (await (await fetch(`${base()}/genesis`)).json()) as { system_start: number; slot_length: number };
    SLOT_CONFIG_NETWORK.Custom = { zeroTime: g.system_start * 1000, zeroSlot: 0, slotLength: g.slot_length * 1000 };
    l = await Lucid(withRetries(new Blockfrost(base(), pid())), "Custom");
  } else l = await connect({ network: net, blockfrostUrl: base(), blockfrostProjectId: pid() });
  owner.setOwnerTxTtl(owner.offlineTtlMs(net)); // owners sign on their own time; devnets have a horizon of minutes
  return l;
}

/** After sign-in, read through the session so the proxy serves fresh data. */
export const readThroughSession = (l: LucidEvolution) => l.switchProvider(withRetries(new Blockfrost(base(), pid())));

/** A saved vault's script, whichever code it runs (vaults.ts has checked its id names its policy). */
export const vaultOf = (v: { vaultId: string; policy: string }): Vault => {
  const id = parseVaultId(v.vaultId);
  const found = vaultVersionOf(id, v.policy);
  return found ? found.vault : makeVault(id.network, id.seed);
};

/** Inputs and collateral inputs. On preprod each is rebuilt from the tx that created it and
 *  checked against that tx's hash, so the server can't forge what an owner sees. The devnet's
 *  indexer serves no tx CBOR: there the inputs are read as-is and the inbox says so. */
export async function inputsOf(l: LucidEvolution, cbor: string, net: Net): Promise<{ utxos: UTxO[]; verified: boolean }> {
  const body = CML.Transaction.from_cbor_hex(cbor).body();
  const refs: string[] = [];
  for (let i = 0; i < body.inputs().len(); i++) refs.push(`${body.inputs().get(i).transaction_id().to_hex()}#${body.inputs().get(i).index()}`);
  const ci = body.collateral_inputs();
  for (let i = 0; ci && i < ci.len(); i++) refs.push(`${ci.get(i).transaction_id().to_hex()}#${ci.get(i).index()}`);
  if (net === "Preprod") {
    const utxos = await verifiedOutputs(async (h) => {
      const r = await fetch(`${base()}/txs/${h}/cbor`);
      return r.ok ? ((await r.json()) as { cbor: string }).cbor : undefined;
    }, refs);
    return { utxos, verified: true };
  }
  const utxos = await l.utxosByOutRef(refs.map((r) => ({ txHash: r.split("#")[0]!, outputIndex: Number(r.split("#")[1]) })));
  return { utxos, verified: false };
}

export async function livenessOf(l: LucidEvolution, cbor: string): Promise<Liveness> {
  const q = blockfrostQuery(base(), pid());
  return liveness(q, txFacts(l, cbor), (await q.tipMs()) ?? Date.now(), async (txHash, index) => {
    const [o] = await l.utxosByOutRef([{ txHash, outputIndex: index }]);
    if (!o) return undefined;
    return (await l.utxosAt(o.address)).some((u) => u.txHash === txHash && u.outputIndex === index);
  });
}

const get: Get = async (path) => {
  const r = await fetch(`${base()}${path}`, { headers: { project_id: pid() } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error("The chain is unavailable right now. Try again in a minute.");
  return r.json();
};
export { get as chainGet };
export const readLight = async (policy: string, net: Net) => {
  const tip = (await get("/blocks/latest")) as { time: number } | undefined;
  return readVault(get, policy, net, tip ? tip.time * 1000 : Date.now());
};

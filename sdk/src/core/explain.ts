// sdk/src/core/explain.ts
// What an owner is about to sign, computed from the tx and the chain alone: every UTxO
// it spends (vault or not) against everything it creates, plus anything else a wallet's
// signature authorizes (withdrawals, certificates, votes, mints, collateral). The app
// shows this, never a description someone else wrote.
import { CML, type UTxO } from "@lucid-evolution/lucid";
import { multiAssetToAssets, valueToAssets } from "./assets.js";
import { describeTx } from "./cosign.js";
import { allowanceFromData, configFromData, type AllowanceDatum, type AppConfig, type ConfigDatum } from "./data.js";
import type { Intent } from "./intent.js";
import type { Vault } from "./vault.js";
import { allowanceFromDataV1, configFromDataV1 } from "./legacy.js";

type Qty = Record<string, bigint>;

export type Change =
  | { kind: "config"; before: ConfigDatum | null; after: ConfigDatum | null; /** A new vault: the ADA held with its config. */ deposit?: bigint }
  | { kind: "grant"; unit: string; after: AllowanceDatum | null; lovelace: bigint }
  | { kind: "edit"; unit: string; before: AllowanceDatum | null; after: AllowanceDatum | null; lovelaceBefore: bigint; lovelaceAfter: bigint }
  | { kind: "revoke"; unit: string; before: AllowanceDatum | null; lovelace: bigint }
  | { kind: "spend"; unit: string; redeemer: "AgentSpend" | "CoSignedSpend" | "AgentTrade"; before: AllowanceDatum | null; after: AllowanceDatum | null };

export type Explanation = {
  hash: string;
  requiredSigners: string[];
  ttlSlot?: number;
  changes: Change[];
  /** What the vault address loses, per unit (only positive amounts; owners' fees never come from the vault). */
  leavesVault: Qty;
  /** Net change per address: what the tx creates there minus what it spends there. Collateral excluded. */
  flows: { address: string; delta: Qty }[];
  /** Lost only if a script fails: collateral inputs minus the collateral return, per paying address. */
  collateralAtRisk: { address: string; lovelace: bigint }[];
  fee: bigint;
  /** The intent record, only when it hashes to the vault's spend redeemer. */
  intent?: Intent;
  warnings: string[];
};

const tryDecode = <T>(f: (c: string) => T, cbor?: string | null): T | null => {
  try {
    return cbor ? f(cbor) : null;
  } catch {
    return null;
  }
};
const keyOf = (address: string) => {
  try {
    return CML.Address.from_bech32(address).payment_cred()?.as_pub_key()?.to_hex();
  } catch {
    return undefined;
  }
};
const addTo = (acc: Map<string, Qty>, address: string, assets: Qty, sign: 1n | -1n) => {
  const q = acc.get(address) ?? {};
  for (const [u, n] of Object.entries(assets)) q[u] = (q[u] ?? 0n) + sign * n;
  acc.set(address, q);
};
const nonZero = (q: Qty): Qty => Object.fromEntries(Object.entries(q).filter(([, n]) => n !== 0n));
const ada = (n: bigint) => `${Number(n) / 1e6} ADA`;

/**
 * `resolvedInputs` must cover the tx's inputs and collateral inputs; get them with
 * `verifiedOutputs` so a relay can't forge them. `viewer` is the signing owner's key hash, or
 * every key hash their wallet holds (an HD wallet signs for all of its keys).
 */
export function explainTx(txCbor: string, vault: Vault, resolvedInputs: UTxO[], opts: { viewer?: string | string[]; /** The vault's code: 1 is from before apps. */ version?: 1 | 2 } = {}): Explanation {
  const readConfig = opts.version === 1 ? configFromDataV1 : configFromData;
  const readAllowance = opts.version === 1 ? allowanceFromDataV1 : allowanceFromData;
  const byRef = new Map(resolvedInputs.map((u) => [`${u.txHash}#${u.outputIndex}`, u]));
  const summary = describeTx(txCbor, {
    vault,
    inputAddresses: Object.fromEntries(resolvedInputs.map((u) => [`${u.txHash}#${u.outputIndex}`, u.address])),
  });
  const warnings: string[] = [];
  const body = CML.Transaction.from_cbor_hex(txCbor).body();

  const collateralRefs: string[] = [];
  const ci = body.collateral_inputs();
  for (let i = 0; ci && i < ci.len(); i++) collateralRefs.push(`${ci.get(i).transaction_id().to_hex()}#${ci.get(i).index()}`);
  const missing = [...summary.inputs, ...collateralRefs].filter((r) => !byRef.has(r));
  if (missing.length) warnings.push(`couldn't see ${missing.length} of its inputs on the chain; don't sign what you can't check`);
  if (summary.otherRedeemers.length) warnings.push(`it runs scripts other than this vault's: ${summary.otherRedeemers.join(", ")}`);

  type Out = { address: string; assets: Qty; datum?: string };
  const outs: Out[] = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    outs.push({ address: o.address().to_bech32(), assets: valueToAssets(o.amount()) as Qty, datum: o.datum()?.as_datum()?.to_cbor_hex() });
  }
  const ins = summary.inputs.map((r) => byRef.get(r)).filter((u): u is UTxO => !!u);
  const atVault = (a: string) => a === vault.address;
  const vaultIns = ins.filter((u) => atVault(u.address));
  const vaultOuts = outs.filter((o) => atVault(o.address));
  const isVaultUnit = (u: string) => u.startsWith(vault.hash) && u.length > 56;
  const allowanceUnits = (assets: Qty) => Object.keys(assets).filter((u) => isVaultUnit(u) && u !== vault.configUnit);

  // What the vault's datums say before and after.
  const changes: Change[] = [];
  const cfgIn = vaultIns.find((u) => ((u.assets as Qty)[vault.configUnit] ?? 0n) > 0n);
  const cfgOut = vaultOuts.find((o) => (o.assets[vault.configUnit] ?? 0n) > 0n);
  if (cfgIn || cfgOut)
    changes.push({
      kind: "config", before: tryDecode(readConfig, cfgIn?.datum), after: tryDecode(readConfig, cfgOut?.datum),
      ...(!cfgIn && cfgOut ? { deposit: cfgOut.assets.lovelace ?? 0n } : {}),
    });
  const seen = new Set<string>();
  for (const u of vaultIns)
    for (const unit of allowanceUnits(u.assets as Qty)) {
      seen.add(unit);
      const before = tryDecode(readAllowance, u.datum);
      const out = vaultOuts.find((o) => (o.assets[unit] ?? 0n) > 0n);
      const redeemer = summary.vaultSpends[`${u.txHash}#${u.outputIndex}`];
      if (!out) changes.push({ kind: "revoke", unit, before, lovelace: u.assets.lovelace ?? 0n });
      else if (redeemer === "CoSignedSpend" || redeemer === "AgentSpend" || redeemer === "AgentTrade")
        changes.push({ kind: "spend", unit, redeemer, before, after: tryDecode(readAllowance, out.datum) });
      else
        changes.push({ kind: "edit", unit, before, after: tryDecode(readAllowance, out.datum), lovelaceBefore: u.assets.lovelace ?? 0n, lovelaceAfter: out.assets.lovelace ?? 0n });
    }
  for (const o of vaultOuts)
    for (const unit of allowanceUnits(o.assets))
      if (!seen.has(unit)) changes.push({ kind: "grant", unit, after: tryDecode(readAllowance, o.datum), lovelace: o.assets.lovelace ?? 0n });
  for (const c of changes)
    if ("after" in c && c.after === null) warnings.push(`it writes a ${c.kind === "config" ? "config" : "allowance"} the chain will treat as unreadable`);

  // Where everything goes: net per address, every asset.
  const net = new Map<string, Qty>();
  for (const u of ins) addTo(net, u.address, u.assets as Qty, -1n);
  for (const o of outs) addTo(net, o.address, o.assets, 1n);
  const flows = [...net].map(([address, q]) => ({ address, delta: nonZero(q) })).filter((f) => Object.keys(f.delta).length);
  // A burned vault token (a revoke) is destroyed, not paid anywhere: it doesn't count as leaving.
  const minted = multiAssetToAssets(body.mint()) as Qty;
  const vaultDelta = { ...(net.get(vault.address) ?? {}) };
  for (const [u, n] of Object.entries(minted)) if (n < 0n && isVaultUnit(u)) vaultDelta[u] = (vaultDelta[u] ?? 0n) - n;
  const leavesVault = nonZero(Object.fromEntries(Object.entries(vaultDelta).filter(([, n]) => n < 0n).map(([u, n]) => [u, -n])));
  for (const o of outs)
    if (!atVault(o.address) && Object.keys(o.assets).some(isVaultUnit)) warnings.push(`a vault token leaves the vault, to ${o.address}`);

  // Everything else a wallet's signature authorizes.
  const fee = body.fee();
  const wd = body.withdrawals();
  if (wd && wd.len() > 0) warnings.push(`it withdraws staking rewards (${wd.len()} reward account${wd.len() === 1 ? "" : "s"})`);
  const certs = body.certs();
  if (certs && certs.len() > 0) warnings.push(`it changes staking or pool registrations (${certs.len()} certificate${certs.len() === 1 ? "" : "s"})`);
  if (body.voting_procedures() || body.proposal_procedures()) warnings.push("it casts governance votes or proposals");
  const mint = body.mint();
  const policies = mint?.keys();
  for (let i = 0; policies && i < policies.len(); i++)
    if (policies.get(i).to_hex() !== vault.hash) {
      warnings.push("it mints or burns tokens of another policy");
      break;
    }

  // Collateral: lost only if a script fails.
  const collIns = collateralRefs.map((r) => byRef.get(r)).filter((u): u is UTxO => !!u);
  const returned = body.collateral_return() ? valueToAssets(body.collateral_return()!.amount()).lovelace ?? 0n : 0n;
  const collTotal = collIns.reduce((n, u) => n + (u.assets.lovelace ?? 0n), 0n);
  const collateralAtRisk = collIns.length ? [{ address: collIns[0]!.address, lovelace: collTotal - returned }] : [];

  // Said to the viewer directly.
  const viewers = opts.viewer === undefined ? [] : Array.isArray(opts.viewer) ? opts.viewer : [opts.viewer];
  if (viewers.length) {
    const mine = (a: string) => viewers.includes(keyOf(a) ?? "");
    let out = 0n;
    for (const f of flows) if (mine(f.address)) out -= f.delta.lovelace ?? 0n;
    const tokensOut = flows.some((f) => mine(f.address) && Object.entries(f.delta).some(([u, n]) => u !== "lovelace" && n < 0n));
    if (out > fee || tokensOut) warnings.push(`it takes ${ada(out)}${tokensOut ? " and tokens" : ""} from your wallet, more than the ${ada(fee)} fee`);
    for (const c of collateralAtRisk)
      if (mine(c.address) && c.lovelace > 5_000_000n) warnings.push(`if its scripts fail, you lose up to ${ada(c.lovelace)} of collateral`);
    for (const c of changes)
      if (c.kind === "config" && viewers.some((v) => c.before?.owners.includes(v) && c.after && !c.after.owners.includes(v)))
        warnings.push("it removes you as an owner");
  }

  return {
    hash: summary.hash,
    requiredSigners: summary.requiredSigners,
    ...(summary.validity.ttlSlot !== undefined ? { ttlSlot: Number(summary.validity.ttlSlot) } : {}),
    changes,
    leavesVault,
    flows,
    collateralAtRisk,
    fee,
    ...(summary.intent ? { intent: summary.intent } : {}),
    warnings,
  };
}

/** What a config change does to the vault's apps, by name. */
export function appChanges(before: ConfigDatum | null, after: ConfigDatum | null): { added: AppConfig[]; removed: string[]; changed: { name: string; before: AppConfig; after: AppConfig }[] } {
  const b = before?.apps ?? [];
  const a = after?.apps ?? [];
  const same = (x: AppConfig, y: AppConfig) => x.adapter === y.adapter && x.orderScript === y.orderScript && x.settings === y.settings;
  return {
    added: a.filter((x) => !b.some((y) => y.name === x.name)),
    removed: b.filter((x) => !a.some((y) => y.name === x.name)).map((x) => x.name),
    changed: a.flatMap((x) => {
      const y = b.find((z) => z.name === x.name);
      return y && !same(x, y) ? [{ name: x.name, before: y, after: x }] : [];
    }),
  };
}

/**
 * The outputs `refs` point at, rebuilt from the txs that created them: each tx's body
 * is hashed and must match the id it was asked for, so a relay (our server's chain
 * proxy included) can't forge an input's address, value or datum.
 */
export async function verifiedOutputs(fetchTxCbor: (hash: string) => Promise<string | undefined>, refs: string[]): Promise<UTxO[]> {
  const byTx = new Map<string, number[]>();
  for (const r of refs) {
    const [h, i] = r.split("#");
    byTx.set(h!, [...(byTx.get(h!) ?? []), Number(i)]);
  }
  const out: UTxO[] = [];
  for (const [hash, indices] of byTx) {
    const cbor = await fetchTxCbor(hash);
    if (!cbor) continue; // unknown: explainTx warns that it couldn't see it
    const body = CML.Transaction.from_cbor_hex(cbor).body();
    if (CML.hash_transaction(body).to_hex() !== hash) throw new Error(`the chain data for tx ${hash} doesn't match its hash`);
    for (const i of indices) {
      const o = body.outputs().get(i);
      if (!o) throw new Error(`tx ${hash} has no output ${i}`);
      const datum = o.datum()?.as_datum()?.to_cbor_hex();
      out.push({ txHash: hash, outputIndex: i, address: o.address().to_bech32(), assets: valueToAssets(o.amount()), ...(datum ? { datum } : {}) } as UTxO);
    }
  }
  return out;
}

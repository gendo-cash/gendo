// Multi-party signing over one exact tx body. No on-chain proposal object:
// the unsigned CBOR travels to each party, each returns a witness set, and
// anyone assembles and submits. Every party should `describeTx` first.
import { CML, Data, type LucidEvolution, type TxSignBuilder } from "@lucid-evolution/lucid";
import { fmt, multiAssetToAssets, valueToAssets } from "./assets.js";
import { INTENT_LABEL, verifyIntent, type Intent } from "./intent.js";
import type { Vault } from "./vault.js";

/** One party's signature over the body, as a CBOR witness set. */
export async function witness(lucid: LucidEvolution, txCbor: string, privateKey: string): Promise<string> {
  return lucid.fromTx(txCbor).partialSign.withPrivateKey(privateKey);
}

export async function assemble(lucid: LucidEvolution, txCbor: string, witnesses: string[]) {
  const signed = await lucid.fromTx(txCbor).assemble(witnesses).complete();
  if (signed.toHash() !== lucid.fromTx(txCbor).toHash()) throw new Error("assembled tx body differs from the original");
  return signed;
}

export type TxSummary = {
  hash: string;
  inputs: string[];
  outputs: { address: string; assets: Record<string, string>; inlineDatum: boolean }[];
  fee: string;
  requiredSigners: string[];
  validity: { fromSlot?: string; ttlSlot?: string };
  mint: Record<string, string>;
  /** Redeemers proven to run the vault's own script, by name. */
  vaultRedeemers: string[];
  /** Every other redeemer: another script, or a spent input whose address wasn't supplied. */
  otherRedeemers: string[];
  /** The vault redeemer on each vault input, by `txHash#index`. */
  vaultSpends: Record<string, string>;
  intent?: Intent;
};

export type DescribeOptions = {
  /** The vault whose redeemers get named. Without it, no redeemer is attributed to the vault. */
  vault?: Pick<Vault, "hash">;
  /** bech32 address of each spent input, keyed `txHash#index`. A spend redeemer is the vault's
   *  only when its input is known to sit at the vault's script credential. */
  inputAddresses?: Record<string, string>;
};

const REDEEMER_NAMES: Record<string, string[]> = {
  spend: ["AgentSpend", "CoSignedSpend", "OwnerManage", "AgentTrade"],
  mint: ["InitConfig", "ManageAllowances"],
};

const scriptCredOf = (bech32: string) => CML.Address.from_bech32(bech32).payment_cred()?.as_script()?.to_hex();

/** Human/machine-readable view of what a signer is about to approve. */
export function describeTx(txCbor: string, opts: DescribeOptions = {}): TxSummary {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const body = tx.body();
  const refs: { txHash: string; index: bigint }[] = [];
  for (let i = 0; i < body.inputs().len(); i++) {
    const x = body.inputs().get(i);
    refs.push({ txHash: x.transaction_id().to_hex(), index: x.index() });
  }
  const inputs = refs.map((r) => `${r.txHash}#${r.index}`);
  const outputs = [];
  for (let i = 0; i < body.outputs().len(); i++) {
    const o = body.outputs().get(i);
    outputs.push({ address: o.address().to_bech32(), assets: fmt(valueToAssets(o.amount())), inlineDatum: !!o.datum()?.as_datum() });
  }
  const req: string[] = [];
  const rs = body.required_signers();
  for (let i = 0; rs && i < rs.len(); i++) req.push(rs.get(i).to_hex());
  const mint = fmt(multiAssetToAssets(body.mint()));

  // Redeemer indices follow the ledger's sorted order: inputs by (tx id, index), mint by policy id.
  const sortedInputs = [...refs]
    .sort((a, b) => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.index < b.index ? -1 : a.index > b.index ? 1 : 0))
    .map((r) => `${r.txHash}#${r.index}`);
  const sortedPolicies: string[] = [];
  const mp = body.mint()?.keys();
  for (let i = 0; mp && i < mp.len(); i++) sortedPolicies.push(mp.get(i).to_hex());
  sortedPolicies.sort();

  const vaultRedeemers: string[] = [];
  const otherRedeemers: string[] = [];
  const vaultSpends: Record<string, string> = {};
  let intentField: string | undefined;
  const push = (tag: number, index: number, data: string) => {
    const kind = tag === 0 ? "spend" : tag === 1 ? "mint" : `tag${tag}`;
    const target = kind === "spend" ? sortedInputs[index] : kind === "mint" ? sortedPolicies[index] : String(index);
    const isVault =
      !!opts.vault &&
      target !== undefined &&
      (kind === "mint"
        ? target === opts.vault.hash
        : kind === "spend" && opts.inputAddresses?.[target] !== undefined && scriptCredOf(opts.inputAddresses[target]!) === opts.vault.hash);
    if (!isVault) {
      otherRedeemers.push(`${kind}:${target ?? index}`);
      return;
    }
    const c = Data.from(data) as { index: number; fields: unknown[] };
    vaultRedeemers.push(`${kind}:${REDEEMER_NAMES[kind]?.[c.index] ?? c.index}`);
    if (kind === "spend") vaultSpends[target!] = REDEEMER_NAMES.spend![c.index] ?? String(c.index);
    if (kind === "spend" && (c.index === 0 || c.index === 1 || c.index === 3) && typeof c.fields?.[0] === "string" && c.fields[0].length === 64)
      intentField = c.fields[0];
  };
  const reds = tx.witness_set().redeemers();
  const map = reds?.as_map_redeemer_key_to_redeemer_val();
  if (map) {
    const ks = map.keys();
    for (let i = 0; i < ks.len(); i++) push(ks.get(i).tag(), Number(ks.get(i).index()), map.get(ks.get(i))!.data().to_cbor_hex());
  }
  const legacy = reds?.as_arr_legacy_redeemer();
  for (let i = 0; legacy && i < legacy.len(); i++)
    push(legacy.get(i).tag(), Number(legacy.get(i).index()), legacy.get(i).data().to_cbor_hex());

  // The intent record is trusted only when it hashes to the vault's own spend redeemer.
  let intent: Intent | undefined;
  const meta = tx.auxiliary_data()?.metadata()?.get(BigInt(INTENT_LABEL));
  if (meta && intentField) {
    const json = JSON.parse(CML.decode_metadatum_to_json_str(meta, CML.MetadataJsonSchema.NoConversions));
    intent = verifyIntent(json, intentField);
  }
  return {
    hash: CML.hash_transaction(body).to_hex(),
    inputs,
    outputs,
    fee: body.fee().toString(),
    requiredSigners: req,
    validity: { fromSlot: body.validity_interval_start()?.toString(), ttlSlot: body.ttl()?.toString() },
    mint,
    vaultRedeemers,
    otherRedeemers,
    vaultSpends,
    intent,
  };
}

export type { TxSignBuilder };

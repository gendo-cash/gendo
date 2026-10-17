// Signer policy (edges O1, O2, O3). Pure function over the tx CBOR + state so it
// can be unit-tested without sockets. The chain enforces the hard caps; this
// layer adds what the chain cannot: rate limits, a local budget, short TTLs,
// and a second opinion on destinations from a config the LLM cannot edit.
import { CML, type Assets } from "@lucid-evolution/lucid";
import { add, valueToAssets } from "../../core/assets.js";

export type SignerPolicy = {
  agentKeyHash: string;
  vaultAddress: string;
  /** The one allowance this signer serves (policy id + token name). The continuing output must carry it. */
  allowanceUnit: string;
  /** bech32 destinations, exact. Should mirror (or be stricter than) the on-chain allowlist. */
  destinations: string[];
  maxTxPerHour: number;
  /** Rolling 24 h budget per unit (`lovelace` or policy id + name). An asset with no entry may not leave. */
  maxPerDay: Assets;
  /** Refuse txs whose TTL is further than this from now (pre-signed tx shelf life). */
  maxTtlMs: number;
  /** TTL cap for co-signed escalations, which owners sign on their own machines over hours. Defaults to maxTtlMs. */
  maxCoSignedTtlMs?: number;
  allowCoSigned: boolean;
  slot: { zeroTime: number; zeroSlot: number; slotLength: number };
  /** Apps this agent may trade with: its adapter's reward address (the trade's one zero withdrawal) and where orders go. */
  apps?: { adapterReward: string; orderAddress: string }[];
};

export type { SignerState } from "./state.js";
import type { SignerState } from "./state.js";

export type Decision = { ok: true; out: Assets; coSigned?: true } | { ok: false; reason: string };

/** Constructor index of the spend redeemer on input 0 (the allowance): 0 AgentSpend, 1 CoSignedSpend, 3 AgentTrade. */
function spendRedeemerIndex(tx: CML.Transaction): bigint | undefined {
  const reds = tx.witness_set().redeemers();
  const map = reds?.as_map_redeemer_key_to_redeemer_val();
  if (map) {
    const ks = map.keys();
    for (let i = 0; i < ks.len(); i++)
      if (ks.get(i).tag() === CML.RedeemerTag.Spend && ks.get(i).index() === 0n) return map.get(ks.get(i))!.data().as_constr_plutus_data()?.alternative();
  }
  const legacy = reds?.as_arr_legacy_redeemer();
  for (let i = 0; legacy && i < legacy.len(); i++)
    if (legacy.get(i).tag() === CML.RedeemerTag.Spend && legacy.get(i).index() === 0n) return legacy.get(i).data().as_constr_plutus_data()?.alternative();
  return undefined;
}

export function evaluate(policy: SignerPolicy, state: SignerState, txCbor: string, now: number): Decision {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(txCbor);
  } catch {
    return { ok: false, reason: "not a transaction" };
  }
  const body = tx.body();

  const req = body.required_signers();
  const signers: string[] = [];
  for (let i = 0; req && i < req.len(); i++) signers.push(req.get(i).to_hex());
  if (!signers.includes(policy.agentKeyHash)) return { ok: false, reason: "agent key is not a required signer" };
  // Co-signed means the CoSignedSpend redeemer, which the chain only accepts with the owners'
  // threshold. Extra required signers on an ordinary spend earn nothing.
  const coSigned = spendRedeemerIndex(tx) === 1n;
  if (coSigned && !policy.allowCoSigned) return { ok: false, reason: "co-signed spends are disabled for this signer" };

  // Agent and over-limit spends both draw from the allowance UTxO alone.
  if (body.inputs().len() !== 1) return { ok: false, reason: "a spend must have exactly one input, the allowance" };
  if (body.mint() || body.certs()) return { ok: false, reason: "mint/certificate not allowed" };
  // A trade (AgentTrade) carries exactly one zero withdrawal: its app's adapter. Nothing else withdraws.
  const trade = !coSigned && spendRedeemerIndex(tx) === 3n;
  const wd = body.withdrawals();
  let app: { adapterReward: string; orderAddress: string } | undefined;
  if (trade) {
    const keys = wd?.keys();
    if (!wd || !keys || keys.len() !== 1 || wd.get(keys.get(0)) !== 0n) return { ok: false, reason: "a trade withdraws exactly zero, from its app's adapter" };
    const reward = keys.get(0).to_address().to_bech32();
    app = policy.apps?.find((a) => a.adapterReward === reward);
    if (!app) return { ok: false, reason: "this agent isn't allowed to trade with that app (adapter withdrawal not in the signer policy)" };
  } else if (wd) return { ok: false, reason: "withdrawal not allowed" };

  const ttl = body.ttl();
  if (ttl === undefined) return { ok: false, reason: "tx has no upper validity bound" };
  const ttlMs = policy.slot.zeroTime + (Number(ttl) - policy.slot.zeroSlot) * policy.slot.slotLength;
  const cap = coSigned ? (policy.maxCoSignedTtlMs ?? policy.maxTtlMs) : policy.maxTtlMs;
  if (ttlMs - now > cap) return { ok: false, reason: `ttl ${ttlMs - now}ms exceeds signer max ${cap}ms` };

  // Everything that leaves: the fee plus every asset paid to a destination.
  const paid: Assets[] = [{ lovelace: body.fee() }];
  const continuing: CML.TransactionOutput[] = [];
  const outs = body.outputs();
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    const addr = o.address().to_bech32();
    if (addr === policy.vaultAddress) {
      continuing.push(o);
      continue;
    }
    // An escalation may pay anyone: the owners approve each payee. A trade may also pay its app's order address.
    if (!coSigned && !policy.destinations.includes(addr) && addr !== app?.orderAddress) return { ok: false, reason: `destination ${addr} not allowed by signer policy` };
    paid.push(valueToAssets(o.amount()));
  }
  if (continuing.length !== 1) return { ok: false, reason: "expected exactly one continuing output at the vault" };
  // With one input and no mint, the continuing output can only hold tokens that input held,
  // so this pins the input to the configured allowance.
  if (valueToAssets(continuing[0]!.amount())[policy.allowanceUnit] !== 1n)
    return { ok: false, reason: `continuing output does not carry allowance ${policy.allowanceUnit}` };
  const out = add(...paid);
  // The owners' threshold authorizes an escalation; the agent's own budget and rate are for its unilateral spends.
  if (coSigned) return { ok: true, out, coSigned: true };

  const hourAgo = now - 3_600_000;
  const dayAgo = now - 86_400_000;
  const recent = state.signed.filter((s) => s.at > hourAgo).length;
  if (recent >= policy.maxTxPerHour) return { ok: false, reason: `rate limit: ${recent} txs in the last hour` };
  const spentToday = add(...state.signed.filter((s) => s.at > dayAgo).map((s) => s.assets));
  for (const [unit, q] of Object.entries(out)) {
    const max = policy.maxPerDay[unit];
    if (max === undefined) return { ok: false, reason: `daily budget: ${unit} has no daily limit in the signer policy` };
    const before = spentToday[unit] ?? 0n;
    if (before + q > max) return { ok: false, reason: `daily budget: ${unit} ${before} + ${q} > ${max}` };
  }

  return { ok: true, out };
}

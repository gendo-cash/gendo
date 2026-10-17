// The signer's decision, shared by the socket daemon and the in-process signer in gendo-agent:
// the same intent dedupe, the same policy, state persisted before the witness leaves.
import { appendFileSync } from "node:fs";
import { CML, type Network } from "@lucid-evolution/lucid";
import { fromPlutusAddress } from "../../core/address.js";
import { fmt } from "../../core/assets.js";
import { describeTx } from "../../core/cosign.js";
import type { AllowanceDatum } from "../../core/data.js";
import { txFate, type ChainQuery, type Fate } from "../../core/idempotency.js";
import { unitOf } from "../../core/limits.js";
import { appFor } from "../../core/apps/catalogue.js";
import { minswapAdapter } from "../../core/apps/minswap/adapter.js";
import type { Vault } from "../../core/vault.js";
import { checkIntent, factsOf } from "./dedupe.js";
import { evaluate, type SignerPolicy } from "./policy.js";
import { loadState, saveState } from "./state.js";

export type SignerCoreOptions = {
  privateKey: string;
  /** Fixed (the daemon's config file) or read fresh for every tx (gendo-agent: the allowance as it is now). */
  policy: SignerPolicy | (() => Promise<SignerPolicy>);
  /** JSON file for counters + intent table. Without it, state is in memory only (tests). */
  statePath?: string;
  auditLog?: string;
  chain?: ChainQuery;
  now?: () => number;
};

export function witnessFor(txCbor: string, privateKey: string): string {
  const tx = CML.Transaction.from_cbor_hex(txCbor);
  const hash = CML.hash_transaction(tx.body());
  const sk = CML.PrivateKey.from_bech32(privateKey);
  const ws = CML.TransactionWitnessSetBuilder.new();
  ws.add_vkey(CML.make_vkey_witness(hash, sk));
  return ws.build().to_cbor_hex();
}

/** Signs only what the policy allows; a refusal throws `signer refused: <reason>`, as the socket client does. */
export function createSigner(opts: SignerCoreOptions): { sign(txCbor: string): Promise<string> } {
  const policyNow = async () => (typeof opts.policy === "function" ? opts.policy() : opts.policy);
  const vaultOf = (policy: SignerPolicy) => {
    const hash = CML.Address.from_bech32(policy.vaultAddress).payment_cred()?.as_script()?.to_hex();
    if (!hash) throw new Error("policy.vaultAddress is not a script address");
    return { hash };
  };
  if (typeof opts.policy !== "function") vaultOf(opts.policy); // a bad fixed policy fails at start, as before
  const state = loadState(opts.statePath);
  const now = opts.now ?? Date.now;
  const audit = (entry: object) => {
    if (opts.auditLog) appendFileSync(opts.auditLog, JSON.stringify({ at: new Date(now()).toISOString(), ...entry }) + "\n");
  };
  const refuse = (txHash: string, reason: string): never => {
    audit({ txHash, decision: "refused", reason });
    throw new Error(`signer refused: ${reason}`);
  };

  async function decide(txCbor: string): Promise<string> {
    const t = now();
    const policy = await policyNow();
    const vault = vaultOf(policy);
    let facts: ReturnType<typeof factsOf>;
    let intentId: string;
    try {
      facts = factsOf(txCbor, policy.slot);
      // Attribute the single input to the vault so describeTx reads the vault's own redeemer.
      // `evaluate` below refuses any tx where that input isn't the configured allowance.
      const inputAddresses = facts.inputs.length === 1 ? { [`${facts.inputs[0]!.txHash}#${facts.inputs[0]!.index}`]: policy.vaultAddress } : {};
      const intent = describeTx(txCbor, { vault, inputAddresses }).intent; // verified against the redeemer hash
      if (!intent?.id) return refuse(facts.hash, "tx carries no verifiable intent record");
      intentId = intent.id;
    } catch (e) {
      if ((e as Error).message.startsWith("signer refused:")) throw e;
      return refuse("", `unreadable tx or intent: ${(e as Error).message}`);
    }

    const prev = state.intents[intentId];
    let fate: Fate | undefined;
    if (prev && prev.hash !== facts.hash) fate = opts.chain ? await txFate(opts.chain, prev, t) : undefined;
    const dedupe = checkIntent(prev, facts.hash, fate);
    if (!dedupe.ok) return refuse(facts.hash, dedupe.reason);

    const reSign = prev?.hash === facts.hash; // same body: don't count it twice
    const decision = evaluate(policy, reSign ? { ...state, signed: [] } : state, txCbor, t);
    if (!decision.ok) return refuse(facts.hash, decision.reason);

    if (!reSign) {
      if (!decision.coSigned) state.signed.push({ at: t, assets: decision.out }); // escalations don't count against the agent's budget
      state.intents[intentId] = { ...facts, at: t };
    }
    saveState(opts.statePath, state, t); // persisted BEFORE the witness leaves
    audit({ txHash: facts.hash, intentId, decision: reSign ? "re-signed" : "signed", out: fmt(decision.out) });
    return witnessFor(txCbor, opts.privateKey);
  }

  // One at a time: the dedupe check and the state write must not interleave with another request for the same intent.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    sign(txCbor) {
      const run = queue.then(() => decide(txCbor));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** The in-process signer's second opinion, read off the allowance itself: nothing to configure. */
export function policyFromAllowance(a: { datum: AllowanceDatum; unit: string; vault: Vault; network: Network; slot: SignerPolicy["slot"] }): SignerPolicy {
  return {
    agentKeyHash: a.datum.agent,
    vaultAddress: a.vault.address,
    allowanceUnit: a.unit,
    destinations: a.datum.destinations.map((d) => fromPlutusAddress(a.network, d)),
    maxTxPerHour: 30,
    maxPerDay: Object.fromEntries(a.datum.caps.map((c) => [unitOf(c.policy, c.name), c.windowCap])),
    maxTtlMs: 15 * 60_000,
    maxCoSignedTtlMs: 2 * 3_600_000,
    allowCoSigned: true,
    slot: a.slot,
    // The apps this allowance grants that the catalogue deploys on this network.
    apps: a.datum.apps.flatMap((name) => {
      const found = name === "minswap" ? appFor(name, a.network) : undefined;
      return found ? [{ adapterReward: minswapAdapter(a.network).rewardAddress, orderAddress: found.network.orderAddress }] : [];
    }),
  };
}

// Owner side. Every function returns an UNSIGNED tx; owners sign offline and
// the witnesses are assembled with cosign.ts. The proposer's wallet (selected
// on `lucid`) pays fees and provides collateral; vault value never pays them.
import { credentialToAddress, type Assets, type LucidEvolution, type TxSignBuilder, type UTxO } from "@lucid-evolution/lucid";
import { add, sub, withMinAda } from "./assets.js";
import type { AllowanceUtxo, ConfigUtxo } from "./chain.js";
import {
  allowanceToData,
  configToData,
  mintRedeemer,
  spendRedeemer,
  type AllowanceDatum,
  type AppConfig,
  type AssetCap,
  type ConfigDatum,
} from "./data.js";
import { toPlutusAddress } from "./address.js";
import { assertTestnetOutputs, bodyOf } from "./guards.js";
import { configChangeProblems, isValidConfig, wellFormedProblems } from "./limits.js";
import { allowanceName, makeVault, type Vault } from "./vault.js";

const OWNER = spendRedeemer({ kind: "OwnerManage" });

function pureAdaUtxo(utxos: UTxO[]): UTxO {
  const u = utxos.find((x) => !x.scriptRef && Object.keys(x.assets).length === 1);
  if (!u) throw new Error("wallet needs a pure-ADA UTxO to use as a seed");
  return u;
}

function signers(b: ReturnType<LucidEvolution["newTx"]>, keys: string[]) {
  for (const k of new Set(keys)) b = b.addSignerKey(k);
  return b;
}

/**
 * Every owner tx carries a TTL so its fate is always decidable (after the TTL
 * the ledger guarantees it can never land; see idempotency.ts). It must leave
 * enough time for offline co-signing, and stay inside the network's horizon
 * (about 36 h on preprod, minutes on local devnets).
 */
let ownerTxTtlMs = 10 * 60_000;
export function setOwnerTxTtl(ms: number) {
  if (ms > MAX_OFFLINE_TTL_MS) throw new Error(`tx TTL ${ms} ms exceeds the ${MAX_OFFLINE_TTL_MS} ms maximum`);
  ownerTxTtlMs = ms;
}

/** Upper bound for any TTL: well inside preprod's ~36 h horizon. */
export const MAX_OFFLINE_TTL_MS = 24 * 3_600_000;

/**
 * TTL for a tx that several parties sign on their own machines (owner txs
 * built with `--out`, over-limit escalations). Long enough to collect
 * signatures on preprod; local devnets have a horizon of minutes.
 */
export function offlineTtlMs(network: string): number {
  return network === "Custom" ? 90_000 : 2 * 3_600_000;
}

async function finish(lucid: LucidEvolution, b: ReturnType<LucidEvolution["newTx"]>): Promise<TxSignBuilder> {
  // The provider's clock, not the wall clock (emulators and devnets run their own).
  const now = lucid.slotToUnixTime(lucid.currentSlot());
  const tx = await b.validTo(now + ownerTxTtlMs).complete();
  assertTestnetOutputs(bodyOf(tx));
  return tx;
}

// --- vault lifecycle --------------------------------------------------------

export async function createVault(
  lucid: LucidEvolution,
  init: ConfigDatum,
  opts: { refScriptAddress?: string; fund?: bigint; signer?: string } = {},
): Promise<{ tx: TxSignBuilder; vault: Vault }> {
  const problems = isValidConfig(init);
  if (problems.length) throw new Error(`invalid config: ${problems.join("; ")}`);
  const seed = pureAdaUtxo(await lucid.wallet().getUtxos());
  const vault = makeVault(lucid.config().network!, { txHash: seed.txHash, outputIndex: seed.outputIndex });
  const configDatum = configToData(init);
  const configAssets = withMinAda(lucid, vault.address, { [vault.configUnit]: 1n }, configDatum);
  let b = lucid
    .newTx()
    .collectFrom([seed])
    .mintAssets({ [vault.configUnit]: 1n }, mintRedeemer("InitConfig"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(vault.address, { kind: "inline", value: configDatum }, configAssets);
  // Edge I3: park the reference script at an always-fail address so nobody can remove it.
  if (opts.refScriptAddress)
    b = b.pay.ToAddressWithData(opts.refScriptAddress, undefined, { lovelace: 0n }, vault.script);
  // The treasury: plain ADA at the vault address, like fundTreasury.
  if (opts.fund) b = b.pay.ToAddress(vault.address, { lovelace: opts.fund });
  // The app's server accepts a creation only from the signed-in owner's own key.
  if (opts.signer) b = b.addSignerKey(opts.signer);
  return { tx: await finish(lucid, b), vault };
}

export async function updateConfig(
  lucid: LucidEvolution,
  vault: Vault,
  current: ConfigUtxo,
  next: ConfigDatum,
  ownerSigners: string[],
): Promise<TxSignBuilder> {
  const problems = [...isValidConfig(next), ...configChangeProblems(current.config, next, ownerSigners)];
  if (problems.length) throw new Error(`invalid config change: ${problems.join("; ")}`);
  const datum = configToData(next);
  return finish(lucid, 
    signers(
      lucid
        .newTx()
        .collectFrom([current.utxo], OWNER)
        .pay.ToContract(vault.address, { kind: "inline", value: datum }, current.utxo.assets)
        .attach.SpendingValidator(vault.script),
      ownerSigners,
    ),
  );
}

export const pause = (l: LucidEvolution, v: Vault, c: ConfigUtxo, s: string[]) =>
  updateConfig(l, v, c, { ...c.config, paused: true }, s);
export const unpause = (l: LucidEvolution, v: Vault, c: ConfigUtxo, s: string[]) =>
  updateConfig(l, v, c, { ...c.config, paused: false }, s);
export const rotateOwners = (l: LucidEvolution, v: Vault, c: ConfigUtxo, owners: string[], threshold: bigint, s: string[]) =>
  updateConfig(l, v, c, { ...c.config, owners, threshold }, s);

/** Enable a DeFi app on the vault: its adapter and the owners' rules join the config. */
export async function enableApp(l: LucidEvolution, v: Vault, c: ConfigUtxo, app: AppConfig, s: string[]) {
  if (c.config.apps.some((a) => a.name === app.name)) throw new Error(`${app.name} is already enabled; change its settings instead`);
  return updateConfig(l, v, c, { ...c.config, apps: [...c.config.apps, app] }, s);
}

/** Replace an enabled app's entry (same name): new settings, or a new adapter version. */
export async function updateApp(l: LucidEvolution, v: Vault, c: ConfigUtxo, app: AppConfig, s: string[]) {
  if (!c.config.apps.some((a) => a.name === app.name)) throw new Error(`${app.name} isn't enabled`);
  return updateConfig(l, v, c, { ...c.config, apps: c.config.apps.map((a) => (a.name === app.name ? app : a)) }, s);
}

/** Disable an app. Agents granted it can no longer trade with it; orders already placed still settle or expire to the vault. */
export async function disableApp(l: LucidEvolution, v: Vault, c: ConfigUtxo, name: string, s: string[]) {
  if (!c.config.apps.some((a) => a.name === name)) throw new Error(`${name} isn't enabled`);
  return updateConfig(l, v, c, { ...c.config, apps: c.config.apps.filter((a) => a.name !== name) }, s);
}

export async function fundTreasury(lucid: LucidEvolution, vault: Vault, assets: Assets): Promise<TxSignBuilder> {
  return finish(lucid, lucid.newTx().pay.ToAddress(vault.address, assets));
}

/** Pay out of the treasury; leftover goes back to the treasury. */
export async function treasuryPay(
  lucid: LucidEvolution,
  vault: Vault,
  config: ConfigUtxo,
  from: UTxO[],
  payments: { to: string; assets: Assets }[],
  ownerSigners: string[],
): Promise<TxSignBuilder> {
  const total = add(...from.map((u) => u.assets));
  const paid = add(...payments.map((p) => p.assets));
  const leftover = sub(total, paid);
  if (Object.values(leftover).some((x) => x < 0n)) throw new Error("treasury inputs do not cover the payments");
  let b = lucid.newTx().collectFrom(from, OWNER).readFrom([config.utxo]).attach.SpendingValidator(vault.script);
  for (const p of payments) b = b.pay.ToAddress(p.to, p.assets);
  if (Object.keys(leftover).length) b = b.pay.ToAddress(vault.address, leftover);
  return finish(lucid, signers(b, ownerSigners));
}

// --- allowances -------------------------------------------------------------

export type Grant = {
  agent: string;
  destinations: string[]; // bech32, exact (stake part included)
  caps: AssetCap[];
  periodMs: bigint;
  windowStart: bigint;
  expiresAt: bigint;
  maxFee: bigint;
  fund: Assets;
  /** Names of the vault's enabled apps this agent may trade with. */
  apps?: string[];
};

export function grantDatum(g: Grant, network?: Parameters<typeof toPlutusAddress>[1]): AllowanceDatum {
  return {
    agent: g.agent,
    destinations: g.destinations.map((d) => toPlutusAddress(d, network)),
    caps: g.caps,
    spent: g.caps.map(() => 0n),
    windowStart: g.windowStart,
    periodMs: g.periodMs,
    expiresAt: g.expiresAt,
    maxFee: g.maxFee,
    apps: g.apps ?? [],
  };
}

export async function grantAllowance(
  lucid: LucidEvolution,
  vault: Vault,
  config: ConfigUtxo,
  g: Grant,
  ownerSigners: string[],
  opts: { fromTreasury?: UTxO[]; agentCollateral?: bigint } = {},
): Promise<{ tx: TxSignBuilder; unit: string }> {
  const datum = grantDatum(g, vault.network);
  const problems = wellFormedProblems(datum);
  if (problems.length) throw new Error(`invalid allowance: ${problems.join("; ")}`);
  if (config.config.owners.includes(g.agent)) throw new Error("agent key is an owner key (roles must be disjoint)");
  const seed = pureAdaUtxo(await lucid.wallet().getUtxos());
  const unit = vault.hash + allowanceName({ txHash: seed.txHash, outputIndex: seed.outputIndex });
  const d = allowanceToData(datum);
  const value = withMinAda(lucid, vault.address, add(g.fund, { [unit]: 1n }), d);

  let b = lucid
    .newTx()
    .collectFrom([seed])
    .readFrom([config.utxo])
    .mintAssets({ [unit]: 1n }, mintRedeemer("ManageAllowances"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(vault.address, { kind: "inline", value: d }, value);
  if (opts.fromTreasury?.length) {
    const total = add(...opts.fromTreasury.map((u) => u.assets));
    const leftover = sub(total, g.fund);
    if (Object.values(leftover).some((x) => x < 0n)) throw new Error("treasury inputs do not cover the grant");
    b = b.collectFrom(opts.fromTreasury, OWNER);
    if (Object.keys(leftover).length) b = b.pay.ToAddress(vault.address, leftover);
  }
  // A new agent's key has no ADA; the ledger needs a plain-ADA UTxO there as collateral for its spends.
  if (opts.agentCollateral) b = b.pay.ToAddress(credentialToAddress(lucid.config().network!, { type: "Key", hash: g.agent }), { lovelace: opts.agentCollateral });
  return { tx: await finish(lucid, signers(b, ownerSigners)), unit };
}

/** Replace an allowance's datum (and optionally add funds). Token stays. */
export async function editAllowance(
  lucid: LucidEvolution,
  vault: Vault,
  config: ConfigUtxo,
  allowance: { utxo: UTxO },
  next: AllowanceDatum,
  ownerSigners: string[],
  topUp: Assets = {},
): Promise<TxSignBuilder> {
  const problems = wellFormedProblems(next);
  if (problems.length) throw new Error(`invalid allowance: ${problems.join("; ")}`);
  const d = allowanceToData(next);
  return finish(lucid, 
    signers(
      lucid
        .newTx()
        .collectFrom([allowance.utxo], OWNER)
        .readFrom([config.utxo])
        .attach.SpendingValidator(vault.script)
        .pay.ToContract(vault.address, { kind: "inline", value: d }, add(allowance.utxo.assets, topUp)),
      ownerSigners,
    ),
  );
}

/**
 * Revoke and reclaim: burn the token, return the funds to the treasury.
 * Never decodes the datum, so it works on a corrupted allowance (edge U6).
 */
export async function revokeAllowance(
  lucid: LucidEvolution,
  vault: Vault,
  config: ConfigUtxo,
  allowance: { utxo: UTxO; unit: string },
  ownerSigners: string[],
): Promise<TxSignBuilder> {
  const rest = sub(allowance.utxo.assets, { [allowance.unit]: 1n });
  return finish(lucid, 
    signers(
      lucid
        .newTx()
        .collectFrom([allowance.utxo], OWNER)
        .readFrom([config.utxo])
        .mintAssets({ [allowance.unit]: -1n }, mintRedeemer("ManageAllowances"))
        .attach.SpendingValidator(vault.script)
        .pay.ToAddress(vault.address, rest),
      ownerSigners,
    ),
  );
}

export type { AllowanceUtxo };

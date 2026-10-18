// The agent editor's rules: the chain's own (is_well_formed) plus what makes a form usable.
import { MAX_DESTINATIONS, MAX_OWNERS } from "../../../sdk/src/core/limits.ts";
import { toPlutusAddress } from "../../../sdk/src/core/address.ts";
import { refHolderAddress } from "../../../sdk/src/core/vault.ts";
import type { AllowanceDatum, ConfigDatum, PlutusAddress } from "../../../sdk/src/core/data.ts";
import { ada } from "../public/format.ts";

export type AgentForm = { name: string; agentKey: string; perPayment: string; budget: string; period: "day" | "week" | "month"; payees: string[]; expires: string; fund: string; /** Vault apps this agent may trade with. */ apps: string[] };
export const PERIOD_MS = { day: 86_400_000n, week: 604_800_000n, month: 2_592_000_000n } as const;

/** Decimal ADA to lovelace, exactly; undefined for anything else. */
export function toLovelace(s: string): bigint | undefined {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s.trim());
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0") : undefined;
}

export function agentProblems(f: AgentForm, o: { isNew: boolean; nowMs: number; owners: string[]; isKeyAddress: (s: string) => boolean }): string[] {
  const p: string[] = [];
  const cap = toLovelace(f.perPayment);
  const budget = toLovelace(f.budget);
  if (cap === undefined || cap === 0n) p.push("Set a per-payment cap above 0 ADA.");
  if (budget === undefined || budget === 0n) p.push("Set a budget above 0 ADA.");
  if (cap && budget && cap > budget) p.push("The per-payment cap can't be above the budget: the chain refuses it.");
  if (!f.payees.length) p.push("Add at least one payee.");
  if (f.payees.length > MAX_DESTINATIONS) p.push(`At most ${MAX_DESTINATIONS} payees.`);
  for (const a of f.payees) if (!o.isKeyAddress(a)) p.push(`${a.slice(0, 20)}… isn't a wallet address on this network (script addresses can't be payees).`);
  if (new Set(f.payees).size !== f.payees.length) p.push("A payee is listed twice.");
  const exp = Date.parse(`${f.expires}T23:59:59Z`);
  if (!Number.isFinite(exp) || exp <= o.nowMs) p.push("Pick an expiry date in the future.");
  if (o.isNew) {
    if (!f.name.trim()) p.push("Name the agent.");
    if (!/^[0-9a-f]{56}$/.test(f.agentKey)) p.push("The agent key hash is 56 hex characters (cli/vault keys show agent).");
    else if (o.owners.includes(f.agentKey)) p.push("The agent key can't be an owner key.");
    if (toLovelace(f.fund) === undefined) p.push("Fund it with an ADA amount (0 for none).");
  }
  return p;
}

/**
 * The allowance after an edit: the ADA cap is replaced in place (so `spent` stays aligned with
 * `caps`), token caps are kept, and the period changes only when the owner picked one.
 */
export function editedDatum(
  al: AllowanceDatum,
  f: { perPayment: bigint; budget: bigint; period: bigint | undefined; payees: string[]; expiresAt: bigint; apps?: string[] },
  toAddress: (bech32: string) => PlutusAddress,
): AllowanceDatum {
  const lov = { policy: "", name: "", windowCap: f.budget, txCap: f.perPayment };
  const i = al.caps.findIndex((c) => c.policy === "" && c.name === "");
  const caps = i >= 0 ? al.caps.map((c, j) => (j === i ? lov : c)) : [...al.caps, lov];
  const spent = i >= 0 ? al.spent : [...al.spent, 0n];
  return { ...al, caps, spent, destinations: f.payees.map(toAddress), periodMs: f.period ?? al.periodMs, expiresAt: f.expiresAt, apps: f.apps ?? al.apps };
}

// --- creating a vault --------------------------------------------------------

/** `owners` are the other owners, as typed; the creator is always the first owner. */
/** `refScript`: park the vault's code on chain (locked for good) so each agent payment costs a little less. */
export type CreateForm = { name: string; owners: string[]; threshold: string; windowMin: "2" | "10" | "60"; fund: string; refScript: boolean };

/** A wallet's payment key hash from a key hash or a testnet wallet address; undefined for anything else. */
export function ownerKeyOf(s: string, net: "Preprod" | "Custom"): string | undefined {
  const t = s.trim();
  if (/^[0-9a-f]{56}$/.test(t)) return t;
  if (!t.startsWith("addr_test1")) return undefined;
  try {
    const p = toPlutusAddress(t, net).payment;
    return p.type === "Key" ? p.hash : undefined;
  } catch {
    return undefined;
  }
}

/** Why the owner being typed can't be added yet; undefined while empty or addable. */
export function ownerHint(s: string, listed: string[], me: string, net: "Preprod" | "Custom"): string | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const k = ownerKeyOf(t, net);
  if (!k) {
    if (/^addr1/.test(t)) return "That's a mainnet address. Use the owner's preprod (addr_test1…) address.";
    try {
      if (t.startsWith("addr_test1") && toPlutusAddress(t, net).payment.type === "Script") return "That's a script address. An owner is a person's wallet address or key hash.";
    } catch {
      // not an address at all
    }
    return "That isn't a wallet address (addr_test1…) or a 56-character key hash.";
  }
  if (k === me) return "That's you; you're already an owner.";
  if (listed.some((x) => ownerKeyOf(x, net) === k)) return "That owner is already listed.";
  return undefined;
}

export function createProblems(f: CreateForm, o: { me: string; net: "Preprod" | "Custom" }): string[] {
  const p: string[] = [];
  if (!f.name.trim()) p.push("Name the vault.");
  if (f.name.length > 80) p.push("Keep the name under 80 characters.");
  const keys = f.owners.map((s) => ownerKeyOf(s, o.net));
  f.owners.forEach((s, i) => {
    if (!keys[i]) p.push(`${s.slice(0, 20)}… isn't a wallet address or key hash on this network.`);
  });
  const all = [o.me, ...keys.filter((k): k is string => !!k)];
  if (new Set(all).size !== all.length) p.push("You're already an owner; list each other owner once.");
  const n = 1 + f.owners.length;
  if (n > MAX_OWNERS) p.push(`At most ${MAX_OWNERS} owners.`);
  const t = Number(f.threshold);
  if (!Number.isInteger(t) || t < 1 || t > n) p.push(`The threshold must be between 1 and ${n}.`);
  const fund = toLovelace(f.fund);
  if (fund === undefined || (fund > 0n && fund < 2_000_000n)) p.push("Fund the treasury with at least 2 ADA, or 0 for none.");
  return p;
}

/** The config to create; call only when createProblems finds nothing. */
export function createConfig(f: CreateForm, me: string, net: "Preprod" | "Custom"): ConfigDatum {
  return {
    owners: [me, ...f.owners.map((s) => ownerKeyOf(s, net)!)],
    threshold: BigInt(f.threshold),
    paused: false,
    maxTxValidityMs: BigInt(Number(f.windowMin) * 60_000),
    apps: [],
  };
}

/** A failed build, said plainly: the wallet libraries' messages aren't meant for people. */
export function buildError(message: string): string {
  const short = /not have enough funds[\s\S]*?"lovelace":\s*"(\d+)n?"/.exec(message);
  if (short) return `Your wallet is about ${ada(BigInt(short[1]!))} ADA short. Creating a vault takes about 2 ADA (about 30 with cheaper agent payments) plus what you put in the treasury; preprod's faucet gives test ADA.`;
  if (/pure-ADA UTxO/.test(message)) return "Your wallet needs some plain ADA (an output holding no tokens) to create a vault.";
  return message;
}

/** What createVault gets: the treasury deposit, the creator as signer, and the reference script only if asked for. */
export function createOptions(f: CreateForm, me: string, net: "Preprod" | "Custom"): { fund: bigint; signer: string; refScriptAddress?: string } {
  return { fund: toLovelace(f.fund) ?? 0n, signer: me, ...(f.refScript ? { refScriptAddress: refHolderAddress(net) } : {}) };
}

// --- the Minswap settings form (filled with suggested values; owners change any of them) ---

/** `scope` starts empty: owners choose "any" pool or "only" the picked ones. */
export type MinswapForm = { scope: "" | "any" | "only"; pools: string[]; slippage: string; fee: string; hours: string; tip: string };
type MinswapSettingsBig = { pools: "any" | string[]; maxSlippageBps: bigint; maxBatcherFee: bigint; maxOrderTtlMs: bigint; maxCancelTip: bigint };

const decimal = (n: bigint, unit: bigint) => {
  const whole = n / unit;
  const frac = (n % unit).toString().padStart(String(unit).length - 1, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};

/** Suggested settings for a first enable (the safer pool choice: only the listed pools), or the current settings when editing. */
export function minswapForm(current?: MinswapSettingsBig, listedPools: string[] = []): MinswapForm {
  if (!current) return { scope: "only", pools: listedPools, slippage: "1", fee: "2", hours: "24", tip: "0.5" };
  return {
    scope: current.pools === "any" ? "any" : "only",
    pools: current.pools === "any" ? [] : current.pools,
    slippage: decimal(current.maxSlippageBps, 100n),
    fee: decimal(current.maxBatcherFee, 1_000_000n),
    hours: decimal(current.maxOrderTtlMs, 3_600_000n),
    tip: decimal(current.maxCancelTip, 1_000_000n),
  };
}

const pctToBps = (s: string) => (/^\d{1,2}(\.\d{1,2})?$/.test(s.trim()) ? BigInt(Math.round(Number(s) * 100)) : undefined);
const hoursToMs = (s: string) => (/^\d{1,4}(\.\d{1,2})?$/.test(s.trim()) ? BigInt(Math.round(Number(s) * 3_600_000)) : undefined);

minswapForm.toSettings = (f: MinswapForm): MinswapSettingsBig => ({
  pools: f.scope === "any" ? "any" : f.pools,
  maxSlippageBps: pctToBps(f.slippage)!,
  maxBatcherFee: toLovelace(f.fee)!,
  maxOrderTtlMs: hoursToMs(f.hours)!,
  maxCancelTip: toLovelace(f.tip)!,
});

export function minswapProblems(f: MinswapForm): string[] {
  const p: string[] = [];
  if (!f.scope) p.push("Choose any pool or only the pools you pick.");
  if (f.scope === "only" && !f.pools.length) p.push("Pick at least one pool.");
  if (f.scope === "only" && f.pools.length > 8) p.push("At most 8 pools.");
  const bps = pctToBps(f.slippage);
  if (bps === undefined) p.push("Max slippage must be a percentage, e.g. 3.");
  else if (bps <= 0n) p.push("Max slippage must be more than 0%.");
  else if (bps > 2000n) p.push("Max slippage is at most 20%.");
  const fee = toLovelace(f.fee);
  if (fee === undefined) p.push("Max batcher fee must be an ADA amount.");
  else if (fee <= 0n) p.push("Max batcher fee must be more than 0 ADA.");
  const ttl = hoursToMs(f.hours);
  if (ttl === undefined) p.push("Order lifetime must be a number of hours.");
  else if (ttl <= 0n) p.push("Order lifetime must be more than 0 hours.");
  if (toLovelace(f.tip) === undefined) p.push("Cancel tip must be an ADA amount (0 is fine).");
  return p;
}

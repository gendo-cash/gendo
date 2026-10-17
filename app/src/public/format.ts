// app/src/public/format.ts
import type { AllowanceView, PaymentView } from "../../../sdk/src/read/index.ts";

export const parsePolicy = (path: string): string | undefined => /^\/w\/([0-9a-f]{56})\/?$/.exec(path)?.[1];

export function ada(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function periodName(ms: bigint): string {
  const units: [string, bigint][] = [["week", 604_800_000n], ["day", 86_400_000n], ["hour", 3_600_000n], ["minute", 60_000n], ["second", 1_000n]];
  for (const [name, u] of units) if (ms % u === 0n) return ms === u ? name : `${ms / u} ${name}s`;
  return `${ms} ms`;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function allowanceSentence(a: AllowanceView): string {
  if (a.status === "malformed") return "Malformed: the agent can't spend it, and owners can reclaim it.";
  const l = a.caps.find((c) => c.unit === "lovelace");
  const n = a.payees.length;
  const limits = l ? `up to ${ada(l.perPayment)} ADA at a time and ${ada(l.perPeriod)} ADA per ${periodName(a.periodMs!)}` : "nothing (no ADA limit is set)";
  const apps = (a.apps ?? []).map((x) => (x === "minswap" ? "Minswap" : x));
  const trades = apps.length ? ` It may also swap on ${apps.join(" and ")}, within the same limits.` : "";
  return `This agent can pay ${limits}, only to ${n === 1 ? "this address" : `these ${n} addresses`}, until ${date(a.expiresAt!)}.${trades}`;
}

const signedAda = (lovelace: bigint) => `${lovelace < 0n ? "-" : "+"}${ada(lovelace < 0n ? -lovelace : lovelace)}`;

/** A token's readable name from its unit: the asset name as text (CIP-68 label dropped), else a short id. */
export function tokenName(unit: string): string {
  if (unit === "lovelace") return "ADA";
  let hex = unit.slice(56);
  if (/^(000643b0|000de140|0014df10)/.test(hex)) hex = hex.slice(8);
  const bytes = hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
  return bytes.length && /^[\x20-\x7e]+$/.test(text) ? text : `${unit.slice(0, 8)}…${unit.slice(-4)}`;
}

/** An amount of a unit as people read it: ADA in ADA, tokens as raw quantities with their name. */
export const amountOf = (unit: string, q: bigint) => (unit === "lovelace" ? `${ada(q)} ADA` : `${q} ${tokenName(unit)}`);

/** One history row, from what the chain says (the redeemer, outputs and fee), never from the agent's note. */
export function paymentLine(p: PaymentView): string {
  if (p.kind === "trade" && p.trade) {
    const t = p.trade;
    const head = `Swap ${amountOf(t.sells, t.amountIn)} for at least ${amountOf(t.buys, t.minimumReceive)} on Minswap (${t.pool})`;
    if (t.status === "filled") return `${head}, filled: ${amountOf(t.buys, t.received?.[t.buys] ?? 0n)} to the treasury`;
    if (t.status === "refunded") return `${head}, refunded: ${amountOf(t.sells, t.received?.[t.sells] ?? 0n)} to the treasury`;
    return `${head}, ${t.status === "pending" ? "waiting for a batcher" : "status unknown"}`;
  }
  if (p.kind === "owner") return `Owner change: allowance ${signedAda(p.allowanceDelta)} ADA`;
  if (p.kind === "unknown") return `Allowance ${signedAda(p.allowanceDelta)} ADA`;
  const paid = p.payees.reduce((n, x) => n + x.lovelace, 0n);
  const who = p.kind === "agent" ? "paid by the agent within its limits" : "approved by owners";
  return `${ada(paid)} ADA to ${p.payees.length} ${p.payees.length === 1 ? "payee" : "payees"} + ${ada(p.fee)} ADA fee, ${who}`;
}

/** The agent's note is untrusted text: drop control and direction characters, cap its length. */
export function cleanPurpose(s: string): string {
  const t = s.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  return t.length > 120 ? t.slice(0, 120) + "…" : t;
}

/** How far off `ms` is from `now`, in the one unit a person reads at a glance. */
export function fromNow(ms: number, now: number): string {
  const d = ms - now;
  if (d <= 0) return "now";
  if (d < 60_000) return "in under a minute";
  if (d < 3_600_000) return `in ${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `in ${Math.floor(d / 3_600_000)} h`;
  const days = Math.floor(d / 86_400_000);
  return `in ${days} ${days === 1 ? "day" : "days"}`;
}

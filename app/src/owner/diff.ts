// What a pending tx does, as the inbox shows it: computed only from explainTx's output
// (the tx and hash-checked chain data). Server text never feeds these rows.
import type { AllowanceDatum, ConfigDatum, Explanation } from "../../../sdk/src/core/index.ts";
import { confirmWords } from "../../../sdk/src/core/pairing.ts";
import { ada, periodName } from "../public/format.ts";
import { appChanges } from "../../../sdk/src/core/explain.ts";
import { settingsFromData } from "../../../sdk/src/core/apps/minswap/data.ts";
import { poolByLp } from "../../../sdk/src/core/apps/catalogue.ts";

export type Row = { k: string; now: string; next: string; changed: boolean };
export type Detail = { kind: "Change" | "Agent request"; title: string; summary: string; rows: Row[]; before?: string; after?: string; money: { label: string; value: string }[]; warnings: string[] };
export type Ctx = {
  viewer: string;
  /** The vault's own address: the only address whose funds are the vault's. */
  vaultAddress: string;
  /** Where a new vault parks its reference script (always-fail: locked for good). */
  refHolder?: string;
  /** A key's own (enterprise) address: where a new agent's collateral goes. */
  agentAddress?: (pkh: string) => string;
  labels: Record<string, string>;
  payeesOf: (d: AllowanceDatum) => string[];
  isMine: (address: string) => boolean;
  /** For titles only; review rows always show addresses and keys in full. */
  short: (s: string) => string;
  recipe?: { intentId?: string; purpose?: string; reason?: string } | null;
  /** The catalogue's adapter and order script per app on this network: anything else gets a warning. */
  appScripts?: Record<string, { adapter: string; orderScript: string }>;
};

const lov = (d: AllowanceDatum) => d.caps.find((c) => c.policy === "" && c.name === "");
const day = (ms: bigint) => new Date(Number(ms)).toISOString().slice(0, 10);
const qty = (q: Record<string, bigint>) => {
  const tokens = Object.entries(q).filter(([u, n]) => u !== "lovelace" && n !== 0n).length;
  return `${ada(q.lovelace ?? 0n)} ADA${tokens ? ` and ${tokens} token type${tokens === 1 ? "" : "s"}` : ""}`;
};

export function sentence(d: AllowanceDatum, payees: number): string {
  const c = lov(d);
  const lim = c ? `up to ${ada(c.txCap)} ADA at a time and ${ada(c.windowCap)} ADA per ${periodName(d.periodMs)}` : "nothing in ADA (no ADA limit is set)";
  return `This agent can pay ${lim}, only to ${payees === 1 ? "this address" : `these ${payees} addresses`}, until ${day(d.expiresAt)}.`;
}

function allowanceRows(a: AllowanceDatum | null, b: AllowanceDatum | null, ctx: Ctx): Row[] {
  const v = (d: AllowanceDatum | null, f: (d: AllowanceDatum) => string) => (d ? f(d) : "—");
  const pa = a ? ctx.payeesOf(a) : [];
  const pb = b ? ctx.payeesOf(b) : [];
  const rows: Row[] = [
    ["Per payment", (d: AllowanceDatum) => (lov(d) ? `${ada(lov(d)!.txCap)} ADA` : "—")],
    ["Budget", (d: AllowanceDatum) => (lov(d) ? `${ada(lov(d)!.windowCap)} ADA / ${periodName(d.periodMs)}` : "—")],
    ["Payees", (d: AllowanceDatum) => String(ctx.payeesOf(d).length)],
    ["Expires", (d: AllowanceDatum) => day(d.expiresAt)],
    ["Max fee", (d: AllowanceDatum) => `${ada(d.maxFee)} ADA`],
    ["Agent key", (d: AllowanceDatum) => `${confirmWords(d.agent)} (${d.agent})`],
    ["Apps", (d: AllowanceDatum) => (d.apps.length ? d.apps.map(appTitle).join(", ") : "none")],
  ].map(([k, f]) => {
    const now = v(a, f as (d: AllowanceDatum) => string);
    const next = v(b, f as (d: AllowanceDatum) => string);
    return { k: k as string, now, next, changed: now !== next };
  });
  for (const x of pb.filter((x) => !pa.includes(x))) rows.push({ k: "Payee added", now: "—", next: x, changed: true });
  for (const x of pa.filter((x) => !pb.includes(x))) rows.push({ k: "Payee removed", now: x, next: "—", changed: true });
  return rows;
}

const appTitle = (name: string) => (name === "minswap" ? "Minswap" : name);
const hours = (ms: bigint) => (ms % 3_600_000n === 0n ? `${ms / 3_600_000n} h` : `${Number(ms) / 60_000} min`);

/** An app's settings as rows ("Minswap max slippage" …), decoded from the config: never from server text. */
function appFields(app: { name: string; settings: string; adapter: string; orderScript: string } | undefined): Record<string, string> {
  if (!app) return {};
  // The scripts first: an adapter swap changes what the chain checks, so it must never hide behind unchanged settings.
  const scripts = { adapter: app.adapter, "order script": app.orderScript };
  try {
    const s = settingsFromData(app.settings);
    return {
      ...scripts,
      pools: s.pools === "any" ? "any Minswap pool" : s.pools.map((lp) => poolByLp(lp)?.pool.label ?? lp).join(", "),
      "max slippage": `${Number(s.maxSlippageBps) / 100}%`,
      "max batcher fee": `${ada(s.maxBatcherFee)} ADA`,
      "order lifetime": hours(s.maxOrderTtlMs),
      "cancel tip": `${ada(s.maxCancelTip)} ADA`,
    };
  } catch {
    return { ...scripts, settings: "unreadable (every order would be refused)" };
  }
}

function appRows(a: ConfigDatum | null, b: ConfigDatum | null): Row[] {
  const names = [...new Set([...(a?.apps ?? []), ...(b?.apps ?? [])].map((x) => x.name))];
  return names.flatMap((name) => {
    const before = appFields(a?.apps.find((x) => x.name === name));
    const after = appFields(b?.apps.find((x) => x.name === name));
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys
      .map((k) => ({ k: `${appTitle(name)} ${k}`, now: before[k] ?? "—", next: after[k] ?? "—", changed: (before[k] ?? "—") !== (after[k] ?? "—") }))
      .filter((r) => r.changed || (a && b));
  });
}

function configRows(a: ConfigDatum | null, b: ConfigDatum | null, ctx: Ctx): Row[] {
  const f = (c: ConfigDatum | null, g: (c: ConfigDatum) => string) => (c ? g(c) : "—");
  const rows: Row[] = [
    ["Paused", (c: ConfigDatum) => (c.paused ? "yes" : "no")],
    ["Threshold", (c: ConfigDatum) => `${c.threshold} of ${c.owners.length}`],
    ["Max tx validity", (c: ConfigDatum) => `${Number(c.maxTxValidityMs) / 60_000} min`],
  ].map(([k, g]) => {
    const now = f(a, g as (c: ConfigDatum) => string);
    const next = f(b, g as (c: ConfigDatum) => string);
    return { k: k as string, now, next, changed: now !== next };
  });
  const oa = a?.owners ?? [];
  const ob = b?.owners ?? [];
  for (const o of ob.filter((o) => !oa.includes(o))) rows.push({ k: "Owner added", now: "—", next: o, changed: true });
  for (const o of oa.filter((o) => !ob.includes(o))) rows.push({ k: "Owner removed", now: o, next: "—", changed: true });
  rows.push(...appRows(a, b));
  return rows;
}

export function detailOf(e: Explanation, ctx: Ctx): Detail {
  const name = (unit: string) => ctx.labels[unit] ?? `agent ${ctx.short(unit.slice(56))}`;
  const money: Detail["money"] = [];
  if (Object.keys(e.leavesVault).length) money.push({ label: "Leaves the vault", value: qty(e.leavesVault) });
  const isVault = (a: string) => a === ctx.vaultAddress;
  const granted = e.changes.find((c) => c.kind === "grant");
  const agentAddr = granted?.kind === "grant" && granted.after ? ctx.agentAddress?.(granted.after.agent) : undefined;
  const labelOf = (a: string) =>
    a === ctx.refHolder ? "Reference script (locked for good; it lowers every agent payment's fee)"
      : a === agentAddr ? "Collateral for the agent (stays in its own address)"
      : `To ${a}`;
  for (const f of e.flows)
    if (!ctx.isMine(f.address) && !isVault(f.address) && (f.delta.lovelace ?? 0n) > 0n) money.push({ label: labelOf(f.address), value: qty(f.delta) });
  const intoVault = e.flows.find((f) => isVault(f.address))?.delta.lovelace ?? 0n;
  if (intoVault > 0n) money.push({ label: "Into the vault", value: `${ada(intoVault)} ADA` });
  const mine = e.flows.filter((f) => ctx.isMine(f.address)).reduce((n, f) => n - (f.delta.lovelace ?? 0n), 0n);
  if (mine > 0n) money.push({ label: "From your wallet", value: `${ada(mine)} ADA` });
  // An app whose adapter or order script isn't the catalogue's: the chain would trust whatever that script allows.
  const appWarnings = e.changes.flatMap((c) =>
    c.kind === "config" && c.after
      ? c.after.apps.flatMap((a) => {
          const want = ctx.appScripts?.[a.name];
          if (!want) return [];
          const w: string[] = [];
          if (a.adapter !== want.adapter) w.push(`the ${appTitle(a.name)} adapter isn't the one gendo's catalogue lists for this network: the chain would trust whatever that script allows`);
          if (a.orderScript !== want.orderScript) w.push(`the ${appTitle(a.name)} order script isn't the one gendo's catalogue lists for this network`);
          return w;
        })
      : [],
  );
  const out = (d: Omit<Detail, "money" | "warnings">): Detail => ({ ...d, money, warnings: [...e.warnings, ...appWarnings] });

  const spend = e.changes.find((c) => c.kind === "spend");
  if (spend && spend.kind === "spend") {
    const cap = spend.before && lov(spend.before);
    const paid = e.flows.filter((f) => !isVault(f.address) && (f.delta.lovelace ?? 0n) > 0n);
    const amount = paid.reduce((n, f) => n + (f.delta.lovelace ?? 0n), 0n);
    const over = cap ? amount > cap.txCap : false;
    const rows: Row[] = [
      ...paid.map((f) => ({ k: "Payee", now: f.address, next: spend.before && ctx.payeesOf(spend.before).includes(f.address) ? "approved payee" : "not on the agent's list", changed: false })),
      { k: "Amount", now: `${ada(amount)} ADA`, next: over && cap ? `over the ${ada(cap.txCap)} ADA cap` : "within the per-payment cap", changed: over },
      { k: "Fee", now: `${ada(e.fee)} ADA`, next: "from the allowance", changed: false },
    ];
    if (ctx.recipe?.purpose) rows.push({ k: "Agent's purpose (not verified)", now: ctx.recipe.purpose, next: "", changed: false });
    if (ctx.recipe?.reason) rows.push({ k: "Agent's reason (not verified)", now: ctx.recipe.reason, next: "", changed: false });
    if (ctx.recipe?.intentId) rows.push({ k: "Intent", now: ctx.recipe.intentId, next: "", changed: false });
    return out({
      kind: "Agent request",
      title: `${name(spend.unit)} wants to pay ${ada(amount)} ADA`,
      summary: `${name(spend.unit)} asks to pay ${ada(amount)} ADA to ${paid.length === 1 ? ctx.short(paid[0]!.address) : `${paid.length} payees`}.${over && cap ? ` That's over its ${ada(cap.txCap)} ADA per-payment cap, so it needs the owners.` : ""}`,
      rows,
    });
  }
  const cfg = e.changes.find((c) => c.kind === "config");
  if (cfg && cfg.kind === "config" && !cfg.before && cfg.after) {
    const c = cfg.after;
    // What goes into a new vault is two things: the ADA held with its settings, and the treasury.
    const deposit = cfg.deposit ?? 0n;
    const i = money.findIndex((m) => m.label === "Into the vault");
    if (i >= 0) money.splice(i, 1);
    money.push({ label: "Vault settings deposit (stays with the vault)", value: `${ada(deposit)} ADA` });
    if (intoVault > deposit) money.push({ label: "Into the treasury", value: `${ada(intoVault - deposit)} ADA` });
    return out({ kind: "Change", title: "Create this vault", summary: `Creates a vault with ${c.owners.length} owner${c.owners.length === 1 ? "" : "s"}. Any ${c.threshold} of them approve changes; any one can pause.`, rows: configRows(null, c, ctx) });
  }
  if (cfg && cfg.kind === "config") {
    const a = cfg.before, b = cfg.after;
    const apps = appChanges(a, b);
    const appTitleOf = apps.added.length === 1 && !apps.removed.length && !apps.changed.length ? `Enable ${appTitle(apps.added[0]!.name)}`
      : apps.removed.length === 1 && !apps.added.length && !apps.changed.length ? `Disable ${appTitle(apps.removed[0]!)}`
      : apps.changed.length === 1 && !apps.added.length && !apps.removed.length ? `Change ${appTitle(apps.changed[0]!.name)} settings` : undefined;
    if (appTitleOf && a && b && a.paused === b.paused && a.threshold === b.threshold && a.owners.join() === b.owners.join())
      return out({ kind: "Change", title: appTitleOf, summary: appTitleOf.startsWith("Disable") ? `${appTitleOf}: agents can no longer trade with it. Orders already placed still settle or expire back to the vault.` : `${appTitleOf}. Agents trade with it only if their budget allows it, and only within these rules.`, rows: configRows(a, b, ctx) });
    const title = a && b && a.paused !== b.paused && a.threshold === b.threshold && a.owners.join() === b.owners.join()
      ? (b.paused ? "Pause all agents" : "Unpause")
      : a && b && (a.threshold !== b.threshold || a.owners.join() !== b.owners.join()) ? "Change owners or threshold" : "Change vault settings";
    return out({ kind: "Change", title, summary: title === "Pause all agents" ? "Stop every agent from paying. One owner can do this alone; unpausing needs the threshold." : `${title}.`, rows: configRows(a, b, ctx) });
  }
  const edit = e.changes.find((c) => c.kind === "edit");
  if (edit && edit.kind === "edit") {
    const rows = allowanceRows(edit.before, edit.after, ctx);
    if (edit.lovelaceBefore !== edit.lovelaceAfter) rows.push({ k: "Funds", now: `${ada(edit.lovelaceBefore)} ADA`, next: `${ada(edit.lovelaceAfter)} ADA`, changed: true });
    const changed = rows.filter((r) => r.changed).map((r) => r.k.toLowerCase());
    return out({
      kind: "Change", title: `Change ${name(edit.unit)}`, summary: changed.length ? `Changes ${changed.join(", ")} for ${name(edit.unit)}. Nothing else changes.` : "Rewrites the allowance with the same limits.", rows,
      ...(edit.before ? { before: sentence(edit.before, ctx.payeesOf(edit.before).length) } : {}),
      ...(edit.after ? { after: sentence(edit.after, ctx.payeesOf(edit.after).length) } : {}),
    });
  }
  const grant = e.changes.find((c) => c.kind === "grant");
  if (grant && grant.kind === "grant") {
    const rows = allowanceRows(null, grant.after, ctx);
    rows.push({ k: "Funds", now: "—", next: `${ada(grant.lovelace)} ADA`, changed: true });
    return out({ kind: "Change", title: `Add ${name(grant.unit)}`, summary: `Adds an agent with ${ada(grant.lovelace)} ADA from the treasury.`, rows, ...(grant.after ? { after: sentence(grant.after, ctx.payeesOf(grant.after).length) } : {}) });
  }
  const revoke = e.changes.find((c) => c.kind === "revoke");
  if (revoke && revoke.kind === "revoke")
    return out({ kind: "Change", title: `Revoke ${name(revoke.unit)}`, summary: `Revokes ${name(revoke.unit)}: it can no longer pay. Its ${ada(revoke.lovelace)} ADA goes back to the treasury.`, rows: [{ k: name(revoke.unit), now: "active", next: "revoked", changed: true }] });
  if (Object.keys(e.leavesVault).length) return out({ kind: "Change", title: "Pay from the treasury", summary: `Pays ${qty(e.leavesVault)} out of the treasury.`, rows: [] });
  return out({ kind: "Change", title: e.flows.some((f) => isVault(f.address) && (f.delta.lovelace ?? 0n) > 0n) ? "Fund the treasury" : "Transaction", summary: "Moves no vault funds out.", rows: [] });
}

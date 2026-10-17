import { useEffect, useState } from "react";
import { allowanceHistory, readVault, type Get, type PaymentView, type ReadNetwork, type VaultView } from "../../../sdk/src/read/index.ts";
import { minswapSettingsFromCbor } from "../../../sdk/src/read/decode.ts";
import { poolByLp } from "../../../sdk/src/core/apps/catalogue.ts";
import { Avatar, Chain, Mark, Netband, Spinner } from "../ui/Brand.tsx";
import { ada, amountOf, allowanceSentence, cleanPurpose, fromNow, paymentLine, periodName } from "./format.ts";

const get: Get = async (path) => {
  let r: Response;
  try {
    r = await fetch(`/chain${path}`);
  } catch {
    throw new Error("The chain is unavailable right now. Try again in a minute.");
  }
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error("The chain is unavailable right now. Try again in a minute.");
  return r.json();
};
const short = (s: string) => (s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s);

type Ready = { phase: "ready"; vault: VaultView; name?: string; listed: boolean; labels: Record<string, string>; history: (PaymentView & { unit: string })[]; tipMs: number };
type State = { phase: "loading" } | { phase: "error"; message: string } | { phase: "missing" } | Ready;

export function PublicPage({ policy, network }: { policy: string; network: ReadNetwork }) {
  const [s, setS] = useState<State>({ phase: "loading" });
  useEffect(() => {
    (async () => {
      const tip = (await get("/blocks/latest")) as { time: number } | undefined;
      const tipMs = tip ? tip.time * 1000 : Date.now();
      const vault = await readVault(get, policy, network, tipMs);
      if (!vault) return setS({ phase: "missing" });
      const listing = await fetch(`/public/${policy}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ name: string; listed: boolean; agents: Record<string, string> }>) : undefined))
        .catch(() => undefined);
      const history = (
        await Promise.all(
          vault.allowances.filter((a) => a.status !== "malformed").map(async (a) => (await allowanceHistory(get, a.unit, vault.address, a.txHash)).map((p) => ({ ...p, unit: a.unit }))),
        )
      ).flat().sort((a, b) => b.time - a.time);
      setS({ phase: "ready", vault, name: listing?.name, listed: listing?.listed === true, labels: listing?.agents ?? {}, history, tipMs });
    })().catch((e) => setS({ phase: "error", message: (e as Error).message }));
  }, [policy, network]);

  useEffect(() => {
    if (s.phase !== "ready" || !s.listed) return;
    const m = document.querySelector('meta[name="robots"]');
    m?.remove();
    return () => void (m && document.head.append(m));
  }, [s]);

  const frame = (body: React.ReactNode, attr: Record<string, string> = {}) => (
    <div className="app" {...attr}>
      <Netband />
      <header className="top" style={{ background: "#0f0d0a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Mark />
          <span style={{ fontWeight: 900, fontSize: 15 }}>gendo</span>
          <span className="faint pub-path">/</span>
          <span className="mono pub-path" style={{ fontSize: 13 }}>w/{short(policy)}</span>
        </div>
        <a className="btn pri" href="/">Connect wallet</a>
      </header>
      {body}
    </div>
  );
  if (s.phase === "loading") return frame(<main className="boot"><Spinner label="Reading the chain…" /></main>);
  if (s.phase === "error") return frame(<main style={{ padding: 20 }}><p>{s.message}</p></main>, { "data-error": "" });
  if (s.phase === "missing") return frame(<main style={{ padding: 20 }}><h1>No vault found</h1><p className="muted">Nothing lives at this vault id on preprod.</p></main>, { "data-ready": "" });

  const { vault, history } = s;
  const cfg = vault.config;
  const week = history.filter((p) => p.time > s.tipMs - 7 * 86_400_000 && (p.kind === "agent" || p.kind === "co-signed"));
  const paidWeek = week.reduce((n, p) => n + p.payees.reduce((m, x) => m + x.lovelace, 0n), 0n);
  const active = vault.allowances.filter((a) => a.status === "active").length;
  const nameOf = (unit: string) => s.labels[unit] ?? `Agent ${short(unit.slice(56))}`;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return frame(
    <>
      {cfg?.paused && <div className="banner">Paused. No agent can pay until {String(cfg.threshold)} of {cfg.owners.length} owners unpause.</div>}
      <main className="doc">
        <header className="doc-head">
          <h1>{s.name ?? "A gendo vault"}</h1>
          <p className="doc-lede">
            {cfg?.paused && <><b className="seal">Paused.</b>{" "}</>}
            It holds <b className="mono">{ada(vault.treasuryLovelace)} ADA</b>{tokensLine(vault.treasury)}.{" "}
            {active === 0 ? "No agent can pay from it right now." : <><b>{plural(active, "agent", "agents")}</b> may pay from it, only within the limits written below.</>}{" "}
            {cfg && <>Any change needs owners' seals: <b>{cfg.threshold} of {cfg.owners.length} must sign</b>.</>}{" "}
            In the last 7 days its agents paid <b className="mono">{ada(paidWeek)} ADA</b> in {plural(week.length, "payment", "payments")}.
            {appsLine(cfg?.apps ?? [])}
          </p>
          <p className="doc-ids">
            <span>Address <Chain value={vault.address} network={network} label={short(vault.address)} /></span>
          </p>
        </header>

        <section className="doc-sec">
          <h2>Agents</h2>
          {vault.allowances.length === 0 ? (
            <p className="faint">No agents yet.</p>
          ) : (
            vault.allowances.map((a) => {
              const l = a.caps.find((c) => c.unit === "lovelace");
              const pct = l && l.perPeriod > 0n ? Number((l.spentThisPeriod * 100n) / l.perPeriod) : 0;
              const status = a.status === "active" && cfg?.paused ? "paused" : a.status;
              return (
                <article key={a.unit} className="mandate">
                  <Avatar id={a.unit} kind="agent" size={32} />
                  <div className="mandate-body">
                    <h3>{nameOf(a.unit)}{status !== "active" && <span className="seal"> {status}</span>}</h3>
                    <p>{allowanceSentence(a)}</p>
                    {l && a.status === "active" && (
                      <div className="meter">
                        <div className="bar" role="img" aria-label={`${ada(l.spentThisPeriod)} of ${ada(l.perPeriod)} ADA spent`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
                        <span className="faint"><span className="mono">{ada(l.spentThisPeriod)}</span> of <span className="mono">{ada(l.perPeriod)}</span> ADA used this {periodName(a.periodMs!)}; <span className="mono">{ada(l.leftThisPeriod)}</span> left{a.periodEndsAt ? `, resets ${fromNow(a.periodEndsAt, s.tipMs)}` : ""}.</span>
                      </div>
                    )}
                    {a.payees.length > 0 && <p className="faint small">{a.payees.length === 1 ? "Payee" : "Payees"}: {a.payees.map((x, i) => <span key={x}>{i > 0 && ", "}<Chain value={x} network={network} label={short(x)} /></span>)}</p>}
                  </div>
                </article>
              );
            })
          )}
        </section>

        <section className="doc-sec">
          <h2>Payments</h2>
          {history.length === 0 ? (
            <p className="faint">No payments yet.</p>
          ) : (
            <ol className="ledger">
              {history.map((p) => {
                const paid = p.payees.reduce((n, x) => n + x.lovelace, 0n);
                const spend = p.kind === "agent" || p.kind === "co-signed";
                const note = p.purpose ? cleanPurpose(p.purpose) : "";
                return (
                  <li key={p.txHash + p.unit} className={spend || p.trade ? "" : "quiet"}>
                    <span className="mono ledger-date">{new Date(p.time).toISOString().slice(0, 10)}</span>
                    <span className="ledger-what">
                      {s.labels[p.unit] ? `${s.labels[p.unit]}: ` : ""}{paymentLine(p)}.
                      {p.payees.length > 0 && <span className="faint small"> To {p.payees.map((x, i) => <span key={i}>{i > 0 && ", "}<Chain value={x.address} network={network} label={short(x.address)} /></span>)}.</span>}
                      {note && <span className="ledger-note">The agent's note (not verified): {note}</span>}
                      <span className="faint small">Transaction <Chain value={p.txHash} network={network} label={short(p.txHash)} /></span>
                    </span>
                    <span className="mono ledger-amt">{spend ? `${ada(paid)} ADA` : p.trade ? amountOf(p.trade.sells, p.trade.amountIn) : ""}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {cfg && (
          <section className="doc-sec">
            <h2>Owners</h2>
            <p className="faint">Every change to this vault needs {cfg.threshold} of these {cfg.owners.length} seals.</p>
            <ul className="seals">
              {cfg.owners.map((o) => <li key={o}><span className="stamp" aria-hidden="true">印</span><span className="mono">key {short(o)}</span></li>)}
            </ul>
          </section>
        )}

        <footer className="doc-foot">
          <p>How to read this: the limits are part of the vault's code, checked on every payment, so a payment that breaks them can't land. Amounts, payees and fees come from the chain and link to a public explorer. An agent's note is only its own claim. This page reads the chain; it can't move anything.</p>
        </footer>
      </main>
    </>,
    { "data-ready": "" },
  );
}

/** Tokens in the treasury (swap proceeds), after its ADA: ", and 9700000 NACRE". */
function tokensLine(t: Record<string, bigint>): string {
  const tokens = Object.entries(t).filter(([u, q]) => u !== "lovelace" && q > 0n).map(([u, q]) => amountOf(u, q));
  return tokens.length ? ` and ${tokens.join(", ")}` : "";
}

/** The vault's apps and the rule people care about most: " Agents it allows may swap on Minswap (ADA ↔ NACRE), never more than 3% below the pool's price." */
function appsLine(apps: { name: string; settings: string }[]): string {
  const parts = apps.flatMap((a) => {
    const s = a.name === "minswap" ? minswapSettingsFromCbor(a.settings) : null;
    if (!s) return [];
    const pools = s.pools.map((lp) => poolByLp(lp)?.pool.label ?? `${lp.slice(0, 8)}…`).join(", ");
    return [`on Minswap (${pools}), never more than ${Number(s.maxSlippageBps) / 100}% below the pool's price`];
  });
  return parts.length ? ` Agents it allows may swap ${parts.join("; ")}.` : "";
}

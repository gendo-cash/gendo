// The vault's DeFi apps: what the catalogue offers, what this vault enabled and with which rules.
// Enabling or changing an app is a vault settings change: proposed here, signed by the threshold.
import { AppLogo } from "../../ui/apps.tsx";
import { useState } from "react";
import { catalogue, type CatalogueApp } from "../../../../sdk/src/core/apps/catalogue.ts";
import { minswapAdapter } from "../../../../sdk/src/core/apps/minswap/adapter.ts";
import { settingsFromData } from "../../../../sdk/src/core/apps/minswap/data.ts";
import type { ConfigDatum } from "../../../../sdk/src/core/index.ts";
import type { Recipe } from "../recipes.ts";
import { ErrorNote, Link, Signers, defaultSigners, useOwner } from "../ui.tsx";
import { navigate } from "../../route.ts";
import { minswapForm, minswapProblems, type MinswapForm } from "../validate.ts";
import { ada } from "../../public/format.ts";

export function AppsTab({ policy, cfg, busy, onPropose, app }: { policy: string; cfg: ConfigDatum; busy: boolean; onPropose(r: Recipe, done: string): void; app?: string }) {
  const o = useOwner();
  const apps = catalogue().filter((a) => a.networks[o.net as "Preprod" | "Custom"]);
  if (app) {
    const a = apps.find((x) => x.name === app);
    return (
      <>
        <span style={{ fontSize: 13 }}><Link to={`/v/${policy}/apps`} className="faint">← All apps</Link></span>
        {a ? <AppCard key={a.name} policy={policy} app={a} cfg={cfg} busy={busy} onPropose={onPropose} /> : <p className="muted">No app called {app} on this network.</p>}
      </>
    );
  }
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>Apps let agents do more than pay: trade inside their budget, through code the chain checks on every order. An app does nothing until you enable it here and allow it for an agent in its budget.</p>
      {[
        { title: "Enabled on this vault", list: apps.filter((a) => cfg.apps.some((x) => x.name === a.name)) },
        { title: "Available", list: apps.filter((a) => !cfg.apps.some((x) => x.name === a.name)) },
      ].filter((g) => g.list.length).map((g) => (
        <section key={g.title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="cap">{g.title}</span>
          <div className="appgrid">
            {g.list.map((a) => {
              const on = g.title !== "Available";
              return (
                <Link key={a.name} to={`/v/${policy}/apps/${a.name}/settings`} className={on ? "apptile on" : "apptile"}>
                  <AppLogo name={a.name} size={48} />
                  <span className="apptitle">{a.title}</span>
                  {on && <span className="sr">Enabled</span>}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
      {!apps.length && <p className="muted">No apps are available on this network yet.</p>}
      <span className="faint" style={{ fontSize: 12 }}>Something missing? Apps are added to gendo's catalogue by pull request, after review and an audit of their adapter.</span>
    </>
  );
}

function AppCard({ policy, app, cfg, busy, onPropose }: { policy: string; app: CatalogueApp; cfg: ConfigDatum; busy: boolean; onPropose(r: Recipe, done: string): void }) {
  const o = useOwner();
  const network = app.networks[o.net as "Preprod" | "Custom"]!;
  const enabled = cfg.apps.find((x) => x.name === app.name);
  const current = (() => {
    try {
      return enabled ? settingsFromData(enabled.settings) : undefined;
    } catch {
      return undefined;
    }
  })();
  const outdated = enabled && enabled.adapter !== minswapAdapter(o.net).hash;
  const threshold = Number(cfg.threshold);
  const listed = network.pools.map((p) => p.lpName);
  // Not enabled yet: the form is the page, filled with suggested values.
  const [editing, setEditing] = useState(!enabled);
  const [f, setF] = useState<MinswapForm>(() => minswapForm(current, listed));
  const [signers, setSigners] = useState<string[]>(() => defaultSigners(cfg.owners, threshold, o.me.pkh));
  const [tried, setTried] = useState(false);
  const problems = minswapProblems(f);
  const label = (lp: string) => network.pools.find((p) => p.lpName === lp)?.label ?? `${lp.slice(0, 8)}…`;
  const help = (field: string) => app.settings.find((s) => s.field === field)?.help;
  const start = () => {
    setF(minswapForm(current, listed));
    setTried(false);
    setEditing(true);
  };
  const submit = () => {
    setTried(true);
    if (problems.length || signers.length !== threshold) return;
    onPropose({ op: "apps", action: enabled ? "update" : "enable", name: "minswap", settings: minswapForm.toSettings(f), signers }, enabled ? "Settings change proposed." : `${app.title} proposed.`);
    setEditing(false);
  };
  // Placeholders only: a suggestion shown in grey. Fields stay empty until the owner types a value.
  const field = (id: keyof MinswapForm, name: string, unit: string, helpOf: string, suggested: string) => (
    <div className="field">
      <label htmlFor={`ms-${id}`}>{name}</label>
      <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id={`ms-${id}`} inputMode="decimal" value={f[id] as string} placeholder={suggested} onChange={(e) => setF({ ...f, [id]: e.target.value })} style={{ width: 120 }} />
        <span className="faint">{unit}</span>
      </span>
      <span className="hint">{help(helpOf)}</span>
    </div>
  );
  return (
    <section className="panel">
      <div className="ph">
        <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}><AppLogo name={app.name} size={22} />{app.title}</h2>
        <span className="cap">{enabled ? "Enabled" : "Not enabled"}</span>
      </div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <span>{app.summary}</span>
        <span className="faint" style={{ fontSize: 12 }}>
          Audited by {app.audits.map((x, i) => <span key={x.by}>{i > 0 && ", "}<a href={x.url} target="_blank" rel="noopener noreferrer">{x.by}</a></span>)}. <a href={app.website} target="_blank" rel="noopener noreferrer">{app.website.replace(/^https:\/\//, "")}</a>
        </span>
        {outdated && <ErrorNote error="This vault uses an older version of this app's adapter. Change its settings to move to the current one." />}
      </div>
      {enabled && current && !editing && (
        <>
          <div className="kvrow"><span>Pools</span><span>{current.pools === "any" ? "Any Minswap pool" : current.pools.map(label).join(", ")}</span></div>
          <div className="kvrow"><span>Max slippage</span><span>{Number(current.maxSlippageBps) / 100}%</span></div>
          <div className="kvrow"><span>Max batcher fee</span><span>{ada(current.maxBatcherFee)} ADA</span></div>
          <div className="kvrow"><span>Order lifetime</span><span>{Number(current.maxOrderTtlMs) / 3_600_000} h</span></div>
          <div className="kvrow"><span>Cancel tip</span><span>{ada(current.maxCancelTip)} ADA</span></div>
        </>
      )}
      {!editing && (
        <div style={{ padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className={enabled ? "btn" : "btn pri"} disabled={busy} onClick={start}>{enabled ? "Change settings" : `Enable ${app.title}`}</button>
          {enabled && <button type="button" className="btn stop" disabled={busy || signers.length !== threshold} onClick={() => onPropose({ op: "apps", action: "disable", name: "minswap", signers }, `${app.title} disable proposed.`)}>Disable</button>}
        </div>
      )}
      {editing && (
        <>
          <div className="field">
            <label>Pools</label>
            <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", padding: 0 }}>
                <input type="radio" name="ms-scope" checked={f.scope === "any"} onChange={() => setF({ ...f, scope: "any" })} />
                Any Minswap pool
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", padding: 0 }}>
                <input type="radio" name="ms-scope" checked={f.scope === "only"} onChange={() => setF({ ...f, scope: "only" })} />
                Only these pools
              </label>
              {f.scope === "only" && network.pools.map((p) => (
                <label key={p.lpName} style={{ display: "flex", gap: 8, alignItems: "center", padding: "0 0 0 24px" }}>
                  <input type="checkbox" checked={f.pools.includes(p.lpName)} onChange={(e) => setF({ ...f, pools: e.target.checked ? [...f.pools, p.lpName] : f.pools.filter((x) => x !== p.lpName) })} />
                  {p.label}
                </label>
              ))}
              {f.scope === "any" && <ErrorNote error="A hijacked agent could lose up to its budget to a pool with a rigged price: the price floor reads that pool's own price." />}
            </span>
            <span className="hint">{help("pools")}</span>
          </div>
          {field("slippage", "Max slippage", "%", "maxSlippageBps", "1")}
          {field("fee", "Max batcher fee", "ADA", "maxBatcherFee", "2")}
          {field("hours", "Order lifetime", "hours", "maxOrderTtlMs", "24")}
          {field("tip", "Cancel tip", "ADA", "maxCancelTip", "0.5")}
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <Signers owners={cfg.owners} threshold={threshold} me={o.me.pkh} value={signers} onChange={setSigners} />
            {tried && problems.map((p) => <ErrorNote key={p} error={p} />)}
            <span style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn pri" disabled={busy} onClick={submit}>Review and propose</button>
              <button type="button" className="btn" onClick={() => (enabled ? setEditing(false) : navigate(`/v/${policy}/apps`))}>Cancel</button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}

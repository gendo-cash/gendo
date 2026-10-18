import { versionNote } from "../install.ts";
import { useEffect, useState } from "react";
import { allowanceHistory } from "../../../../sdk/src/read/index.ts";
import { ada, allowanceSentence, cleanPurpose, paymentLine, tokenName } from "../../public/format.ts";
import { navigate } from "../../route.ts";
import { api } from "../api.ts";
import { chainGet, readLight, vaultOf } from "../chain.ts";
import { decodeRecipe, encodeRecipe, titleOf, type Recipe } from "../recipes.ts";
import { prepare, useReview } from "../review.tsx";
import { toLovelace } from "../validate.ts";
import { Copy, ErrorNote, Link, Shell, Signers, defaultSigners, short, useLoad, useOwner, usePoll } from "../ui.tsx";
import { Avatar, Chain, Spinner } from "../../ui/Brand.tsx";
import { inFlight } from "../status.ts";
import { AppsTab } from "./Apps.tsx";
import { OldVaultPage } from "./OldVault.tsx";
import { partialSign } from "../wallet.ts";

export function VaultPage({ policy, tab }: { policy: string; tab: "agents" | "activity" | "treasury" | "apps" | "settings" }) {
  const o = useOwner();
  const mine = o.vaults.find((v) => v.policy === policy);
  const data = useLoad(async () => {
    const [view, listing, pending, versions] = await Promise.all([readLight(policy, o.net), api.listing(policy), api.pendingOf(policy), api.agentVersions(policy).catch(() => undefined)]);
    return { view, labels: listing?.agents ?? {}, listing, pending, versions };
  }, [policy]);
  const review = useReview(o.net);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<string>();
  const [signers, setSigners] = useState<string[]>([o.me.pkh]);
  const owners = data.data?.view?.config?.owners;
  const thr = Number(data.data?.view?.config?.threshold ?? 1n);
  useEffect(() => {
    if (owners) setSigners(defaultSigners(owners, thr, o.me.pkh));
  }, [owners?.join(), thr]);
  const waiting = !busy && inFlight(data.data?.pending ?? [], o.me.pkh);
  usePoll(data.refresh, waiting);
  if (!mine)
    return <Shell title="Vault"><div style={{ padding: 20 }} data-ready><p>Add this vault on <Link to="/vaults">All vaults</Link> first (you need its vault id).</p></div></Shell>;
  if (mine.version === 1) return <OldVaultPage mine={mine} />;
  const view = data.data?.view;
  const cfg = view?.config;
  const threshold = Number(cfg?.threshold ?? 1n);
  const propose = async (r: Recipe, done: string) => {
    setBusy("Building…");
    setErr(undefined);
    setNote(undefined);
    try {
      const prepared = await prepare(o, vaultOf(mine), r, data.data?.labels ?? {}, mine.version);
      setBusy(undefined);
      if (!(await review.ask(prepared))) return;
      setBusy("Waiting for your wallet…");
      const cbor = prepared.cbor;
      const p = await api.propose(policy, { cbor, witness: await partialSign(o.me, cbor), title: titleOf(r, data.data?.labels ?? {}), recipe: encodeRecipe(r) });
      setNote(p.status === "open" ? `${done} Signed by you: ${p.signedBy.length} of ${p.requiredSigners.length}. It's in the other owners' Needs you.` : `${done} Sent, waiting for the chain.`);
      data.reload();
      void o.reloadInbox();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const openUnpause = data.data?.pending.find((p) => p.status === "open" && decodeRecipe(p.recipe)?.op === "unpause");
  const pauseControls = cfg && (
    <>
      {!cfg.paused && <button type="button" className="btn stop" disabled={!!busy} onClick={() => void propose({ op: "pause" }, "Pause sent.")}>Pause all agents</button>}
      {cfg.paused && !openUnpause && <button type="button" className="btn" disabled={!!busy} onClick={() => navigate(`/v/${policy}/settings`)}>Unpause…</button>}
      {cfg.paused && openUnpause && <button type="button" className="btn" disabled>Unpause proposed: {openUnpause.signedBy.length} of {openUnpause.requiredSigners.length}</button>}
    </>
  );
  return (
    <Shell
      policy={policy}
      tab={tab}
      title={<><span style={{ fontWeight: 700, fontSize: 15 }}>{mine.name ?? "Unnamed vault"}</span>{cfg && <span className={cfg.paused ? "pill fill" : "pill"}>{cfg.paused ? "Paused" : "Active"}</span>}{cfg && <span className="faint">{String(cfg.threshold)} of {cfg.owners.length} owners</span>}</>}
      actions={pauseControls}
    >
      {review.panel}
      {cfg?.paused && <div className="banner">All agents are paused. No agent can pay. Unpausing needs {String(cfg.threshold)} of {cfg.owners.length} owners.</div>}
      <div className="tabs vtabs" role="tablist">
        {(["agents", "activity", "treasury", "apps", "settings"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={t === tab} className={t === tab ? "tab on" : "tab"} onClick={() => navigate(`/v/${policy}/${t}`)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }} {...(data.loading ? {} : { "data-ready": "" })}>
        {busy && <div className="note"><Spinner label={busy} /></div>}
        {note && <div className="note">{waiting ? <Spinner label={note} /> : note}</div>}
        <ErrorNote error={err ?? data.error} />
        {view && tab === "agents" && (
          <section className="panel">
            <div className="ph"><h2>Agents</h2><div style={{ display: "flex", gap: 8 }}><Link to={`/v/${policy}/agents/new`} className="btn">Add by agent key</Link><Link to={`/v/${policy}/connect`} className="btn pri">Connect an agent</Link></div></div>
            <div className="scroll">
              <table className="t cards" style={{ minWidth: 900 }}>
                <thead><tr><th>Agent</th><th>Status</th><th>Spent / budget</th><th>Per payment</th><th>Payees</th><th>Expires</th><th /></tr></thead>
                <tbody>
                  {view.allowances.length === 0 && <tr><td colSpan={7} className="muted">No agents yet.</td></tr>}
                  {view.allowances.map((a) => {
                    const l = a.caps.find((c) => c.unit === "lovelace");
                    const pct = l && l.perPeriod > 0n ? Number((l.spentThisPeriod * 100n) / l.perPeriod) : 0;
                    return (
                      <tr key={a.unit}>
                        <td className="lead"><div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}><Avatar id={a.unit} kind="agent" size={24} />{data.data!.labels[a.unit] ?? `agent ${short(a.unit.slice(56))}`}</div><div className="faint" style={{ fontSize: 12, maxWidth: 360 }}>{allowanceSentence(a)}</div>{(() => {
                          const vs = data.data!.versions;
                          const n = vs ? versionNote(vs.agents[a.unit]?.version, vs) : undefined;
                          return n && <div style={{ fontSize: 12, marginTop: 2, color: n.tone === "required" ? "#e0452b" : n.tone === "update" ? "#d9b24a" : "#8f8578" }}>{n.text}</div>;
                        })()}</td>
                        <td data-label="Status"><span className="pill">{a.status === "active" && cfg?.paused ? "paused" : a.status}</span></td>
                        <td data-label="Spent / budget" style={{ minWidth: 170 }}>{l ? <><div className="mono">{ada(l.spentThisPeriod)} / {ada(l.perPeriod)} ADA</div><div className="bar"><i style={{ width: `${Math.min(100, pct)}%` }} /></div></> : "—"}</td>
                        <td data-label="Per payment" className="mono">{l ? `${ada(l.perPayment)} ADA` : "—"}</td>
                        <td data-label="Payees" className="mono">{a.payees.length}</td>
                        <td data-label="Expires" className="mono">{a.expiresAt ? new Date(a.expiresAt).toISOString().slice(0, 10) : "—"}</td>
                        <td className="act"><Link to={`/v/${policy}/agents/${a.unit}`} className="btn">Edit</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {view && tab === "activity" && <Activity policy={policy} quiet={!!busy || waiting} />}
        {view && tab === "treasury" && (
          <Treasury lovelace={view.treasuryLovelace} tokens={view.treasury} address={view.address} busy={!!busy} net={o.net} onFund={(lovelace) => void propose({ op: "fund", lovelace }, "Funding sent.")} />
        )}
        {view && cfg && tab === "apps" && <AppsTab cfg={cfg} busy={!!busy} onPropose={(r, done) => void propose(r, done)} />}
        {view && cfg && tab === "settings" && (
          <>
            <section className="panel">
              <div className="ph"><h2>Pause</h2></div>
              <div className="row">
                <div style={{ display: "flex", flexDirection: "column" }}><span>Pause all agents</span><span className="faint" style={{ fontSize: 12 }}>Any one owner can pause, instantly. Unpausing needs {String(cfg.threshold)} of {cfg.owners.length}.</span></div>
                {!cfg.paused && pauseControls}
              </div>
              {cfg.paused && !openUnpause && (
                <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                  <Signers owners={cfg.owners} threshold={threshold} me={o.me.pkh} value={signers} onChange={setSigners} />
                  <button type="button" className="btn pri" style={{ alignSelf: "flex-start" }} disabled={!!busy || signers.length !== threshold} onClick={() => void propose({ op: "unpause", signers }, "Unpause proposed.")}>Propose unpause</button>
                </div>
              )}
              {cfg.paused && openUnpause && <div className="row"><span>Unpause proposed: {openUnpause.signedBy.length} of {openUnpause.requiredSigners.length}</span><Link to="/" className="btn">Open in Needs you</Link></div>}
            </section>
            <OwnersCard owners={cfg.owners} threshold={threshold} me={o.me.pkh} busy={!!busy} onPropose={(owners, t, s) => void propose({ op: "config", owners, threshold: BigInt(t), signers: s }, "Owner change proposed.")} />
            <Listing policy={policy} name={mine.name ?? ""} listed={mine.listed} onSaved={() => void o.reloadVaults()} />
            <section className="panel">
              <div className="ph"><h2>Vault id</h2></div>
              <div className="row"><span className="mono" style={{ wordBreak: "break-all" }}>{mine.vaultId}</span><Copy text={mine.vaultId} /></div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}

/** `quiet`: another spinner is already on screen, so loading shows as text. */
function Activity({ policy, quiet }: { policy: string; quiet: boolean }) {
  const o = useOwner();
  const rows = useLoad(async () => {
    const view = await readLight(policy, o.net);
    if (!view) return [];
    return (await Promise.all(view.allowances.filter((a) => a.status !== "malformed").map((a) => allowanceHistory(chainGet, a.unit, view.address, a.txHash)))).flat().sort((a, b) => b.time - a.time);
  }, [policy]);
  return (
    <section className="panel">
      <div className="ph"><h2>Activity</h2><span className="cap">recent, current agents</span></div>
      <div className="scroll">
        <table className="t cards" style={{ minWidth: 760 }}>
          <thead><tr><th>Time</th><th>What happened</th><th>Agent's note (not verified)</th><th>Ref</th></tr></thead>
          <tbody>
            {(rows.data ?? []).length === 0 && <tr><td colSpan={4} className="muted">{rows.loading ? (quiet ? "Reading the chain…" : <Spinner label="Reading the chain…" />) : "No activity yet."}</td></tr>}
            {(rows.data ?? []).map((p) => (
              <tr key={p.txHash}><td className="mono faint lead">{new Date(p.time).toISOString().replace("T", " ").slice(0, 16)}</td><td className="lead">{paymentLine(p)}.</td><td data-label="Agent's note (not verified)">{p.purpose ? cleanPurpose(p.purpose) : "—"}</td><td data-label="Ref" className="faint">tx <Chain value={p.txHash} network={o.net} label={short(p.txHash)} /></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Treasury({ lovelace, tokens, address, busy, net, onFund }: { lovelace: bigint; tokens: Record<string, bigint>; address: string; busy: boolean; net: string; onFund(l: bigint): void }) {
  const [amt, setAmt] = useState("100");
  const l = toLovelace(amt);
  return (
    <section className="panel">
      <div className="ph"><h2>Treasury</h2></div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 28, fontWeight: 900 }} className="mono">{ada(lovelace)} <span className="faint" style={{ fontSize: 14 }}>ADA</span></div>
        {Object.entries(tokens).filter(([u, q]) => u !== "lovelace" && q > 0n).map(([u, q]) => (
          <div key={u} className="kvrow"><span>{tokenName(u)}</span><span className="mono">{q.toString()}</span></div>
        ))}
        <div className="faint">Held by the vault script. Owners move it with their threshold; agents only within their allowance. Swap proceeds land here.</div>
        <div className="kvrow"><span>Vault address</span><span className="mono"><Chain value={address} network={net} label={short(address)} /> <Copy text={address} /></span></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor="fundAmt">Fund from your wallet</label>
          <input id="fundAmt" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ width: 120 }} />
          <span className="faint">ADA</span>
          <button type="button" className="btn pri" disabled={busy || !l} onClick={() => l && onFund(l)}>Send with wallet</button>
        </div>
      </div>
    </section>
  );
}

function OwnersCard({ owners, threshold, me, busy, onPropose }: { owners: string[]; threshold: number; me: string; busy: boolean; onPropose(owners: string[], t: number, signers: string[]): void }) {
  const [next, setNext] = useState(owners);
  const [t, setT] = useState(threshold);
  const [add, setAdd] = useState("");
  const [signers, setSigners] = useState<string[]>(() => defaultSigners(owners, threshold, me));
  const changed = next.join() !== owners.join() || t !== threshold;
  const bad = !next.length || t < 1 || t > next.length || !next.includes(me) ? "Keep at least yourself, and a threshold between 1 and the number of owners." : undefined;
  return (
    <section className="panel">
      <div className="ph"><h2>Owners and threshold</h2></div>
      <table className="t"><tbody>
        {next.map((k) => (
          <tr key={k}><td className="mono">{k === me ? "You" : `key ${short(k)}`}{!owners.includes(k) && <span className="pill seal"> new</span>}</td><td className="num">{k !== me && <button type="button" className="btn" onClick={() => setNext(next.filter((x) => x !== k))}>Remove</button>}</td></tr>
        ))}
      </tbody></table>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label="New owner key hash" placeholder="new owner's key hash (cli/vault keys show me)" value={add} onChange={(e) => setAdd(e.target.value.trim())} style={{ flex: "1 1 320px" }} />
          <button type="button" className="btn" disabled={!/^[0-9a-f]{56}$/.test(add) || next.includes(add)} onClick={() => { setNext([...next, add]); setAdd(""); }}>Add owner</button>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>Threshold
          <select value={t} onChange={(e) => setT(Number(e.target.value))}>{next.map((_, i) => <option key={i} value={i + 1}>{i + 1} of {next.length}</option>)}</select>
        </label>
        {changed && <Signers owners={owners} threshold={threshold} me={me} value={signers} onChange={setSigners} />}
        {changed && bad && <ErrorNote error={bad} />}
        <button type="button" className="btn pri" style={{ alignSelf: "flex-start" }} disabled={busy || !changed || !!bad || signers.length !== threshold} onClick={() => onPropose(next, t, signers)}>Propose change</button>
      </div>
    </section>
  );
}

function Listing({ policy, name, listed, onSaved }: { policy: string; name: string; listed: boolean; onSaved(): void }) {
  const [n, setN] = useState(name);
  const [l, setL] = useState(listed);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState(false);
  const save = async () => {
    try {
      await api.setListing(policy, n.trim(), l);
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="panel">
      <div className="ph"><h2>Name and visibility</h2></div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>Vault name <input value={n} onChange={(e) => { setN(e.target.value); setSaved(false); }} style={{ flex: "1 1 240px" }} /></label>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={l} onChange={(e) => { setL(e.target.checked); setSaved(false); }} /> Listed publicly: search engines may index /w/{short(policy)}. Display only; it doesn't touch funds.</label>
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} disabled={!n.trim()} onClick={() => void save()}>{saved ? "Saved" : "Save"}</button>
        <ErrorNote error={err} />
      </div>
    </section>
  );
}

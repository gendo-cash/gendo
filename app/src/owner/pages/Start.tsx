import { useState } from "react";
import { Mark, Netband, Spinner } from "../../ui/Brand.tsx";
import { ada } from "../../public/format.ts";
import { ApiError, api, session } from "../api.ts";
import { readLight } from "../chain.ts";
import { ErrorNote, Link, Shell, short, useLoad, useOwner } from "../ui.tsx";
import { connectWallet, wallets, type Connected } from "../wallet.ts";

/** Before sign-in: pick a wallet, sign the challenge. */
export function Connect({ onConnected }: { onConnected(c: Connected): void }) {
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = async (id: string) => {
    setBusy(true);
    setErr(undefined);
    try {
      const c = await connectWallet(id);
      const ch = await api.challenge(c.addressHex);
      const signed = await c.api.signData(c.addressHex, ch.payload);
      const s = await api.verify(ch.nonce, signed);
      session.set({ token: s.token, pkh: s.pkh, walletId: id });
      onConnected(c);
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app" data-ready>
      <Netband />
      <div className="top" style={{ background: "#0f0d0a" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Mark /><span style={{ fontWeight: 900, fontSize: 15 }}>gendo</span></div></div>
      <div style={{ display: "flex", justifyContent: "center", padding: "72px 20px" }}>
        <section className="panel" style={{ width: "100%", maxWidth: 420 }}>
          <div style={{ padding: "20px 20px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Connect a wallet</h1>
            <p className="muted" style={{ margin: 0 }}>Gendo gives AI agents budgeted accounts on Cardano. Owners set the limits; the chain enforces them.</p>
          </div>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
            {wallets().map((w) => (
              <button key={w.id} type="button" className="wallet" disabled={!w.installed || busy} onClick={() => go(w.id)}>
                <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {w.icon ? <img src={w.icon} alt="" width={24} height={24} /> : <span className="wico" aria-hidden="true">{w.name[0]}</span>}
                  {w.name}
                </span>
                <span className="faint" style={{ fontSize: 12 }}>{w.installed ? "Detected" : "Not installed"}</span>
              </button>
            ))}
            {busy && <Spinner label="Waiting for your wallet…" />}
            <ErrorNote error={err} />
          </div>
          <div className="faint" style={{ padding: "12px 20px", borderTop: "1px solid #2a241e", fontSize: 12, display: "flex", flexDirection: "column", gap: 6 }}>
            <span>Nothing we run can move your money. The server holds no keys; every change is checked in your browser before you sign. Signing in asks your wallet to sign a short message that names this site.</span>
          </div>
        </section>
      </div>
    </div>
  );
}

/** Your agent wallets, and adding one by its vault id. */
export function Start() {
  const o = useOwner();
  const [id, setId] = useState("");
  const [err, setErr] = useState<string>();
  const rows = useLoad(
    async () =>
      Promise.all(
        o.vaults.map(async (v) => {
          const view = await readLight(v.policy, o.net).catch(() => undefined);
          return { v, view };
        }),
      ),
    [o.vaults],
  );
  // Vaults the server knows whose owners on chain include you: one click to add, never added for you.
  const suggested = useLoad(() => api.suggestedVaults(), [o.vaults]);
  const add = async (vaultId: string) => {
    setErr(undefined);
    try {
      await api.addVault(vaultId.trim());
      setId("");
      await o.reloadVaults();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Shell title={<span style={{ fontWeight: 700, fontSize: 15 }}>All vaults</span>} actions={<Link to="/new" className="btn pri">Create a vault</Link>}>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16 }} data-ready>
        <section className="panel">
          <div className="scroll">
            <table className="t cards" style={{ minWidth: 760 }}>
              <thead><tr><th>Vault</th><th>Status</th><th>Owners</th><th className="num">Treasury</th><th className="num">Agents</th><th /></tr></thead>
              <tbody>
                {o.vaults.length === 0 && <tr><td colSpan={6} className="muted">No vaults yet. Create one, or add one by its vault id below.</td></tr>}
                {(rows.data ?? o.vaults.map((v) => ({ v, view: undefined }))).map(({ v, view }) => (
                  <tr key={v.policy}>
                    <td className="lead"><Link to={`/v/${v.policy}`}><b>{v.name ?? "Unnamed vault"}</b></Link><div className="mono faint" style={{ fontSize: 12 }}>{short(v.vaultId)}</div></td>
                    <td data-label="Status"><span className={view?.config?.paused ? "pill fill" : "pill"}>{v.version === 1 ? "Older version" : view?.config ? (view.config.paused ? "Paused" : "Active") : "—"}</span></td>
                    <td data-label="Owners" className="mono">{view?.config ? `${view.config.threshold} of ${view.config.owners.length}` : "—"}</td>
                    <td data-label="Treasury" className="num">{view ? `${ada(view.treasuryLovelace)} ADA` : "—"}</td>
                    <td data-label="Agents" className="num">{view ? view.allowances.length : "—"}</td>
                    <td className="num act"><Link to={`/v/${v.policy}`} className="btn">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {!!suggested.data?.length && (
          <section className="panel">
            <div className="ph"><h2>Vaults that name you as an owner</h2></div>
            {suggested.data.map((s) => (
              <div key={s.policy} style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", borderTop: "1px solid #2a241e" }}>
                <span><b>{s.name ?? "Unnamed vault"}</b> <span className="mono faint" style={{ fontSize: 12 }}>{short(s.vaultId)}</span></span>
                <button type="button" className="btn pri" aria-label={`Add ${s.name ?? "Unnamed vault"}`} onClick={() => void add(s.vaultId)}>Add</button>
              </div>
            ))}
          </section>
        )}
        <section className="panel">
          <div className="ph"><h2>Add a vault</h2></div>
          <div style={{ padding: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="vid" className="cap" style={{ width: "100%" }}>Vault id (gendo:preprod:…). You must be one of its owners.</label>
            <input id="vid" value={id} onChange={(e) => setId(e.target.value)} placeholder="gendo:preprod:<tx>#<i>:<tx>#<i>" style={{ flex: "1 1 360px" }} />
            <button type="button" className="btn" onClick={() => void add(id)} disabled={!id.trim()}>Add vault</button>
          </div>
          <div style={{ padding: "0 14px 14px" }}><ErrorNote error={err} /></div>
        </section>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>Vaults where {short(o.me.address)} is an owner and that you added here. Another owner's vault id comes from them, or from <code className="mono">cli/vault vault info</code>.</p>
      </div>
    </Shell>
  );
}

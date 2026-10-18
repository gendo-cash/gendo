import { useEffect, useState } from "react";
import { Chain, Spinner } from "../../ui/Brand.tsx";
import { api } from "../api.ts";
import { livenessOf, vaultOf } from "../chain.ts";
import { decodeRecipe, encodeRecipe, recipeMatches, titleOf } from "../recipes.ts";
import { DetailView, explainFor, prepare, useReview, type Prepared } from "../review.tsx";
import { inFlight, needsConfirm, statusOf, type Status } from "../status.ts";
import type { PendingView } from "../types.ts";
import { ErrorNote, Link, Shell, StatusIcon, short, useLoad, useOwner, usePoll } from "../ui.tsx";
import { partialSign } from "../wallet.ts";
import { explainTx } from "../../../../sdk/src/core/index.ts";
import { inputsOf } from "../chain.ts";

type Item = { p: PendingView; status: Status; view?: Prepared; error?: string; vaultName: string; labels: Record<string, string> };

export function Inbox() {
  const o = useOwner();
  const review = useReview(o.net);
  const [sel, setSel] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const suggested = useLoad(() => api.suggestedVaults(), [o.vaults]);
  const items = useLoad(async (): Promise<Item[]> => {
    // Creations are followed on the create page, not signed here.
    const rows = (await api.myPending()).filter((p) => p.kind !== "create");
    const labels: Record<string, Record<string, string>> = {};
    return Promise.all(
      rows.map(async (p) => {
        const v = o.vaults.find((x) => x.policy === p.policy);
        const vaultName = v?.name ?? short(p.policy);
        labels[p.policy] ??= (await api.listing(p.policy).catch(() => undefined))?.agents ?? {};
        try {
          if (!v) throw new Error("add this vault on the start page to check this item");
          const vault = vaultOf(v);
          const recipe = p.kind === "request" ? (p.recipe as { intentId?: string; purpose?: string; reason?: string } | null) : null;
          const [view, live] = await Promise.all([explainFor(o, vault, p.cbor, labels[p.policy]!, recipe, v.version), p.status === "open" ? livenessOf(o.lucid, p.cbor) : Promise.resolve(undefined)]);
          return { p, status: statusOf(p, live, o.me.pkh, Date.now()), view, vaultName, labels: labels[p.policy]! };
        } catch (x) {
          return { p, status: statusOf(p, undefined, o.me.pkh, Date.now()), error: (x as Error).message, vaultName, labels: labels[p.policy]! };
        }
      }),
    );
  }, [o.vaults]);

  useEffect(() => {
    void o.reloadInbox();
  }, [items.data]);
  // Re-check while anything is on its way to the chain or waiting for the other owners.
  usePoll(items.refresh, !busy && inFlight((items.data ?? []).map((x) => x.p), o.me.pkh));
  const list = items.data ?? [];
  const cur = list.find((x) => x.p.id === sel) ?? list.find((x) => x.status.needsYou) ?? list[0];

  const sign = async (it: Item) => {
    setBusy("Waiting for your wallet…");
    setErr(undefined);
    try {
      const w = await partialSign(o.me, it.p.cbor);
      setBusy("Submitting…");
      await api.sign(it.p.id, w);
      items.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  /** Rebuild a dead proposal: only as what it was, and reviewed like anything else before signing. */
  const rebuild = async (it: Item) => {
    const r = decodeRecipe(it.p.recipe);
    const v = o.vaults.find((x) => x.policy === it.p.policy);
    if (!r || !v) return setErr("This proposal can't be rebuilt here.");
    setBusy("Building it again from the current chain…");
    setErr(undefined);
    try {
      const vault = vaultOf(v);
      const { utxos } = await inputsOf(o.lucid, it.p.cbor, o.net);
      if (!recipeMatches(r, explainTx(it.p.cbor, vault, utxos, { version: v.version }))) throw new Error("Its recipe doesn't match what the original proposal did; build it again from the vault page instead.");
      const p = await prepare(o, vault, r, it.labels, v.version);
      setBusy(undefined);
      if (!(await review.ask(p))) return;
      setBusy("Waiting for your wallet…");
      const next = await api.propose(it.p.policy, { cbor: p.cbor, witness: await partialSign(o.me, p.cbor), title: titleOf(r, it.labels), recipe: encodeRecipe(r) });
      setSel(next.id);
      items.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const need = list.filter((x) => x.status.needsYou);
  const rest = list.filter((x) => !x.status.needsYou);
  const row = (x: Item) => (
    <button key={x.p.id} type="button" className="item" onClick={() => setSel(x.p.id)} style={{ background: cur?.p.id === x.p.id ? "#1a1612" : "transparent" }}>
      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%" }}>
        <span className="cap" style={{ color: x.p.kind === "request" ? "#e0452b" : "#8f8578" }}>{x.p.kind === "request" ? "Agent request" : "Change"}</span>
        <span className="cap">{x.status.left ?? ""}</span>
      </span>
      <span style={{ fontWeight: 700 }}>{x.view?.detail.title ?? x.p.title}</span>
      <span className="faint" style={{ fontSize: 12 }}>{x.vaultName}, {x.status.label}</span>
    </button>
  );
  const d = cur?.view?.detail;
  return (
    <Shell title={<><span style={{ fontWeight: 700, fontSize: 15 }}>Needs you</span><span className="faint">across {new Set(list.map((x) => x.p.policy)).size === 1 ? "1 vault" : `${new Set(list.map((x) => x.p.policy)).size} vaults`}</span></>}>
      {review.panel}
      {(!o.vaults.length || !!suggested.data?.length) && (
        <div style={{ padding: "16px 20px 0", display: "flex", flexDirection: "column", gap: 10 }}>
          {!o.vaults.length && !suggested.data?.length && (
            <div className="note" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
              <span>No vaults yet. Create one, or add one another owner shared with you.</span>
              <span style={{ display: "flex", gap: 8 }}><Link to="/new" className="btn pri">Create a vault</Link><Link to="/vaults" className="btn">Add a vault</Link></span>
            </div>
          )}
          {!!suggested.data?.length && (
            <div className="note" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
              <span>{suggested.data.length === 1 ? "A vault names you as an owner." : `${suggested.data.length} vaults name you as an owner.`} Add {suggested.data.length === 1 ? "it" : "them"} to see {suggested.data.length === 1 ? "it" : "them"} here.</span>
              <Link to="/vaults" className="btn">Review</Link>
            </div>
          )}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "16px 20px", alignItems: "flex-start" }} {...(items.loading ? {} : { "data-ready": "" })}>
        <section className="panel" aria-label="Items" style={{ flex: "1 1 280px", maxWidth: 360 }}>
          <div className="ph"><span className="cap">Your signature</span></div>
          {items.loading && !items.data ? <p style={{ padding: "10px 14px", margin: 0 }}><Spinner label="Reading your inbox and checking each tx on the chain…" /></p> : need.length ? need.map(row) : <p className="faint" style={{ padding: "10px 14px", margin: 0 }}>Nothing needs you.</p>}
          <div className="ph"><span className="cap">In flight and closed</span></div>
          {rest.map(row)}
          {items.error && <ErrorNote error={items.error} />}
        </section>
        {cur && (
          <section className="panel" aria-label="Detail" style={{ flex: "999 1 480px", minWidth: 0 }}>
            <div className="ph">
              <span style={{ fontWeight: 700, fontSize: 16 }}>{d?.title ?? cur.p.title}</span>
              <StatusIcon status={cur.status} spinning={!busy} />
            </div>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
              {cur.error && <ErrorNote error={`Can't check this tx: ${cur.error}`} />}
              {cur.view && <DetailView detail={cur.view.detail} verified={cur.view.verified} network={o.net} />}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #2a241e", paddingTop: 14 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <div role="img" aria-label={cur.status.label} style={{ display: "flex", gap: 6 }}>
                    {cur.p.requiredSigners.map((k) => (cur.p.signedBy.includes(k) ? <span key={k} className="stamp" title={k}>印</span> : <span key={k} className="slot" title={k} />))}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span>{cur.status.label}</span>
                    {cur.p.requiredSigners.map((k) => (
                      <span key={k} className="faint" style={{ fontSize: 12 }}>
                        {`${k === o.me.pkh ? "You" : k === cur.p.createdBy && cur.p.kind === "request" ? "The agent" : `Owner key ${short(k)}`}: ${cur.p.signedBy.includes(k) ? "signed" : "not yet"}`}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="faint">{cur.status.left ?? ""}</span>
                  {busy && <button type="button" className="btn" disabled><Spinner label={busy} /></button>}
                  {!busy && cur.status.canSign && d && (needsConfirm(d) && !confirmed[cur.p.id] ? (
                    <button type="button" className="btn stop" onClick={() => setConfirmed({ ...confirmed, [cur.p.id]: true })}>I've read the warnings</button>
                  ) : (
                    <button type="button" className="btn pri" onClick={() => void sign(cur)}>Sign with wallet</button>
                  ))}
                  {!busy && cur.status.canRebuild && <button type="button" className="btn" onClick={() => void rebuild(cur)}>Rebuild</button>}
                </div>
              </div>
              {cur.status.hint && <div className="note">{cur.status.hint}</div>}
              {cur.status.tone === "dead" && <div className="note">{cur.p.kind === "request" ? "The agent re-files with the same intent id; the new request shows up here." : "Rebuild drafts it again against the current on-chain state; owners sign from zero."}</div>}
              {cur.status.label === "Landed" && <div className="note">Landed on Preprod. The chain now enforces the new state. <span className="faint">tx <Chain value={cur.p.txHash ?? ""} network={o.net} label={short(cur.p.txHash ?? "")} /></span></div>}
              <ErrorNote error={err} />
            </div>
          </section>
        )}
      </div>
    </Shell>
  );
}

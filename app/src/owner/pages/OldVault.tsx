// A vault from before apps (version 1). Its code is fixed on chain: its agents still pay, but it can't
// use apps or be changed here. Its owners move everything into a current vault with the same owners.
import { useEffect, useState } from "react";
import { ada, tokenName } from "../../public/format.ts";
import { navigate } from "../../route.ts";
import { Avatar, Spinner } from "../../ui/Brand.tsx";
import { api } from "../api.ts";
import { readLight, vaultOf } from "../chain.ts";
import { decodeRecipe, encodeRecipe, titleOf, type Recipe } from "../recipes.ts";
import { prepare, useReview } from "../review.tsx";
import { inFlight } from "../status.ts";
import { ErrorNote, Link, Shell, Signers, defaultSigners, short, useLoad, useOwner, usePoll } from "../ui.tsx";
import type { SavedVault } from "../vaults.ts";
import { partialSign } from "../wallet.ts";

const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

export function OldVaultPage({ mine }: { mine: SavedVault }) {
  const o = useOwner();
  const data = useLoad(async () => {
    const [view, listing, pending] = await Promise.all([readLight(mine.policy, o.net), api.listing(mine.policy), api.pendingOf(mine.policy)]);
    // Where it can go: your current vaults with the same owners and threshold.
    const current = await Promise.all(o.vaults.filter((v) => v.version === 2).map(async (v) => ({ v, view: await readLight(v.policy, o.net).catch(() => undefined) })));
    const cfg = view?.config;
    const targets = cfg ? current.filter((x) => x.view?.config && sameSet(x.view.config.owners, cfg.owners) && x.view.config.threshold === cfg.threshold).map((x) => x.v) : [];
    return { view, labels: listing?.agents ?? {}, pending, targets };
  }, [mine.policy, o.vaults.length]);
  const review = useReview(o.net);
  const [to, setTo] = useState<string>();
  const [signers, setSigners] = useState<string[]>([o.me.pkh]);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<string>();
  const view = data.data?.view;
  const cfg = view?.config;
  const threshold = Number(cfg?.threshold ?? 1n);
  const targets = data.data?.targets ?? [];
  const target = targets.find((t) => t.vaultId === to) ?? targets[0];
  useEffect(() => {
    if (cfg) setSigners(defaultSigners(cfg.owners, threshold, o.me.pkh));
  }, [cfg?.owners.join(), threshold]);
  const waiting = !busy && inFlight(data.data?.pending ?? [], o.me.pkh);
  usePoll(data.refresh, waiting);
  const openMove = data.data?.pending.find((p) => p.status === "open" && decodeRecipe(p.recipe)?.op === "move");
  const moved = view && view.treasuryLovelace === 0n && view.allowances.length === 0;
  const labels = data.data?.labels ?? {};
  const name = (unit: string) => labels[unit] ?? `agent ${short(unit.slice(56))}`;

  const move = async () => {
    if (!target) return;
    const r: Recipe = { op: "move", to: target.vaultId, signers };
    setBusy("Building…");
    setErr(undefined);
    setNote(undefined);
    try {
      const prepared = await prepare(o, vaultOf(mine), r, labels, 1);
      setBusy(undefined);
      if (!(await review.ask(prepared))) return;
      setBusy("Waiting for your wallet…");
      const p = await api.propose(mine.policy, { cbor: prepared.cbor, witness: await partialSign(o.me, prepared.cbor), title: titleOf(r, labels), recipe: encodeRecipe(r) });
      setNote(p.status === "open" ? `Move proposed. Signed by you: ${p.signedBy.length} of ${p.requiredSigners.length}. It's in the other owners' Needs you.` : "Move sent, waiting for the chain.");
      data.reload();
      void o.reloadInbox();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const tokens = Object.entries(view?.treasury ?? {}).filter(([u, q]) => u !== "lovelace" && q > 0n);
  const budgets = view?.allowances.reduce((n, a) => n + a.lovelace, 0n) ?? 0n;
  return (
    <Shell
      policy={mine.policy}
      title={<><span style={{ fontWeight: 700, fontSize: 15 }}>{mine.name ?? "Unnamed vault"}</span><span className="pill">Older version</span>{cfg && <span className="faint">{String(cfg.threshold)} of {cfg.owners.length} owners</span>}</>}
    >
      {review.panel}
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820 }} {...(data.loading ? {} : { "data-ready": "" })}>
        {busy && <div className="note"><Spinner label={busy} /></div>}
        {note && !moved && <div className="note">{waiting ? <Spinner label={note} /> : note}</div>}
        <ErrorNote error={err ?? data.error} />
        {data.loading && !view && <Spinner label="Reading the chain…" />}
        {view && moved && (
          <section className="panel">
            <div className="ph"><h2>Moved</h2></div>
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <span>Everything this vault held is in its new version. Only the small deposit kept with its settings stays here, for good.</span>
              {targets[0] && <span><Link to={`/v/${targets[0].policy}`} className="btn pri">Open {targets[0].name ?? "the new vault"}</Link></span>}
            </div>
          </section>
        )}
        {view && cfg && !moved && (
          <>
            <section className="panel">
              <div className="ph"><h2>Move to the new version</h2></div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <span>This vault runs the version of gendo from before apps. Its code is fixed on the chain, so it can't gain apps and can't be changed here. Its agents still pay as before. Moving puts everything it holds into a vault on the new version, with the same owners and threshold.</span>
              </div>
              <div className="kvrow"><span>Treasury</span><span className="mono">{ada(view.treasuryLovelace)} ADA</span></div>
              {tokens.map(([u, q]) => <div key={u} className="kvrow"><span>{tokenName(u)}</span><span className="mono">{q.toString()}</span></div>)}
              {view.allowances.map((a) => (
                <div key={a.unit} className="kvrow"><span style={{ display: "flex", gap: 8, alignItems: "center" }}><Avatar id={a.unit} kind="agent" size={20} />{name(a.unit)}'s budget</span><span className="mono">{ada(a.lovelace)} ADA</span></div>
              ))}
              <div className="kvrow"><span style={{ fontWeight: 700 }}>Moves in total</span><span className="mono" style={{ fontWeight: 700 }}>{ada(view.treasuryLovelace + budgets)} ADA{tokens.length ? ` and ${tokens.length} token type${tokens.length === 1 ? "" : "s"}` : ""}</span></div>
            </section>

            <section className="panel">
              <div className="ph"><h2>1. The new vault</h2>{target && <span className="cap">Ready</span>}</div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {targets.length === 0 && (
                  <>
                    <span>Create it first: same owners, same threshold. It opens filled in; you only confirm and sign.</span>
                    <button type="button" className="btn pri" style={{ alignSelf: "flex-start" }} onClick={() => navigate(`/new?from=${mine.policy}`)}>Create the new vault</button>
                  </>
                )}
                {targets.length === 1 && <span>Into <Link to={`/v/${targets[0]!.policy}`}>{targets[0]!.name ?? "Unnamed vault"}</Link>, which has the same owners and threshold.</span>}
                {targets.length > 1 && (
                  <>
                    <span>Your vaults on the new version with the same owners and threshold:</span>
                    {targets.map((t) => (
                      <label key={t.policy} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="radio" name="move-to" checked={target?.policy === t.policy} onChange={() => setTo(t.vaultId)} />
                        {t.name ?? "Unnamed vault"} <span className="faint mono">{short(t.policy)}</span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="ph"><h2>2. Move everything</h2></div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                {view.allowances.length > 0 && <span className="faint">Its agents stop when their budgets move. Afterwards, connect them again on the new vault.</span>}
                {openMove ? (
                  <div className="row"><span>Move proposed: signed {openMove.signedBy.length} of {openMove.requiredSigners.length}.</span><Link to="/" className="btn">Open in Needs you</Link></div>
                ) : (
                  <>
                    <Signers owners={cfg.owners} threshold={threshold} me={o.me.pkh} value={signers} onChange={setSigners} />
                    <button type="button" className="btn pri" style={{ alignSelf: "flex-start" }} disabled={!!busy || !target || signers.length !== threshold} onClick={() => void move()}>Review and move</button>
                  </>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}

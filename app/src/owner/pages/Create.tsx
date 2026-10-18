// Create a vault: who owns it, how many must agree, how long an agent payment may take,
// and an optional first deposit. Built and explained in the browser; the wallet signs once;
// the server submits it and registers it when it lands.
import { useEffect, useState } from "react";
import { Spinner } from "../../ui/Brand.tsx";
import { navigate } from "../../route.ts";
import { owner } from "../../../../sdk/src/core/index.ts";
import { api } from "../api.ts";
import { readLight } from "../chain.ts";
import { explainFor, useReview } from "../review.tsx";
import { Copy, ErrorNote, Shell, short, useOwner, usePoll } from "../ui.tsx";
import { buildError, createConfig, createOptions, createProblems, ownerHint, type CreateForm } from "../validate.ts";
import { partialSign } from "../wallet.ts";

type Made = { id: string; vaultId: string; policy: string; status: string; error?: string };

export function Create() {
  const o = useOwner();
  const review = useReview(o.net);
  const [f, setF] = useState<CreateForm>({ name: "", owners: [], threshold: "1", windowMin: o.net === "Custom" ? "2" : "10", fund: "0", refScript: false });
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [made, setMade] = useState<Made>();
  const problems = createProblems(f, { me: o.me.pkh, net: o.net });
  const n = 1 + f.owners.length;
  const hint = ownerHint(next, f.owners, o.me.pkh, o.net);
  // Moving a vault from before apps: start from its owners, threshold and name; come back to it once this lands.
  const from = o.vaults.find((v) => v.version === 1 && v.policy === new URLSearchParams(location.search).get("from"));
  useEffect(() => {
    if (!from) return;
    void readLight(from.policy, o.net).then((view) => {
      const c = view?.config;
      if (!c) return;
      const min = String(Number(c.maxTxValidityMs) / 60_000);
      setF((f) => ({ ...f, name: from.name ?? "My vault", owners: c.owners.filter((k) => k !== o.me.pkh), threshold: String(c.threshold), windowMin: (["2", "10", "60"].includes(min) ? min : f.windowMin) as CreateForm["windowMin"] }));
    });
  }, [from?.policy]);

  const addOwner = () => {
    // A second owner: default to 2 of n, the usual company card.
    setF({ ...f, owners: [...f.owners, next.trim()], threshold: f.owners.length === 0 ? "2" : f.threshold });
    setNext("");
  };
  const removeOwner = (i: number) => {
    const owners = f.owners.filter((_, j) => j !== i);
    setF({ ...f, owners, threshold: String(Math.min(Number(f.threshold), 1 + owners.length)) });
  };

  const create = async () => {
    setErr(undefined);
    setBusy("Building the vault in your browser…");
    try {
      const { tx, vault } = await owner.createVault(o.lucid, createConfig(f, o.me.pkh, o.net), createOptions(f, o.me.pkh, o.net));
      const p = await explainFor(o, vault, tx.toCBOR(), {});
      setBusy(undefined);
      if (!(await review.ask(p))) return;
      setBusy("Waiting for your wallet…");
      const witness = await partialSign(o.me, p.cbor);
      setBusy("Sending it to the chain…");
      const r = await api.createVault({ cbor: p.cbor, witness, name: f.name.trim() });
      setMade({ id: r.pending.id, vaultId: r.vaultId, policy: r.policy, status: r.pending.status, ...(r.pending.error ? { error: r.pending.error } : {}) });
    } catch (e) {
      setErr(buildError((e as Error).message ?? String(e)));
    } finally {
      setBusy(undefined);
    }
  };

  // After sending: reading the inbox moves it along and registers it once it lands; then open the vault.
  usePoll(async () => {
    if (!made) return;
    const row = (await api.myPending().catch(() => [])).find((x) => x.id === made.id);
    if (!row) return;
    if (row.status === "landed") {
      await o.reloadVaults();
      navigate(from ? `/v/${from.policy}` : `/v/${made.policy}/agents`);
    } else if (row.status !== made.status) setMade({ ...made, status: row.status, ...(row.error ? { error: row.error } : {}) });
  }, !!made && made.status !== "failed");

  const title = <span style={{ fontWeight: 700, fontSize: 15 }}>Create a vault</span>;
  if (made)
    return (
      <Shell title={title}>
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 760 }} data-ready>
          {made.status === "failed" ? (
            <>
              <ErrorNote error={`It didn't land: ${made.error ?? "the chain refused it"}. Nothing was created; you can try again.`} />
              <button type="button" className="btn" onClick={() => setMade(undefined)} style={{ alignSelf: "flex-start" }}>Back to the form</button>
            </>
          ) : (
            <Spinner label="Waiting for the chain. This usually takes under a minute." />
          )}
          <div className="note"><div className="cap">Vault id</div><span className="mono" style={{ wordBreak: "break-all" }}>{made.vaultId}</span> <Copy text={made.vaultId} /></div>
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>You can close this page: the vault shows up in your list once it lands. The other owners see it offered on their start page.</p>
        </div>
      </Shell>
    );

  return (
    <Shell title={title}>
      {review.panel}
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }} data-ready>
        {from && <div className="note">The new version of {from.name ?? "your vault"}: same owners and threshold, filled in. Once it lands, you go back to move its funds.</div>}
        <section className="panel">
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <label className="cap" htmlFor="cname">Name</label>
            <input id="cname" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Acme payouts" />

            <span className="cap" style={{ marginTop: 6 }}>Owners</span>
            <div className="note" style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span className="mono">{short(o.me.address)}</span><span className="faint">You</span></div>
            {f.owners.map((s, i) => (
              <div key={`${s}-${i}`} className="note" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ wordBreak: "break-all" }}>{s}</span>
                <button type="button" className="btn" onClick={() => removeOwner(i)}>Remove</button>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input id="cowner" aria-label="Another owner" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Another owner's wallet address (addr_test1…) or key hash" style={{ flex: "1 1 320px" }} />
              <button type="button" className="btn" disabled={!next.trim() || !!hint} onClick={addOwner}>Add owner</button>
            </div>
            {hint && <div className="faint" role="status" style={{ fontSize: 12 }}>{hint}</div>}

            <label className="cap" htmlFor="cthreshold" style={{ marginTop: 6 }}>Approvals needed for changes</label>
            <select id="cthreshold" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })}>
              {Array.from({ length: n }, (_, i) => <option key={i} value={String(i + 1)}>{i + 1} of {n}</option>)}
            </select>

            <label className="cap" htmlFor="cwindow" style={{ marginTop: 6 }}>An agent's payment must land within</label>
            <select id="cwindow" value={f.windowMin} onChange={(e) => setF({ ...f, windowMin: e.target.value as CreateForm["windowMin"] })}>
              <option value="2">2 minutes</option>
              <option value="10">10 minutes</option>
              <option value="60">1 hour</option>
            </select>

            <label className="cap" htmlFor="cfund" style={{ marginTop: 6 }}>ADA to put in the treasury now (optional)</label>
            <input id="cfund" inputMode="decimal" value={f.fund} onChange={(e) => setF({ ...f, fund: e.target.value })} />

            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={f.refScript} onChange={(e) => setF({ ...f, refScript: e.target.checked })} style={{ marginTop: 3 }} />
              <span>
                Lower every agent payment's fee (by about 0.18 ADA)
                <span className="faint" style={{ display: "block", fontSize: 12 }}>Parks a copy of the vault's code on chain, which locks about 28 ADA for good. Worth it past roughly 150 agent payments.</span>
              </span>
            </label>
          </div>
        </section>
        <div className="note">
          {n === 1 ? "Only you own it: you approve every change alone." : `Any ${f.threshold} of the ${n} owners approve changes; any one owner can pause every agent at once.`}{" "}
          Creating it costs the network fee plus about 1.3 ADA that stays with the vault's settings{f.refScript ? ", and about 28 ADA locked for good for the cheaper agent payments" : ""}.
          <details style={{ marginTop: 8 }}>
            <summary className="faint" style={{ cursor: "pointer", fontSize: 12 }}>Why does this lock ADA?</summary>
            <div className="faint" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
              <span>Cardano asks for a deposit for anything stored on chain: every entry must hold a minimum amount of ADA, more for bigger data. It keeps people from filling the chain with junk for free.</span>
              <span>The vault's settings (its owners and threshold) are one small entry, so about 1.3 ADA stays with them for as long as the vault exists.</span>
              <span>The optional copy of the vault's code is 6 KB, so its deposit is about 28 ADA. It's parked where nobody can ever spend it, so agents can always rely on it; that ADA is gone for good. Each agent payment then costs about 0.18 ADA less.</span>
            </div>
          </details>
        </div>
        {f.name.trim() && problems.length > 0 && <ErrorNote error={problems.join(" ")} />}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button type="button" className="btn pri" disabled={!!busy || problems.length > 0} onClick={() => void create()}>Review and create</button>
          {busy && <Spinner label={busy} />}
        </div>
        <ErrorNote error={err} />
      </div>
    </Shell>
  );
}

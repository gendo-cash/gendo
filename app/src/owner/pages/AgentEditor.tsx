import { useEffect, useMemo, useState } from "react";
import { fromPlutusAddress, readAllowance, readConfig, toPlutusAddress, type AllowanceDatum } from "../../../../sdk/src/core/index.ts";
import { api } from "../api.ts";
import { vaultOf } from "../chain.ts";
import { sentence } from "../diff.ts";
import { encodeRecipe, grantedUnit, titleOf, type Recipe } from "../recipes.ts";
import { prepare, useReview } from "../review.tsx";
import { agentProblems, editedDatum, PERIOD_MS, toLovelace, type AgentForm } from "../validate.ts";
import { Copy, ErrorNote, Link, Shell, Signers, defaultSigners, short, useLoad, useOwner } from "../ui.tsx";
import { partialSign } from "../wallet.ts";
import { Chain, Spinner } from "../../ui/Brand.tsx";

const periodOf = (ms: bigint): AgentForm["period"] => (ms === PERIOD_MS.week ? "week" : ms === PERIOD_MS.month ? "month" : "day");

export function AgentEditor({ policy, unit }: { policy: string; unit?: string }) {
  const o = useOwner();
  const mine = o.vaults.find((v) => v.policy === policy);
  const vault = useMemo(() => (mine ? vaultOf(mine) : undefined), [mine?.vaultId]);
  const review = useReview(o.net);
  const [periodTouched, setPeriodTouched] = useState(false);
  const loaded = useLoad(async () => {
    if (!vault) return undefined;
    const [cfg, al, listing] = await Promise.all([readConfig(o.lucid, vault), unit ? readAllowance(o.lucid, vault, unit) : Promise.resolve(undefined), api.listing(policy)]);
    return { cfg: cfg.config, al: al?.datum, labels: listing?.agents ?? {} };
  }, [policy, unit, mine?.vaultId]);
  const [f, setF] = useState<AgentForm>({ name: "", agentKey: "", perPayment: "10", budget: "25", period: "day", payees: [], expires: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), fund: "40", apps: [] });
  const [newPayee, setNewPayee] = useState("");
  const [signers, setSigners] = useState<string[]>([o.me.pkh]);
  const [busy, setBusy] = useState<string>();
  const [err, setErr] = useState<string>();
  const [note, setNote] = useState<string>();
  // After a proposal, until the form changes: say so up top, and don't offer to propose the same thing again.
  const [proposed, setProposed] = useState(false);
  useEffect(() => setProposed(false), [f, signers]);
  const [token, setToken] = useState<string>();
  // Arrived from "Connect an agent": the agent and its name come from the pairing, never typed.
  const pairingId = unit ? null : new URLSearchParams(location.search).get("pairing");
  const pairing = useLoad(async () => (pairingId ? api.pairing(pairingId) : undefined), [pairingId]);
  useEffect(() => {
    const p = pairing.data;
    if (p?.agent) setF((x) => ({ ...x, name: p.name, agentKey: p.agent! }));
  }, [pairing.data]);

  useEffect(() => {
    const d = loaded.data;
    if (!d) return;
    setSigners(defaultSigners(d.cfg.owners, Number(d.cfg.threshold), o.me.pkh));
    if (d.al) {
      const c = d.al.caps.find((x) => x.policy === "");
      setF({
        name: unit ? d.labels[unit] ?? "" : "", agentKey: d.al.agent,
        perPayment: c ? String(Number(c.txCap) / 1e6) : "0", budget: c ? String(Number(c.windowCap) / 1e6) : "0", period: periodOf(d.al.periodMs),
        payees: d.al.destinations.map((a) => fromPlutusAddress(o.net, a)), expires: new Date(Number(d.al.expiresAt)).toISOString().slice(0, 10), fund: "0", apps: d.al.apps,
      });
    }
  }, [loaded.data]);

  if (!mine || !vault) return <Shell title="Agent"><div style={{ padding: 20 }} data-ready><p>Add this vault on <Link to="/vaults">All vaults</Link> first.</p></div></Shell>;
  const d = loaded.data;
  const threshold = Number(d?.cfg.threshold ?? 1n);
  const isKeyAddress = (s: string) => {
    try {
      return toPlutusAddress(s, o.net).payment.type === "Key" && s.startsWith("addr_test1");
    } catch {
      return false;
    }
  };
  const problems = d ? agentProblems(f, { isNew: !unit, nowMs: Date.now(), owners: d.cfg.owners, isKeyAddress }) : [loaded.error ? "Couldn't read this vault from the chain." : "Reading the vault from the chain…"];
  const expiresAt = BigInt(Date.parse(`${f.expires}T23:59:59Z`) || 0);
  const draft = (): AllowanceDatum | undefined => {
    if (problems.length || !d) return undefined;
    if (!d.al) return undefined;
    // Keep the on-chain expiry time when the owner didn't change the date.
    const sameDay = new Date(Number(d.al.expiresAt)).toISOString().slice(0, 10) === f.expires;
    return editedDatum(
      d.al,
      { perPayment: toLovelace(f.perPayment)!, budget: toLovelace(f.budget)!, period: periodTouched ? PERIOD_MS[f.period] : undefined, payees: f.payees, expiresAt: sameDay ? d.al.expiresAt : expiresAt, apps: f.apps },
      (a) => toPlutusAddress(a, o.net),
    );
  };
  const next = draft();
  const live = sentence(
    { agent: f.agentKey, destinations: f.payees.map(() => ({ payment: { type: "Key", hash: "" }, stake: null })), caps: [{ policy: "", name: "", windowCap: toLovelace(f.budget) ?? 0n, txCap: toLovelace(f.perPayment) ?? 0n }], spent: [0n], windowStart: 0n, periodMs: PERIOD_MS[f.period], expiresAt, maxFee: 0n, apps: [] },
    f.payees.length,
  );
  const propose = async (r: Recipe, done: string) => {
    setBusy("Building…");
    setErr(undefined);
    setNote(undefined);
    try {
      const prepared = await prepare(o, vault, r, d?.labels ?? {});
      setBusy(undefined);
      if (!(await review.ask(prepared))) return;
      setBusy("Waiting for your wallet…");
      const cbor = prepared.cbor;
      // Name a new agent now, so the other owners review "Add My Claude", not a bare id.
      const granted = r.op === "grant" && f.name.trim() ? grantedUnit(cbor, policy) : undefined;
      if (granted) await api.setLabel(policy, granted, f.name.trim()).catch(() => undefined);
      const labels = granted ? { ...(d?.labels ?? {}), [granted]: f.name.trim() } : d?.labels ?? {};
      const p = await api.propose(policy, { cbor, witness: await partialSign(o.me, cbor), title: titleOf(r, labels), recipe: encodeRecipe(r) });
      if (unit && f.name.trim() && f.name.trim() !== (d?.labels[unit] ?? "")) await api.setLabel(policy, unit, f.name.trim()).catch(() => undefined);
      setNote(`${done} Signed by you: ${p.signedBy.length} of ${p.requiredSigners.length}. It's in the other owners' Needs you. Nothing changes on-chain until it lands.`);
      setProposed(true);
      scrollTo({ top: 0, behavior: "smooth" });
      void o.reloadInbox();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const save = async () => {
    if (unit && d?.al && next) {
      return propose({ op: "edit", unit, next, topUp: 0n, signers }, "Proposed.");
    }
    if (!unit && !problems.length) {
      const now = BigInt(o.lucid.slotToUnixTime(o.lucid.currentSlot()));
      const grant = {
        agent: f.agentKey, destinations: f.payees, caps: [{ policy: "", name: "", windowCap: toLovelace(f.budget)!, txCap: toLovelace(f.perPayment)! }],
        periodMs: PERIOD_MS[f.period], windowStart: now - 120_000n, expiresAt, maxFee: 2_000_000n, fund: { lovelace: toLovelace(f.fund)! }, apps: f.apps,
        // A paired agent's own address starts empty; it needs a little ADA there as collateral.
        ...(pairing.data?.agent ? { collateral: 5_000_000n } : {}),
      };
      return propose({ op: "grant", grant, signers }, pairing.data?.agent ? `Proposed. ${f.name.trim()} connects once it lands.` : `Proposed ${f.name.trim()}.`);
    }
  };
  const set = (k: keyof AgentForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const field = (id: string, label: string, input: React.ReactNode, hint?: string) => (
    <div className="field"><label htmlFor={id}>{label}</label><div>{input}</div>{hint && <span className="hint">{hint}</span>}</div>
  );
  if (mine.version === 1) return <Shell title="Agent"><div style={{ padding: 20 }} data-ready><p>This vault runs an older version and can't be changed here. <Link to={`/v/${policy}`}>Move it to the new version</Link> first.</p></div></Shell>;
  const name = unit ? (d?.labels[unit] ?? `agent ${short(unit.slice(56))}`) : "New agent";
  const vaultId = mine.vaultId;
  return (
    <Shell
      policy={policy}
      tab="agents"
      title={<><Link to={`/v/${policy}`}>{mine.name ?? "Vault"}</Link><span className="faint">/</span><Link to={`/v/${policy}/agents`}>Agents</Link><span className="faint">/</span><span>{name}</span></>}
      actions={<button type="button" className="btn pri" disabled={!!busy || proposed || problems.length > 0 || signers.length !== threshold} onClick={() => void save()}>{proposed ? "Proposed ✓" : unit ? "Propose change" : "Propose agent"}</button>}
    >
      {review.panel}
      {proposed && note && (
        <div className="note" role="status" style={{ margin: "16px 20px 0", borderColor: "#e0452b", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <span>{note}</span>
          <span style={{ display: "flex", gap: 8 }}><Link to="/" className="btn">Needs you</Link><Link to={`/v/${policy}/agents`} className="btn">Back to agents</Link></span>
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: "16px 20px", alignItems: "flex-start" }} {...(loaded.loading ? {} : { "data-ready": "" })}>
        <section className="panel" style={{ flex: "999 1 480px", minWidth: 0 }}>
          <div className="ph"><h2>Allowance</h2><span className="cap">Changes need {threshold} of {d?.cfg.owners.length ?? "?"} owners</span></div>
          {field("aname", "Name", <input id="aname" value={f.name} onChange={set("name")} placeholder="payout-bot" />, "Only shown in the app and on the public page.")}
          {!unit && pairing.data?.agent && field("apaired", "Agent", <span><b>{pairing.data.name}</b> <span className="faint">({pairing.data.words}), connected from its own machine</span></span>, "It also gets 5 ADA in its own address: Cardano needs a little there as a safety deposit for every payment.")}
          {!unit && !pairingId && (
            <details className="field">
              <summary style={{ cursor: "pointer" }}>Advanced: paste an agent key (for a separate signer)</summary>
              {field("akey", "Agent key hash", <input id="akey" value={f.agentKey} onChange={(e) => setF({ ...f, agentKey: e.target.value.trim() })} placeholder="56 hex characters" style={{ width: "100%" }} />, "Whoever runs a separate signer makes the key on its machine with cli/vault keys gen agent and sends you the pkh it prints. Most people should use Connect an agent instead.")}
            </details>
          )}
          {field("cap", "Per-payment cap", <><input id="cap" value={f.perPayment} onChange={set("perPayment")} style={{ width: 120 }} /> <span className="faint">ADA</span></>, "Most the agent can pay in one payment.")}
          {field("budget", "Budget", <><input id="budget" value={f.budget} onChange={set("budget")} style={{ width: 120 }} /> <span className="faint">ADA per</span> <select aria-label="Budget period" value={f.period} onChange={(e) => { setPeriodTouched(true); set("period")(e); }}><option value="day">day</option><option value="week">week</option><option value="month">30 days</option></select></>)}
          {field("newPayee", "Approved payees", (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {f.payees.map((p) => (
                <div key={p} className="kvrow" style={{ padding: "4px 0" }}><Chain value={p} network={o.net} label={short(p)} /><button type="button" className="btn" onClick={() => setF({ ...f, payees: f.payees.filter((x) => x !== p) })}>Remove</button></div>
              ))}
              <div style={{ display: "flex", gap: 8 }}><input id="newPayee" value={newPayee} onChange={(e) => setNewPayee(e.target.value.trim())} placeholder="addr_test1…" style={{ flex: 1 }} /><button type="button" className="btn" disabled={!newPayee} onClick={() => { setF({ ...f, payees: [...f.payees, newPayee] }); setNewPayee(""); }}>Add</button></div>
            </div>
          ), "The agent can't pay any address not on this list.")}
          {field("exp", "Expires", <input id="exp" type="date" value={f.expires} onChange={set("expires")} />, "After this date the agent can't pay at all.")}
          {field("apps", "Apps it may use", (
            d?.cfg.apps.length ? (
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {d.cfg.apps.map((a) => (
                  <label key={a.name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <input type="checkbox" checked={f.apps.includes(a.name)} onChange={(e) => setF({ ...f, apps: e.target.checked ? [...f.apps, a.name] : f.apps.filter((x) => x !== a.name) })} />
                    {a.name === "minswap" ? "Minswap: swap within this budget" : a.name}
                  </label>
                ))}
              </span>
            ) : <span className="faint">No apps enabled on this vault. <Link to={`/v/${policy}/apps`}>Enable one</Link> first.</span>
          ), "A swap spends its amount plus Minswap's 2 ADA deposit, the batcher fee and the cancel tip from this budget. What comes back goes to the treasury, not to the agent.")}
          {!unit && field("fund", "Fund from the treasury", <><input id="fund" value={f.fund} onChange={set("fund")} style={{ width: 120 }} /> <span className="faint">ADA</span></>)}
          {d && (
            <div style={{ padding: 14 }}>
              <Signers owners={d.cfg.owners} threshold={threshold} me={o.me.pkh} value={signers} onChange={setSigners} />
            </div>
          )}
          {unit && d && (
            <div className="row">
              <div style={{ display: "flex", flexDirection: "column" }}><b>Revoke</b><span className="faint" style={{ fontSize: 12 }}>Removes this allowance; its funds go back to the treasury. Needs {threshold} owners. To stop it right now, pause the vault.</span></div>
              <button type="button" className="btn stop" disabled={!!busy || signers.length !== threshold} onClick={() => void propose({ op: "revoke", unit, signers }, "Revoke proposed.")}>Propose revoke</button>
            </div>
          )}
        </section>
        <div style={{ flex: "1 1 340px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          <section className="panel">
            <div className="ph"><span className="cap">In plain words</span></div>
            <div style={{ padding: 14 }}>{live}</div>
            {d?.al && next && (
              <table className="t cards"><thead><tr><th>Rule</th><th>On-chain now</th><th>After signing</th></tr></thead><tbody>
                <tr><td className="lead">Sentence</td><td data-label="On-chain now" className="wide">{sentence(d.al, d.al.destinations.length)}</td><td data-label="After signing" className="wide" style={{ color: "#e0452b" }}>{sentence(next, next.destinations.length)}</td></tr>
              </tbody></table>
            )}
            <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              {problems.map((p) => <ErrorNote key={p} error={p} />)}
              {busy && <div className="note"><Spinner label={busy} /></div>}
              {note && !proposed && <div className="note">{note} <Link to="/">Needs you</Link></div>}
              <ErrorNote error={err ?? loaded.error} />
            </div>
          </section>
          {unit && (
            <section className="panel">
              <div className="ph"><h2>Connect agent</h2></div>
              <div className="kvrow"><span>Vault id</span><span className="mono">{short(vaultId)} <Copy text={vaultId} /></span></div>
              <div className="kvrow"><span>Allowance id</span><span className="mono">{short(unit)} <Copy text={unit} /></span></div>
              <div className="kvrow">
                <span>Agent token</span>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {token ? <><span className="mono">{short(token)}</span><Copy text={token} /></> : <span className="faint">shown once when issued</span>}
                  <button type="button" className="btn" onClick={() => void api.agentToken(policy, unit).then((t) => setToken(t.token), (e) => setErr((e as Error).message))}>{token ? "Rotate" : "Issue token"}</button>
                </span>
              </div>
              {token && <div className="note" style={{ margin: "0 14px" }}>Copy it now: it isn't shown again. Rotating stops the old token.</div>}
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="cap">On the signer's machine (its own OS user):</span>
                <pre>{`VAULT_HOME=~/.gendo-signer cli/vault vault join ${vaultId}
VAULT_HOME=~/.gendo-signer cli/vault signer start --key agent \\
  --allowance ${unit} \\
  --dest ${f.payees.join(",") || "<payee>"} \\
  --allow-cosigned --socket ~/.gendo-signer/signer.sock`}</pre>
                <span className="cap">The agent's MCP config:</span>
                <pre>{JSON.stringify({ mcpServers: { gendo: { command: "/path/to/gendo/mcp/gendo-mcp", args: ["--allowance", unit, "--signer-socket", "~/.gendo-signer/signer.sock"], env: { VAULT_HOME: "/path/to/agent-home", VAULT_NETWORK: o.net, BLOCKFROST_PROJECT_ID: "preprod…", GENDO_SERVER: location.origin, GENDO_AGENT_TOKEN: token ?? "<issue a token above>" } } } }, null, 2)}</pre>
              </div>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

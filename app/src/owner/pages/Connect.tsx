// Connect an agent: name it, get a pairing code, install gendo-agent in the AI app (the code rides along
// or is pasted once), check the three words match, then set its budget. No terminal, no key to copy.
import { useEffect, useState } from "react";
import { Spinner } from "../../ui/Brand.tsx";
import { navigate } from "../../route.ts";
import { api, type Pairing } from "../api.ts";
import { CLAUDE_BUNDLE, configLine, cursorLink, lmStudioLink, mcpConfig } from "../install.ts";
import { Copy, ErrorNote, Link, Shell, useOwner, usePoll } from "../ui.tsx";

type Step = { at: "name" } | { at: "code"; id: string; code: string; expiresAt: number; pairing?: Pairing };

export function ConnectAgent({ policy }: { policy: string }) {
  const o = useOwner();
  const mine = o.vaults.find((v) => v.policy === policy);
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>({ at: "name" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const start = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const p = await api.createPairing(policy, name.trim());
      setStep({ at: "code", ...p });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pairing = step.at === "code" ? step.pairing : undefined;
  usePoll(async () => {
    if (step.at !== "code") return;
    const p = await api.pairing(step.id).catch(() => undefined);
    if (!p) return;
    if (p.status === "confirmed") return navigate(`/v/${policy}/agents/new?pairing=${step.id}`);
    setStep({ ...step, pairing: p });
  }, step.at === "code" && pairing?.status !== "expired", 3_000);

  const answer = async (match: boolean) => {
    if (step.at !== "code") return;
    setBusy(true);
    setErr(undefined);
    try {
      if (match) {
        await api.confirmPairing(step.id);
        navigate(`/v/${policy}/agents/new?pairing=${step.id}`);
      } else {
        await api.cancelPairing(step.id);
        setStep({ at: "name" });
        setErr("Cancelled: those words came from a different agent. Nothing was connected. Get a new code and try again.");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = (
    <>
      <Link to={`/v/${policy}`}>{mine?.name ?? "Vault"}</Link>
      <span className="faint">/</span>
      <Link to={`/v/${policy}/agents`}>Agents</Link>
      <span className="faint">/</span>
      <span>Connect an agent</span>
    </>
  );
  if (!mine) return <Shell title="Connect an agent"><div style={{ padding: 20 }} data-ready><p>Add this vault on <Link to="/vaults">All vaults</Link> first.</p></div></Shell>;
  if (mine.version === 1) return <Shell title="Connect an agent"><div style={{ padding: 20 }} data-ready><p>This vault runs an older version. <Link to={`/v/${policy}`}>Move it to the new version</Link> first, then connect agents there.</p></div></Shell>;

  const origin = location.origin;
  const left = step.at === "code" ? Math.max(0, Math.floor((step.expiresAt - now) / 1000)) : 0;
  const expired = step.at === "code" && (pairing?.status === "expired" || left === 0);
  const appConfig = step.at === "code" ? JSON.stringify({ mcpServers: { gendo: mcpConfig(step.code, origin) } }, null, 2) : "";

  return (
    <Shell policy={policy} tab="agents" title={title}>
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 760 }} data-ready>
        {step.at === "name" && (
          <section className="panel">
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ margin: 0 }}>Give an AI assistant its own budget from this vault. It works with Claude Desktop, Cursor, LM Studio and any app that supports MCP, including local models.</p>
              <label className="cap" htmlFor="pname">Name this agent</label>
              <input id="pname" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="My Claude" />
              <div><button type="button" className="btn pri" disabled={busy || !name.trim()} onClick={() => void start()}>Get a pairing code</button></div>
            </div>
          </section>
        )}

        {step.at === "code" && pairing?.status !== "claimed" && !expired && (
          <>
            <section className="panel">
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                <span className="cap">Pairing code for {name.trim()}</span>
                <span className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2 }}>{step.code}</span>
                <span className="faint" style={{ fontSize: 12 }}>Works once, for the next {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</span>
              </div>
            </section>
            <section className="panel">
              <div className="ph"><h2>Install it in your AI app</h2></div>
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <b>Claude Desktop</b>
                  <div className="faint" style={{ fontSize: 12, margin: "2px 0 6px" }}>Download the file, double-click it, and paste the code above when Claude asks.</div>
                  <a className="btn" href={CLAUDE_BUNDLE} download="gendo.mcpb">Download for Claude Desktop</a>
                </div>
                <div>
                  <b>Cursor or LM Studio</b>
                  <div className="faint" style={{ fontSize: 12, margin: "2px 0 6px" }}>One click; the code is already in it.</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <a className="btn" href={cursorLink(step.code, origin)}>Add to Cursor</a>
                    <a className="btn" href={lmStudioLink(step.code, origin)}>Add to LM Studio</a>
                  </div>
                </div>
                <details>
                  <summary style={{ cursor: "pointer" }}><b>Other apps</b> <span className="faint">(Jan, Open WebUI and anything that reads an MCP config)</span></summary>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                    <span className="faint" style={{ fontSize: 12 }}>Add this to the app's MCP settings. It needs Node.js on that computer.</span>
                    <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 }}>{appConfig}</pre>
                    <div style={{ display: "flex", gap: 8 }}><Copy text={appConfig} label="Copy config" /><Copy text={configLine(step.code, origin)} label="Copy as one command" /></div>
                  </div>
                </details>
              </div>
            </section>
            <div className="note"><Spinner label="Waiting for your agent to start. Once it does, you'll check three words here." /></div>
          </>
        )}

        {step.at === "code" && pairing?.status === "claimed" && pairing.words && (
          <section className="panel">
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
              <span className="cap">Check it's your agent</span>
              <span>Your agent says:</span>
              <span className="mono" style={{ fontSize: 24, fontWeight: 700 }}>{pairing.words}</span>
              <span className="faint" style={{ fontSize: 12 }}>Ask your AI "what's my gendo connection status?" It shows the same three words if it's the agent you just installed.</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn pri" disabled={busy} onClick={() => void answer(true)}>They match</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void answer(false)}>They don't</button>
              </div>
            </div>
          </section>
        )}

        {expired && pairing?.status !== "claimed" && (
          <section className="panel">
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
              <span>That code expired before an agent used it.</span>
              <button type="button" className="btn pri" disabled={busy} onClick={() => void start()}>Get a new code</button>
            </div>
          </section>
        )}
        <ErrorNote error={err} />
      </div>
    </Shell>
  );
}

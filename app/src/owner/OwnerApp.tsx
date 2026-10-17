import { useCallback, useEffect, useState } from "react";
import type { LucidEvolution } from "../../../sdk/src/core/index.ts";
import type { Route } from "../route.ts";
import { Netband, Spinner } from "../ui/Brand.tsx";
import { SERVER_DOWN, api, session, type MyVault } from "./api.ts";
import { openChain, readThroughSession } from "./chain.ts";
import { consistentVaults, staleCount } from "./vaults.ts";
import { AgentEditor } from "./pages/AgentEditor.tsx";
import { ConnectAgent } from "./pages/Connect.tsx";
import { Create } from "./pages/Create.tsx";
import { Inbox } from "./pages/Inbox.tsx";
import { Connect, Start } from "./pages/Start.tsx";
import { VaultPage } from "./pages/Vault.tsx";
import type { Net } from "./types.ts";
import { OwnerCtx, type Owner } from "./ui.tsx";
import { connectWallet, withChainCheckedUtxos, type Connected } from "./wallet.ts";

export default function OwnerApp({ route, network }: { route: Route; network: Net }) {
  const [lucid, setLucid] = useState<LucidEvolution>();
  const [fatal, setFatal] = useState<string>();
  const [me, setMe] = useState<Connected>();
  const [vaults, setVaults] = useState<MyVault[]>([]);
  const [needYou, setNeedYou] = useState<Record<string, number>>({});
  const [down, setDown] = useState(false);
  // Vaults saved before an update that changed the vault's code: their ids no longer derive their address.
  const [stale, setStale] = useState(0);
  const RESET_KEY = "gendo.reset.apps-v1";
  const [resetSeen, setResetSeen] = useState(() => {
    try {
      return localStorage.getItem(RESET_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    openChain(network)
      .then(async (l) => {
        if (import.meta.env.VITE_TEST_WALLETS === "1") (await import("./testwallet.ts")).installTestWallet(l);
        setLucid(l);
      })
      // /chain is on our server: if it can't be reached at all, say so with the CLI fallback.
      .catch((e) => setFatal(e instanceof TypeError ? SERVER_DOWN : "The chain is unavailable right now. Try again in a minute."));
  }, [network]);

  // A session in this tab: reconnect the same wallet quietly.
  useEffect(() => {
    const s = session.get();
    if (!lucid || !s || me) return;
    connectWallet(s.walletId)
      .then((c) => (c.pkh === s.pkh ? setMe(c) : session.clear()))
      .catch(() => session.clear());
  }, [lucid]);

  useEffect(() => {
    if (!lucid || !me) return;
    readThroughSession(lucid);
    // The wallet's own coin list can lag a tx it didn't submit: build only on coins the chain says are unspent.
    lucid.selectWallet.fromAPI(withChainCheckedUtxos(me.api, (address) => lucid.utxosAt(address)) as never);
  }, [lucid, me]);

  useEffect(() => {
    const on = () => setDown(true);
    addEventListener("gendo:server-down", on);
    return () => removeEventListener("gendo:server-down", on);
  }, []);

  const reloadVaults = useCallback(async () => {
    try {
      const list = await api.myVaults();
      setVaults(consistentVaults(list));
      setStale(staleCount(list));
      setDown(false);
    } catch (e) {
      if ((e as Error).message === SERVER_DOWN) setDown(true);
    }
  }, []);
  const reloadInbox = useCallback(async () => {
    try {
      const rows = await api.myPending();
      const counts: Record<string, number> = {};
      for (const p of rows) if (p.status === "open" && p.requiredSigners.includes(me?.pkh ?? "") && !p.signedBy.includes(me?.pkh ?? "")) counts[p.policy] = (counts[p.policy] ?? 0) + 1;
      setNeedYou(counts);
    } catch {
      // the banner covers a down server
    }
  }, [me]);
  useEffect(() => {
    if (!me) return;
    void reloadVaults();
    void reloadInbox();
    const t = setInterval(() => void reloadInbox(), 30_000);
    return () => clearInterval(t);
  }, [me]);

  if (fatal) return <div className="app" data-error><Netband /><p style={{ padding: 20 }}>{fatal}</p></div>;
  if (!lucid) return <div className="app"><Netband /><div className="boot"><Spinner label="Connecting to the chain…" /></div></div>;
  if (!me) return <Connect onConnected={setMe} />;
  const ctx: Owner = {
    net: network, lucid, me, vaults, reloadVaults, needYou, inboxCount: Object.values(needYou).reduce((a, b) => a + b, 0), reloadInbox,
    signOut: () => {
      session.clear();
      setMe(undefined);
    },
  };
  return (
    <OwnerCtx.Provider value={ctx}>
      {down && (
        <div className="err" role="alert" style={{ background: "#15120f", border: "1px dashed #4a2a24" }}>
          <span style={{ fontWeight: 700 }}>{SERVER_DOWN}</span>
          <button type="button" className="btn" onClick={() => void reloadVaults()}>Retry</button>
        </div>
      )}
      {stale > 0 && !resetSeen && (
        <div className="note" role="status" style={{ margin: "12px 20px 0", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <span>gendo was updated, and vaults created before the update aren't shown ({stale}). Their funds are safe on chain; <a href="https://github.com/gendo-cash/gendo#vaults-from-before-the-apps-update" target="_blank" rel="noopener noreferrer">here is how to move them out</a>.</span>
          <button type="button" className="btn" onClick={() => { try { localStorage.setItem(RESET_KEY, "1"); } catch { /* shown again next time */ } setResetSeen(true); }}>Got it</button>
        </div>
      )}
      {route.page === "inbox" && <Inbox />}
      {route.page === "vaults" && <Start />}
      {route.page === "create" && <Create />}
      {route.page === "connect" && <ConnectAgent policy={route.policy} />}
      {route.page === "vault" && <VaultPage policy={route.policy} tab={route.tab} />}
      {route.page === "agent" && <AgentEditor policy={route.policy} {...(route.unit ? { unit: route.unit } : {})} />}
      {route.page === "missing" && <div className="app" data-ready><p style={{ padding: 20 }}>Not found.</p></div>}
    </OwnerCtx.Provider>
  );
}

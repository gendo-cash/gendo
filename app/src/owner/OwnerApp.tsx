import { useCallback, useEffect, useState } from "react";
import type { LucidEvolution } from "../../../sdk/src/core/index.ts";
import type { Route } from "../route.ts";
import { Netband, Spinner } from "../ui/Brand.tsx";
import { SERVER_DOWN, api, session } from "./api.ts";
import { openChain, readLight, readThroughSession } from "./chain.ts";
import { knownVaults, type SavedVault } from "./vaults.ts";
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
  const [vaults, setVaults] = useState<SavedVault[]>([]);
  const [needYou, setNeedYou] = useState<Record<string, number>>({});
  const [down, setDown] = useState(false);
  const RESET_KEY = "gendo.old-version.v1";
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
      const list = knownVaults(await api.myVaults());
      // A vault from before apps that has been moved holds only its settings deposit: nothing left to show.
      const moved = new Set(
        (await Promise.all(list.filter((v) => v.version === 1).map(async (v) => {
          const view = await readLight(v.policy, network).catch(() => undefined);
          return view && view.treasuryLovelace === 0n && !view.allowances.length ? [v.policy] : [];
        }))).flat(),
      );
      setVaults(list.filter((v) => !moved.has(v.policy)));
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
    banner: vaults.some((v) => v.version === 1) && !resetSeen && (
        <div className="note" role="status" style={{ margin: "16px 20px 0", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <span>gendo was updated. Vaults marked "older version" still work for their agents, but can't use apps or be changed. Open one to move it to the new version.</span>
          <button type="button" className="btn" onClick={() => { try { localStorage.setItem(RESET_KEY, "1"); } catch { /* shown again next time */ } setResetSeen(true); }}>Got it</button>
        </div>
      ),
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
      {route.page === "inbox" && <Inbox />}
      {route.page === "vaults" && <Start />}
      {route.page === "create" && <Create />}
      {route.page === "connect" && <ConnectAgent policy={route.policy} />}
      {route.page === "vault" && <VaultPage policy={route.policy} tab={route.tab} {...(route.app ? { app: route.app } : {})} />}
      {route.page === "agent" && <AgentEditor policy={route.policy} {...(route.unit ? { unit: route.unit } : {})} />}
      {route.page === "missing" && <div className="app" data-ready><p style={{ padding: 20 }}>Not found.</p></div>}
    </OwnerCtx.Provider>
  );
}

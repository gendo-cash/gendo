import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucidEvolution } from "../../../sdk/src/core/index.ts";
import { navigate } from "../route.ts";
import { Avatar, Mark, Netband } from "../ui/Brand.tsx";
import type { MyVault } from "./api.ts";
import type { Net } from "./types.ts";
import { sidebarVaults } from "./vaults.ts";
import { wallets, type Connected } from "./wallet.ts";

export type Owner = { net: Net; lucid: LucidEvolution; me: Connected; vaults: MyVault[]; reloadVaults(): Promise<void>; needYou: Record<string, number>; inboxCount: number; reloadInbox(): Promise<void>; signOut(): void };
export const OwnerCtx = createContext<Owner | null>(null);
export const useOwner = () => useContext(OwnerCtx)!;

export const short = (s: string) => (s.length > 20 ? `${s.slice(0, 12)}…${s.slice(-4)}` : s);

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [s, setS] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  const quiet = useRef(false);
  useEffect(() => {
    let live = true;
    // A background refresh keeps showing the current data; a first load shows "loading".
    if (!quiet.current) setS((x) => ({ ...x, loading: true }));
    quiet.current = false;
    fn().then((data) => live && setS({ data, loading: false }), (e) => live && setS({ error: (e as Error).message, loading: false }));
    return () => {
      live = false;
    };
  }, [...deps, n]);
  return {
    ...s,
    reload: useCallback(() => setN((x) => x + 1), []),
    refresh: useCallback(() => {
      quiet.current = true;
      setN((x) => x + 1);
    }, []),
  };
}

/** Run `fn` every `ms` while `active`. */
export function usePoll(fn: () => void, active: boolean, ms = 5_000) {
  // The latest callback, without restarting the timer: a page that re-renders more often than `ms`
  // (a countdown, say) would otherwise never let the interval fire.
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => latest.current(), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a href={to} className={className} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(to); }}>
      {children}
    </a>
  );
}

export function ErrorNote({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <div className="err" role="alert" style={{ background: "#15120f", border: "1px solid #3a332b", borderRadius: 8 }}>
      <span style={{ display: "flex", gap: 10, alignItems: "center" }}><span className="ico" style={{ background: "#e0452b", color: "#efe7d8" }}>!</span><span style={{ fontWeight: 700 }}>{error}</span></span>
    </div>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn" style={{ minHeight: 24, padding: "2px 8px", fontSize: 12 }} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); }}>
      {done ? "Copied" : label}
    </button>
  );
}

/** You, then the next owners in order, up to the threshold: a sensible first pick to change. */
export const defaultSigners = (owners: string[], threshold: number, me: string) => [me, ...owners.filter((o) => o !== me)].slice(0, Math.max(1, threshold));

/** Pick exactly `threshold` co-signers; the proposer is always one of them. */
export function Signers({ owners, threshold, me, value, onChange }: { owners: string[]; threshold: number; me: string; value: string[]; onChange(v: string[]): void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
      <legend className="cap" style={{ marginBottom: 6 }}>Who signs ({value.length} of {threshold} picked)</legend>
      {owners.map((o) => (
        <label key={o} className="opt" style={{ border: "1px solid #2a241e" }}>
          <input type="checkbox" checked={value.includes(o)} disabled={o === me} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} />
          <span className="mono">{o === me ? "You" : `key ${short(o)}`}</span>
        </label>
      ))}
      {value.length !== threshold && <span className="hint" style={{ gridColumn: "auto" }}>Pick exactly {threshold}. Only the owners you pick can sign this proposal.</span>}
    </fieldset>
  );
}

// Sidebar icons: 20×20 strokes in the text's color.
const ICONS: Record<string, string> = {
  inbox: "M3 11.5l2-6.5h10l2 6.5v3.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 11.5h4l1 2h4l1-2h4",
  agents: "M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 17c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5",
  activity: "M2.5 10h3.5l2-5 4 10 2-5h3.5",
  treasury: "M3 7.5l7-4 7 4M4.5 8.5v6M8.5 8.5v6M11.5 8.5v6M15.5 8.5v6M3 16.5h14",
  settings: "M3.5 6h8M15.5 6h1M3.5 14h1M8.5 14h8M13.5 4v4M6.5 12v4",
  apps: "M7 2.5v4M13 2.5v4M4.5 6.5h11v3a5.5 5.5 0 0 1-11 0zM10 15v2.5",
  public: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM2.5 10h15M10 2.5c2 2 3 4.5 3 7.5s-1 5.5-3 7.5c-2-2-3-4.5-3-7.5s1-5.5 3-7.5z",
  all: "M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z",
  create: "M10 4v12M4 10h12",
  out: "M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12.5 13.5L16 10l-3.5-3.5M16 10H8",
};
const Icon = ({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d={ICONS[name]} /></svg>
);
const TAB_ICON = { agents: "agents", activity: "activity", treasury: "treasury", apps: "apps", settings: "settings" } as const;

export function Shell({ policy, tab, title, actions, children }: { policy?: string; tab?: string; title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const o = useOwner();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  const path = location.pathname;
  const count = (n?: number) => (n ? <span className="count">{n}</span> : null);
  const nav = (to: string, label: ReactNode, on: boolean, extra?: ReactNode, cls = "nav") => (
    <Link key={to} to={to} className={on ? `${cls} on` : cls}>{label}{extra}</Link>
  );
  const shown = sidebarVaults(o.vaults, o.needYou, policy);
  const icon = wallets().find((w) => w.id === o.me.id)?.icon;
  const walletName = o.me.name ? o.me.name[0]!.toUpperCase() + o.me.name.slice(1) : "Wallet";
  return (
    <div className="app frame">
      <Netband />
      <div className="mbar">
        <Link to="/" className="brand"><Mark /><span>gendo</span></Link>
        <button type="button" className="menu" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(true)}>
          {o.inboxCount ? <span className="count">{o.inboxCount}</span> : null}
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></svg>
        </button>
      </div>
      <div className="shell">
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <nav className={open ? "side open" : "side"} aria-label="Main" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          <div className="brandrow">
            <Link to="/" className="brand"><Mark /><span>gendo</span></Link>
            <button type="button" className="menu close" aria-label="Close menu" onClick={() => setOpen(false)}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          </div>
          {nav("/", <><Icon name="inbox" />Needs you</>, path === "/", count(o.inboxCount))}
          <div className="sidecap cap">Vaults</div>
          {shown.map((v) => (
            <div key={v.policy} className={v.policy === policy ? "vcard cur" : "vcard"}>
              {nav(`/v/${v.policy}`, <><Avatar id={v.policy} kind="vault" size={24} /><span className="vname">{v.name ?? "Unnamed vault"}</span></>, false, count(o.needYou[v.policy]), "nav vhead")}
              {v.policy === policy && (
                <div className="subnav">
                  {(["agents", "activity", "treasury", "apps", "settings"] as const).map((t) => nav(`/v/${policy}/${t}`, <><Icon name={TAB_ICON[t]} />{t[0]!.toUpperCase() + t.slice(1)}</>, tab === t))}
                  <a className="nav" href={`/w/${policy}`}><Icon name="public" />Public page</a>
                </div>
              )}
            </div>
          ))}
          {!o.vaults.length && <span className="faint" style={{ padding: "4px 10px", fontSize: 12 }}>No vaults yet.</span>}
          {nav("/vaults", <><Icon name="all" />View all vaults{o.vaults.length > shown.length ? <span className="faint">{o.vaults.length}</span> : null}</>, path === "/vaults", undefined, "nav more")}
          {nav("/new", <><Icon name="create" />Create a vault</>, path === "/new", undefined, "nav more")}
          <div style={{ flexGrow: 1, minHeight: 16 }} />
          {leaving ? (
            <div className="who ask" role="group" aria-label="Disconnect">
              <span style={{ fontSize: 13 }}>Disconnect {walletName}? You'll sign in again to come back.</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn" onClick={() => setLeaving(false)}>Cancel</button>
                <button type="button" className="btn stop" onClick={o.signOut}>Disconnect</button>
              </span>
            </div>
          ) : (
          <div className="who">
            {icon ? <img src={icon} alt="" width={28} height={28} /> : <span className="wico" aria-hidden="true">{walletName[0]}</span>}
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
              <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.me.address}>{short(o.me.address)}</span>
              <span className="faint" style={{ fontSize: 11 }}>{walletName}</span>
            </span>
            <button type="button" className="menu" aria-label="Disconnect" title="Disconnect" onClick={() => setLeaving(true)}>
              <Icon name="out" size={18} />
            </button>
          </div>
          )}
        </nav>
        <div className="content">
          <div className="top"><div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minWidth: 0 }}>{title}</div><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div></div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** A status as one icon (its words in the tooltip). `spinning`: false when another spinner is showing. */
export function StatusIcon({ status, spinning }: { status: { label: string; tone: string; needsYou: boolean; hint?: string }; spinning: boolean }) {
  const svg = (color: string, path: ReactNode) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
  );
  const waitingChain = status.label === "Waiting for the chain";
  const icon =
    status.label === "Landed" ? svg("#b9afa0", <><circle cx="10" cy="10" r="8" /><path d="M6.5 10.2l2.4 2.3 4.6-5" /></>)
    : status.tone === "dead" ? svg("#e0452b", <><circle cx="10" cy="10" r="8" /><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" /></>)
    : waitingChain ? (spinning ? <span className="spin" aria-hidden="true" style={{ width: 16, height: 16 }} /> : svg("#8f8578", <><circle cx="10" cy="10" r="8" /><path d="M10 5.5V10l3 2" /></>))
    : status.needsYou ? svg("#e0452b", <path d="M12.8 3.6l3.6 3.6-8.6 8.6H4.2v-3.6z M11 5.4l3.6 3.6" />)
    : svg("#8f8578", <><circle cx="10" cy="10" r="8" /><path d="M10 5.5V10l3 2" /></>);
  return (
    <span role="img" aria-label={status.label} title={status.label} style={{ display: "inline-flex", alignItems: "center" }}>
      {icon}
    </span>
  );
}

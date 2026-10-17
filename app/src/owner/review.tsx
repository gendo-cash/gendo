// The one review step every signature goes through. A proposal is built, explained from the tx
// and (on preprod) hash-checked chain data, and shown here; only then does the wallet open.
import { appFor } from "../../../sdk/src/core/apps/catalogue.ts";
import { minswapAdapter } from "../../../sdk/src/core/apps/minswap/adapter.ts";
import { useState } from "react";
import { CML, credentialToAddress, explainTx, fromPlutusAddress, refHolderAddress, type AllowanceDatum, type Vault } from "../../../sdk/src/core/index.ts";
import { inputsOf } from "./chain.ts";
import { detailOf, type Ctx, type Detail } from "./diff.ts";
import { buildRecipe, type Recipe } from "./recipes.ts";
import { needsConfirm } from "./status.ts";
import { ErrorNote, short, type Owner } from "./ui.tsx";
import { Chain } from "../ui/Brand.tsx";

/** How the explanation is read for this owner: every key their wallet holds counts as theirs. */
export function ctxFor(o: Owner, vault: Vault, labels: Record<string, string>, recipe?: Ctx["recipe"]): Ctx {
  const isMine = (address: string) => {
    try {
      return o.me.keys.includes(CML.Address.from_bech32(address).payment_cred()?.as_pub_key()?.to_hex() ?? "");
    } catch {
      return false;
    }
  };
  return {
    viewer: o.me.pkh, vaultAddress: vault.address, refHolder: refHolderAddress(o.net), agentAddress: (pkh: string) => credentialToAddress(o.net, { type: "Key", hash: pkh }), labels, isMine, short, recipe: recipe ?? null,
    payeesOf: (d: AllowanceDatum) => d.destinations.map((a) => fromPlutusAddress(o.net, a)),
    appScripts: appFor("minswap", o.net) ? { minswap: { adapter: minswapAdapter(o.net).hash, orderScript: appFor("minswap", o.net)!.network.deployment.orderScript } } : {},
  };
}

export type Prepared = { cbor: string; detail: Detail; verified: boolean };

/** Explain any tx for this owner. */
export async function explainFor(o: Owner, vault: Vault, cbor: string, labels: Record<string, string>, recipe?: Ctx["recipe"]): Promise<Prepared> {
  const { utxos, verified } = await inputsOf(o.lucid, cbor, o.net);
  const e = explainTx(cbor, vault, utxos, { viewer: o.me.keys });
  return { cbor, detail: detailOf(e, ctxFor(o, vault, labels, recipe)), verified };
}

/** Build a recipe and explain it, ready for review. */
export async function prepare(o: Owner, vault: Vault, r: Recipe, labels: Record<string, string>): Promise<Prepared> {
  const tx = await buildRecipe(o.lucid, vault, r, o.me.pkh);
  return explainFor(o, vault, tx.toCBOR(), labels);
}

/** What a tx does: the summary, warnings, rule-by-rule diff, sentences and money. */
export function DetailView({ detail, verified, network }: { detail: Detail; verified: boolean; network: string }) {
  const req = detail.kind === "Agent request";
  return (
    <>
      <div>{detail.summary}</div>
      {!verified && <div className="note faint">Devnet: inputs were read from the indexer, not checked against their tx hashes.</div>}
      {detail.warnings.map((w) => <ErrorNote key={w} error={`Careful: ${w}.`} />)}
      {detail.rows.length > 0 && (
        <div className="scroll">
          <table className="t cards" style={{ border: "1px solid #2a241e", borderRadius: 8, borderCollapse: "separate", borderSpacing: 0 }}>
            <thead><tr><th>{req ? "Field" : "Rule"}</th><th>{req ? "Value" : "On-chain now"}</th><th>{req ? "Against limit" : "After signing"}</th></tr></thead>
            <tbody>
              {detail.rows.map((r, i) => (
                <tr key={i}>
                  <td className="lead">{r.k}</td>
                  <td data-label={req ? "Value" : "On-chain now"} className="mono wide" style={{ wordBreak: "break-all", color: r.changed && !req ? "#8f8578" : undefined, textDecoration: r.changed && !req ? "line-through" : undefined }}>{r.now ? <Chain value={r.now} network={network} /> : "—"}</td>
                  <td data-label={req ? "Against limit" : "After signing"} className="mono wide" style={{ wordBreak: "break-all", color: r.changed ? "#e0452b" : "#b9afa0", fontWeight: r.changed ? 500 : 400 }}>{r.next ? <Chain value={r.next} network={network} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.before && detail.after && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 10 }}>
          <div className="note"><div className="cap">Now</div>{detail.before}</div>
          <div className="note" style={{ borderColor: "#e0452b" }}><div className="cap">After signing</div>{detail.after}</div>
        </div>
      )}
      {!detail.before && detail.after && <div className="note" style={{ borderColor: "#e0452b" }}><div className="cap">After signing</div>{detail.after}</div>}
      {detail.money.length > 0 && (
        <table className="t"><tbody>{detail.money.map((m) => <tr key={m.label}><td style={{ wordBreak: "break-all" }}>{m.label.startsWith("To ") ? <>To <Chain value={m.label.slice(3)} network={network} /></> : m.label}</td><td className="num">{m.value}</td></tr>)}</tbody></table>
      )}
    </>
  );
}

/** A review dialog: resolves true when the owner chooses to sign, false when they cancel. */
export function useReview(net: string) {
  const [s, setS] = useState<{ p: Prepared; resolve(ok: boolean): void; confirmed: boolean } | null>(null);
  const ask = (p: Prepared) => new Promise<boolean>((resolve) => setS({ p, resolve, confirmed: false }));
  const close = (ok: boolean) => {
    s?.resolve(ok);
    setS(null);
  };
  const panel = s && (
    <div role="dialog" aria-modal="true" aria-label="Review before signing" style={{ position: "fixed", inset: 0, background: "rgba(13,11,9,.78)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "48px 16px", overflowY: "auto", zIndex: 20 }}>
      <section className="panel" style={{ width: "100%", maxWidth: 760 }}>
        <div className="ph">
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span className="cap">Review before signing</span>
            <span style={{ fontWeight: 700, fontSize: 16 }}>{s.p.detail.title}</span>
          </div>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          <DetailView detail={s.p.detail} verified={s.p.verified} network={net} />
          <div className="faint" style={{ fontSize: 12 }}>Computed in your browser from the transaction and the chain. Your wallet shows the same transaction next.</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid #2a241e", paddingTop: 14 }}>
            <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
            {needsConfirm(s.p.detail) && !s.confirmed ? (
              <button type="button" className="btn stop" onClick={() => setS({ ...s, confirmed: true })}>I've read the warnings</button>
            ) : (
              <button type="button" className="btn pri" onClick={() => close(true)}>Sign with wallet</button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
  return { ask, panel };
}

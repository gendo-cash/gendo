// What a visitor should know first: this is an early preview on a test network, and more is coming.
import { useEffect, useState } from "react";
import { markNoticeSeen, noticeSeen } from "./notice.ts";

const store = () => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

export function Notice() {
  const [open, setOpen] = useState(() => {
    const s = store();
    return s ? !noticeSeen(s) : true;
  });
  useEffect(() => {
    const show = () => setOpen(true);
    addEventListener("gendo:notice", show);
    return () => removeEventListener("gendo:notice", show);
  }, []);
  if (!open) return null;
  const close = () => {
    const s = store();
    if (s) markNoticeSeen(s);
    setOpen(false);
  };
  return (
    // Outside the pages' own wrapper, so it takes the app's type and colours itself.
    <div className="app" role="dialog" aria-modal="true" aria-labelledby="notice-h" style={{ position: "fixed", minHeight: 0, inset: 0, background: "rgba(13,11,9,.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 30 }}>
      <section className="panel" style={{ width: "100%", maxWidth: 520 }}>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="cap">Early preview</span>
          <h2 id="notice-h" style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>You're using the current build</h2>
          <p style={{ margin: 0 }}>Gendo is becoming a burner wallet for your AI agent that you can take back: one click to start, and every payment waits in a short hold you can undo. That flow isn't built yet.</p>
          <p style={{ margin: 0 }}>What's here is the vault it's built on: owners, budgets and payees, enforced by the chain. It works, and it will change.</p>
          <p className="muted" style={{ margin: 0 }}>It runs on Cardano's preprod test network only, with test ADA that has no real value. The code hasn't been audited yet.</p>
          <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
            <button type="button" className="btn pri" autoFocus onClick={close}>Got it</button>
          </div>
        </div>
      </section>
    </div>
  );
}

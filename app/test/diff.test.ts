import { describe, expect, it } from "vitest";
import type { AllowanceDatum, Explanation } from "../../sdk/src/core/index.ts";
import { confirmWords } from "../../sdk/src/core/pairing.ts";
import { detailOf, sentence } from "../src/owner/diff.ts";
import { settingsToData } from "../../sdk/src/core/apps/minswap/data.ts";
import { needsConfirm } from "../src/owner/status.ts";

const h = (n: number) => n.toString(16).padStart(2, "0").repeat(28);
const al = (txCap: bigint, windowCap: bigint, payees = 3): AllowanceDatum => ({
  agent: h(9),
  destinations: Array.from({ length: payees }, (_, i) => ({ payment: { type: "Key", hash: h(20 + i) }, stake: null })),
  caps: [{ policy: "", name: "", windowCap, txCap }],
  spent: [0n], windowStart: 1_790_000_000_000n, periodMs: 86_400_000n, expiresAt: BigInt(Date.UTC(2026, 10, 30)), maxFee: 2_000_000n, apps: [],
});
const base: Omit<Explanation, "changes"> = { hash: "aa".repeat(32), requiredSigners: [h(1), h(2)], changes: [] as never, leavesVault: {}, flows: [], collateralAtRisk: [], fee: 300_000n, warnings: [] } as never;
const ctx = { viewer: h(1), vaultAddress: "addr_test1wvault", labels: { [h(5) + "01"]: "payout-bot" }, payeesOf: (d: AllowanceDatum) => d.destinations.map((_, i) => `addr_test1q${i}`), isMine: () => false, short: (s: string) => s.slice(0, 10) };

describe("detailOf: apps", () => {
  const c = { owners: [h(1), h(2)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] as never[] };
  const settings = settingsToData({ pools: ["e5358cee5d14b83d0a4e93f321c0c3addaf8fb5010a1127b6da6a8adc0a16fd3"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 86_400_000n, maxCancelTip: 500_000n });
  const app = { name: "minswap", adapter: h(0xad), orderScript: h(0x0d), settings };
  it("enabling Minswap shows each of its rules, with pool labels", () => {
    const d = detailOf({ ...base, changes: [{ kind: "config", before: c, after: { ...c, apps: [app] } }] }, ctx);
    expect(d.title).toBe("Enable Minswap");
    expect(d.rows).toContainEqual({ k: "Minswap pools", now: "—", next: "ADA ↔ NACRE", changed: true });
    expect(d.rows).toContainEqual({ k: "Minswap max slippage", now: "—", next: "3%", changed: true });
    expect(d.rows).toContainEqual({ k: "Minswap order lifetime", now: "—", next: "24 h", changed: true });
  });
  it("a different adapter or order script shows as rows, with a warning when it isn't gendo's", () => {
    const ctxN = { ...ctx, appScripts: { minswap: { adapter: h(0xad), orderScript: h(0x0d) } } };
    const swapped = { ...app, adapter: h(0xee) };
    const d = detailOf({ ...base, changes: [{ kind: "config", before: { ...c, apps: [app] }, after: { ...c, apps: [swapped] } }] }, ctxN);
    expect(d.rows).toContainEqual({ k: "Minswap adapter", now: h(0xad), next: h(0xee), changed: true });
    expect(d.warnings.join(" ")).toMatch(/Minswap adapter isn't the one gendo's catalogue lists/);
    const ok = detailOf({ ...base, changes: [{ kind: "config", before: c, after: { ...c, apps: [app] } }] }, ctxN);
    expect(ok.warnings.join(" ")).not.toMatch(/catalogue/);
  });
  it("disabling it says so", () => {
    expect(detailOf({ ...base, changes: [{ kind: "config", before: { ...c, apps: [app] }, after: c }] }, ctx).title).toBe("Disable Minswap");
  });
  it("an agent's apps show as a row", () => {
    const d = detailOf({ ...base, changes: [{ kind: "edit", unit: h(5) + "01", before: al(10_000_000n, 25_000_000n), after: { ...al(10_000_000n, 25_000_000n), apps: ["minswap"] }, lovelaceBefore: 1n, lovelaceAfter: 1n }] }, ctx);
    expect(d.rows).toContainEqual({ k: "Apps", now: "none", next: "Minswap", changed: true });
  });
});

describe("detailOf", () => {
  it("a budget raise: one changed row and the two sentences", () => {
    const d = detailOf({ ...base, changes: [{ kind: "edit", unit: h(5) + "01", before: al(10_000_000n, 25_000_000n), after: al(10_000_000n, 40_000_000n), lovelaceBefore: 60_000_000n, lovelaceAfter: 60_000_000n }] }, ctx);
    expect(d).toMatchObject({ kind: "Change", title: "Change payout-bot" });
    expect(d.rows.filter((r) => r.changed)).toEqual([{ k: "Budget", now: "25 ADA / day", next: "40 ADA / day", changed: true }]);
    expect(d.before).toBe("This agent can pay up to 10 ADA at a time and 25 ADA per day, only to these 3 addresses, until 2026-11-30.");
    expect(d.after).toContain("40 ADA per day");
  });
  it("a pause and an unpause", () => {
    const c = { owners: [h(1), h(2)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] };
    expect(detailOf({ ...base, changes: [{ kind: "config", before: c, after: { ...c, paused: true } }] }, ctx).title).toBe("Pause all agents");
    expect(detailOf({ ...base, changes: [{ kind: "config", before: { ...c, paused: true }, after: c }] }, ctx).title).toBe("Unpause");
  });
  it("an owner change lists who is added and removed", () => {
    const c = { owners: [h(1), h(2), h(3)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] };
    const d = detailOf({ ...base, changes: [{ kind: "config", before: c, after: { ...c, owners: [h(1), h(2), h(4)] } }] }, ctx);
    expect(d.title).toBe("Change owners or threshold");
    expect(d.rows).toContainEqual({ k: "Owner added", now: "—", next: h(4), changed: true });
    expect(d.rows).toContainEqual({ k: "Owner removed", now: h(3), next: "—", changed: true });
  });
  it("an agent request: payee, amount over the cap, the agent's words marked as its own", () => {
    const e = {
      ...base,
      changes: [{ kind: "spend" as const, unit: h(5) + "01", redeemer: "CoSignedSpend" as const, before: al(10_000_000n, 25_000_000n), after: al(10_000_000n, 25_000_000n) }],
      flows: [{ address: "addr_test1qpayee", delta: { lovelace: 18_000_000n } }, { address: "addr_test1wvault", delta: { lovelace: -18_300_000n } }],
      leavesVault: { lovelace: 18_300_000n },
    };
    const d = detailOf(e, { ...ctx, recipe: { intentId: "INV-44", purpose: "Bounty #44", reason: "posted at 18 ADA" } });
    expect(d).toMatchObject({ kind: "Agent request", title: "payout-bot wants to pay 18 ADA" });
    expect(d.summary).toMatch(/over its 10 ADA per-payment cap/);
    expect(d.rows).toContainEqual({ k: "Amount", now: "18 ADA", next: "over the 10 ADA cap", changed: true });
    expect(d.rows).toContainEqual({ k: "Agent's reason (not verified)", now: "posted at 18 ADA", next: "", changed: false });
  });
  it("money: what leaves the vault and what leaves your wallet", () => {
    const d = detailOf(
      { ...base, changes: [], leavesVault: { lovelace: 7_000_000n }, flows: [{ address: "addr_test1qme", delta: { lovelace: -1_300_000n } }, { address: "addr_test1qx", delta: { lovelace: 7_000_000n } }] },
      { ...ctx, isMine: (a: string) => a === "addr_test1qme" },
    );
    expect(d.title).toBe("Pay from the treasury");
    expect(d.money).toEqual([
      { label: "Leaves the vault", value: "7 ADA" },
      { label: "To addr_test1qx", value: "7 ADA" },
      { label: "From your wallet", value: "1.3 ADA" },
    ]);
  });
  it("warnings pass through and make signing need a confirm", () => {
    const d = detailOf({ ...base, changes: [], warnings: ["it removes you as an owner"] }, ctx);
    expect(d.warnings).toEqual(["it removes you as an owner"]);
    expect(needsConfirm(d)).toBe(true);
  });
  it("a grant from a pairing: the agent's collateral is named, not a mystery payment", () => {
    const d = detailOf({ ...base, changes: [{ kind: "grant", unit: h(5) + "01", after: al(10_000_000n, 25_000_000n, 1), lovelace: 40_000_000n }],
      flows: [{ address: "addr_test1vagent", delta: { lovelace: 5_000_000n } }] }, { ...ctx, agentAddress: (pkh: string) => (pkh === h(9) ? "addr_test1vagent" : "x") });
    expect(d.money).toContainEqual({ label: "Collateral for the agent (stays in its own address)", value: "5 ADA" });
  });
  it("sentence matches the public page's", () => expect(sentence(al(10_000_000n, 25_000_000n, 1), 1)).toBe("This agent can pay up to 10 ADA at a time and 25 ADA per day, only to this address, until 2026-11-30."));
  it("a creation: its owners and threshold, the reference script named, money into the vault", () => {
    const c = { owners: [h(1), h(2)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] };
    const d = detailOf({ ...base, changes: [{ kind: "config", before: null, after: c, deposit: 2_000_000n }],
      flows: [{ address: "addr_test1wvault", delta: { lovelace: 22_000_000n } }, { address: "addr_test1wholder", delta: { lovelace: 27_000_000n } }] }, { ...ctx, refHolder: "addr_test1wholder" });
    expect(d.title).toBe("Create this vault");
    expect(d.summary).toBe("Creates a vault with 2 owners. Any 2 of them approve changes; any one can pause.");
    expect(d.rows).toContainEqual({ k: "Owner added", now: "—", next: h(2), changed: true });
    expect(d.money).toContainEqual({ label: "Vault settings deposit (stays with the vault)", value: "2 ADA" });
    expect(d.money).toContainEqual({ label: "Into the treasury", value: "20 ADA" });
    expect(d.money.some((m) => m.label === "Into the vault")).toBe(false);
    // No deposit asked for: only the settings deposit shows.
    const none = detailOf({ ...base, changes: [{ kind: "config", before: null, after: c, deposit: 2_000_000n }], flows: [{ address: "addr_test1wvault", delta: { lovelace: 2_000_000n } }] }, ctx);
    expect(none.money.map((m) => m.label)).toEqual(["Vault settings deposit (stays with the vault)"]);
    expect(d.money).toContainEqual({ label: "Reference script (locked for good; it lowers every agent payment's fee)", value: "27 ADA" });
  });
});

describe("review screens show everything in full", () => {
  it("payees, owners and agent keys are never shortened; a payment to another script is not the treasury", () => {
    const d = detailOf({ ...base, changes: [{ kind: "grant", unit: h(5) + "02", after: al(5_000_000n, 20_000_000n, 1), lovelace: 30_000_000n }] }, ctx);
    expect(d.rows).toContainEqual({ k: "Agent key", now: "—", next: `${confirmWords(h(9))} (${h(9)})`, changed: true });
    expect(d.rows).toContainEqual({ k: "Payee added", now: "—", next: "addr_test1q0", changed: true });
    const other = detailOf({ ...base, changes: [], flows: [{ address: "addr_test1wsomeotherscript", delta: { lovelace: 5_000_000n } }] }, ctx);
    expect(other.title).not.toBe("Fund the treasury");
    expect(other.money).toContainEqual({ label: "To addr_test1wsomeotherscript", value: "5 ADA" });
  });
});

import { describe, expect, it } from "vitest";
import type { AllowanceDatum, Explanation } from "../../sdk/src/core/index.ts";
import { recipeMatches } from "../src/owner/recipes.ts";
import { editedDatum } from "../src/owner/validate.ts";

const h = (n: number) => n.toString(16).padStart(2, "0").repeat(28);
const U = h(5) + "01";
const ex = (changes: Explanation["changes"]): Explanation => ({ hash: "", requiredSigners: [], changes, leavesVault: {}, flows: [], collateralAtRisk: [], fee: 0n, warnings: [] });
const cfg = { owners: [h(1)], threshold: 1n, paused: false, maxTxValidityMs: 1n, apps: [] };

describe("rebuild only what the item was", () => {
  it("matches op and unit to what the dead tx changed", () => {
    expect(recipeMatches({ op: "pause" }, ex([{ kind: "config", before: cfg, after: { ...cfg, paused: true } }]))).toBe(true);
    expect(recipeMatches({ op: "revoke", unit: U, signers: [h(1)] }, ex([{ kind: "revoke", unit: U, before: null, lovelace: 1n }]))).toBe(true);
    expect(recipeMatches({ op: "revoke", unit: U, signers: [h(1)] }, ex([{ kind: "revoke", unit: h(6) + "01", before: null, lovelace: 1n }]))).toBe(false);
  });
  it("a recipe that does something else than the item is refused", () => {
    const grant = { op: "grant" as const, grant: {} as never, signers: [h(1)] };
    expect(recipeMatches(grant, ex([{ kind: "config", before: cfg, after: { ...cfg, paused: true } }]))).toBe(false);
    expect(recipeMatches({ op: "fund", lovelace: 1n }, ex([{ kind: "edit", unit: U, before: null, after: null, lovelaceBefore: 0n, lovelaceAfter: 0n }]))).toBe(false);
  });
});

describe("editing keeps what the form doesn't show", () => {
  const al: AllowanceDatum = {
    agent: h(9), destinations: [], windowStart: 0n, periodMs: 172_800_000n, expiresAt: 10n, maxFee: 1n, apps: [],
    caps: [{ policy: h(7), name: "74", windowCap: 100n, txCap: 10n }, { policy: "", name: "", windowCap: 25n, txCap: 10n }],
    spent: [40n, 3n],
  };
  const addr = (a: string) => ({ payment: { type: "Key" as const, hash: a }, stake: null });
  it("replaces the ADA cap in place, so spent counters stay aligned, and keeps a 2-day period", () => {
    const d = editedDatum(al, { perPayment: 5n, budget: 50n, period: undefined, payees: ["x"], expiresAt: 99n }, addr);
    expect(d.caps).toEqual([al.caps[0], { policy: "", name: "", windowCap: 50n, txCap: 5n }]);
    expect(d.spent).toEqual([40n, 3n]);
    expect(d.periodMs).toBe(172_800_000n);
  });
  it("adds an ADA cap to a token-only allowance with a zero counter", () => {
    const d = editedDatum({ ...al, caps: [al.caps[0]!], spent: [40n] }, { perPayment: 5n, budget: 50n, period: 86_400_000n, payees: [], expiresAt: 99n }, addr);
    expect(d.caps).toHaveLength(2);
    expect(d.spent).toEqual([40n, 0n]);
    expect(d.periodMs).toBe(86_400_000n);
  });
});

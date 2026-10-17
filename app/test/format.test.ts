// app/test/format.test.ts
import { describe, expect, it } from "vitest";
import { ada, allowanceSentence, cleanPurpose, fromNow, parsePolicy, paymentLine, periodName } from "../src/public/format.ts";

describe("format", () => {
  it("parses /w/<policy> and rejects anything else", () => {
    expect(parsePolicy("/w/" + "ab".repeat(28))).toBe("ab".repeat(28));
    for (const p of ["/w/", "/w/xyz", "/w/" + "ab".repeat(29), "/x/" + "ab".repeat(28)]) expect(parsePolicy(p)).toBeUndefined();
  });
  it("formats ADA without float noise", () => {
    expect([ada(10_000_000n), ada(1_500_000n), ada(364_003n), ada(0n)]).toEqual(["10", "1.5", "0.364003", "0"]);
  });
  it("names periods", () => {
    expect([periodName(86_400_000n), periodName(3_600_000n), periodName(604_800_000n), periodName(172_800_000n), periodName(90_000n)]).toEqual(["day", "hour", "week", "2 days", "90 seconds"]);
  });
  it("says what an agent may do in one sentence", () => {
    const s = allowanceSentence({
      unit: "u", txHash: "t", outputIndex: 0, lovelace: 0n, status: "active", payees: ["a", "b", "c"], periodMs: 86_400_000n, expiresAt: Date.UTC(2026, 10, 30),
      caps: [{ unit: "lovelace", perPayment: 10_000_000n, perPeriod: 25_000_000n, spentThisPeriod: 0n, leftThisPeriod: 25_000_000n }],
    });
    expect(s).toBe("This agent can pay up to 10 ADA at a time and 25 ADA per day, only to these 3 addresses, until 2026-11-30.");
  });
  it("adds the apps it may trade with", () => {
    const s = allowanceSentence({
      unit: "u", txHash: "t", outputIndex: 0, lovelace: 0n, status: "active", payees: ["a"], periodMs: 86_400_000n, expiresAt: Date.UTC(2026, 10, 30), apps: ["minswap"],
      caps: [{ unit: "lovelace", perPayment: 10_000_000n, perPeriod: 25_000_000n, spentThisPeriod: 0n, leftThisPeriod: 25_000_000n }],
    });
    expect(s).toBe("This agent can pay up to 10 ADA at a time and 25 ADA per day, only to this address, until 2026-11-30. It may also swap on Minswap, within the same limits.");
  });
  it("says so for a malformed allowance", () => {
    expect(allowanceSentence({ unit: "u", txHash: "t", outputIndex: 0, lovelace: 0n, status: "malformed", payees: [], caps: [] })).toBe("Malformed: the agent can't spend it, and owners can reclaim it.");
  });
  const row = { txHash: "t", time: 0, payees: [{ address: "a", lovelace: 4_000_000n }], fee: 367_842n, allowanceDelta: -4_367_842n };
  it("describes a payment from what the chain says, fee included", () => {
    expect(paymentLine({ ...row, kind: "agent" })).toBe("4 ADA to 1 payee + 0.367842 ADA fee, paid by the agent within its limits");
    expect(paymentLine({ ...row, kind: "co-signed", payees: [{ address: "a", lovelace: 1n }, { address: "b", lovelace: 2n }] })).toBe("0.000003 ADA to 2 payees + 0.367842 ADA fee, approved by owners");
  });
  it("describes a swap by what the order asked for and how it settled", () => {
    const trade = { app: "minswap" as const, pool: "ADA ↔ NACRE", lpName: "e5", sells: "lovelace", buys: "aa".repeat(28) + "4e41435245", amountIn: 5_000_000n, minimumReceive: 9_670_852n, orderTx: "b2", status: "pending" as const };
    expect(paymentLine({ ...row, kind: "trade", payees: [], trade })).toBe("Swap 5 ADA for at least 9670852 NACRE on Minswap (ADA ↔ NACRE), waiting for a batcher");
    expect(paymentLine({ ...row, kind: "trade", payees: [], trade: { ...trade, status: "filled", received: { lovelace: 2_000_000n, [trade.buys]: 9_700_000n } } })).toBe("Swap 5 ADA for at least 9670852 NACRE on Minswap (ADA ↔ NACRE), filled: 9700000 NACRE to the treasury");
    expect(paymentLine({ ...row, kind: "trade", payees: [], trade: { ...trade, status: "refunded", received: { lovelace: 7_500_000n } } })).toBe("Swap 5 ADA for at least 9670852 NACRE on Minswap (ADA ↔ NACRE), refunded: 7.5 ADA to the treasury");
  });
  it("describes an owner change by what it did to the allowance, not by the owner's change output", () => {
    expect(paymentLine({ ...row, kind: "owner", payees: [], allowanceDelta: 10_000_000n })).toBe("Owner change: allowance +10 ADA");
    expect(paymentLine({ ...row, kind: "owner", payees: [], allowanceDelta: -30_000_000n })).toBe("Owner change: allowance -30 ADA");
    expect(paymentLine({ ...row, kind: "unknown", payees: [], allowanceDelta: -1_500_000n })).toBe("Allowance -1.5 ADA");
  });
  it("cleans the agent's note: no control or direction characters, bounded length", () => {
    expect(cleanPurpose("hosting\u202e, October\n\u0000 ")).toBe("hosting, October");
    expect(cleanPurpose("x".repeat(500))).toBe("x".repeat(120) + "…");
  });
  it("says how far off a time is, roughly", () => {
    const now = 1_000_000_000_000;
    expect(fromNow(now + 40_000, now)).toBe("in under a minute");
    expect(fromNow(now + 5 * 60_000, now)).toBe("in 5 min");
    expect(fromNow(now + 15 * 3_600_000 + 20 * 60_000, now)).toBe("in 15 h");
    expect(fromNow(now + 3 * 86_400_000 + 3_600_000, now)).toBe("in 3 days");
    expect(fromNow(now + 86_400_000, now)).toBe("in 1 day");
    expect(fromNow(now - 1, now)).toBe("now");
  });
});

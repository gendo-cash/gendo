import { describe, expect, it } from "vitest";
import { agentProblems, buildError, createConfig, createOptions, createProblems, ownerHint, ownerKeyOf, toLovelace, type AgentForm, type CreateForm } from "../src/owner/validate.ts";
import { credentialToAddress } from "../../sdk/src/core/index.ts";

const ok: AgentForm = { name: "payout-bot", agentKey: "9".repeat(56), perPayment: "10", budget: "25", period: "day", payees: ["addr_test1qok"], expires: "2099-01-01", fund: "40", apps: [] };
const opts = { isNew: true, nowMs: Date.UTC(2026, 9, 13), owners: ["1".repeat(56)], isKeyAddress: (s: string) => s.startsWith("addr_test1q") };

describe("agent form", () => {
  it("accepts a sane agent", () => expect(agentProblems(ok, opts)).toEqual([]));
  it("refuses a cap above the budget: the chain would", () =>
    expect(agentProblems({ ...ok, perPayment: "30" }, opts)).toContain("The per-payment cap can't be above the budget: the chain refuses it."));
  it("refuses script or malformed payees, duplicates, none at all", () => {
    expect(agentProblems({ ...ok, payees: ["addr_test1wscript"] }, opts).join(" ")).toMatch(/isn't a wallet address/);
    expect(agentProblems({ ...ok, payees: ["addr_test1qok", "addr_test1qok"] }, opts).join(" ")).toMatch(/twice/);
    expect(agentProblems({ ...ok, payees: [] }, opts).join(" ")).toMatch(/at least one payee/);
  });
  it("refuses an agent key that is an owner, or isn't a key hash", () => {
    expect(agentProblems({ ...ok, agentKey: "1".repeat(56) }, opts).join(" ")).toMatch(/owner key/);
    expect(agentProblems({ ...ok, agentKey: "xyz" }, opts).join(" ")).toMatch(/56 hex/);
  });
  it("refuses a past expiry and empty amounts", () => {
    expect(agentProblems({ ...ok, expires: "2020-01-01" }, opts).join(" ")).toMatch(/future/);
    expect(agentProblems({ ...ok, perPayment: "" }, opts).join(" ")).toMatch(/per-payment cap/);
  });
  it("parses ADA amounts exactly", () => {
    expect([toLovelace("10"), toLovelace("0.5"), toLovelace("1.000001"), toLovelace("1.0000001"), toLovelace("-1"), toLovelace("x")]).toEqual([10_000_000n, 500_000n, 1_000_001n, undefined, undefined, undefined]);
  });
});

describe("create a vault", () => {
  const me = "11".repeat(28), b = "22".repeat(28);
  const bAddr = credentialToAddress("Preprod", { type: "Key", hash: b });
  const scriptAddr = credentialToAddress("Preprod", { type: "Script", hash: b });
  const f = (x: Partial<CreateForm> = {}): CreateForm => ({ name: "Team", owners: [bAddr], threshold: "2", windowMin: "10", fund: "0", refScript: false, ...x });
  it("an owner is a key hash or a testnet wallet address", () => {
    expect(ownerKeyOf(b, "Preprod")).toBe(b);
    expect(ownerKeyOf(bAddr, "Preprod")).toBe(b);
    expect(ownerKeyOf(scriptAddr, "Preprod")).toBeUndefined();
    expect(ownerKeyOf("addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", "Preprod")).toBeUndefined();
    expect(ownerKeyOf("hello", "Preprod")).toBeUndefined();
  });
  it("a sound form has no problems and makes the config", () => {
    expect(createProblems(f(), { me, net: "Preprod" })).toEqual([]);
    expect(createConfig(f(), me, "Preprod")).toEqual({ owners: [me, b], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] });
  });
  it("says what's wrong in plain words", () => {
    expect(createProblems(f({ name: " " }), { me, net: "Preprod" })).toContain("Name the vault.");
    expect(createProblems(f({ owners: [scriptAddr] }), { me, net: "Preprod" })[0]).toMatch(/isn't a wallet address or key hash/);
    expect(createProblems(f({ owners: [me] }), { me, net: "Preprod" })).toContain("You're already an owner; list each other owner once.");
    expect(createProblems(f({ owners: [b, bAddr] }), { me, net: "Preprod" })).toContain("You're already an owner; list each other owner once.");
    expect(createProblems(f({ threshold: "3" }), { me, net: "Preprod" })).toContain("The threshold must be between 1 and 2.");
    expect(createProblems(f({ fund: "0.5" }), { me, net: "Preprod" })).toContain("Fund the treasury with at least 2 ADA, or 0 for none.");
    expect(createProblems(f({ fund: "1.1234567" }), { me, net: "Preprod" })).toContain("Fund the treasury with at least 2 ADA, or 0 for none.");
    expect(createProblems(f({ owners: Array.from({ length: 10 }, (_, i) => (i + 48).toString(16).padStart(2, "0").repeat(28)) }), { me, net: "Preprod" })).toContain("At most 10 owners.");
  });
  it("a solo vault: just you, threshold 1", () => {
    expect(createProblems(f({ owners: [], threshold: "1" }), { me, net: "Preprod" })).toEqual([]);
    expect(createConfig(f({ owners: [], threshold: "1", windowMin: "2" }), me, "Custom").maxTxValidityMs).toBe(120_000n);
  });
});

describe("build errors in plain words", () => {
  it("a wallet short of ADA says by how much", () =>
    expect(buildError('{ Complete: Your wallet does not have enough funds to cover the required assets: { "lovelace": "16123160n" } Or it contains UTxOs with reference scripts; which are excluded from coin selection. }'))
      .toBe("Your wallet is about 16.12316 ADA short. Creating a vault takes about 2 ADA (about 30 with cheaper agent payments) plus what you put in the treasury; preprod's faucet gives test ADA."));
  it("a wallet with no plain-ADA output", () => expect(buildError("wallet needs a pure-ADA UTxO to use as a seed")).toMatch(/plain ADA/));
  it("anything else passes through", () => expect(buildError("something else")).toBe("something else"));
});

describe("the owner being typed", () => {
  const me = "11".repeat(28), b = "22".repeat(28);
  it("says why it can't be added, and nothing while empty or fine", () => {
    expect(ownerHint("", [], me, "Preprod")).toBeUndefined();
    expect(ownerHint(b, [], me, "Preprod")).toBeUndefined();
    expect(ownerHint("addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", [], me, "Preprod")).toBe("That's a mainnet address. Use the owner's preprod (addr_test1…) address.");
    expect(ownerHint(credentialToAddress("Preprod", { type: "Script", hash: b }), [], me, "Preprod")).toBe("That's a script address. An owner is a person's wallet address or key hash.");
    expect(ownerHint("hello", [], me, "Preprod")).toBe("That isn't a wallet address (addr_test1…) or a 56-character key hash.");
    expect(ownerHint(me, [], me, "Preprod")).toBe("That's you; you're already an owner.");
    expect(ownerHint(b, [b], me, "Preprod")).toBe("That owner is already listed.");
  });
});

describe("what creating a vault builds", () => {
  const me = "11".repeat(28);
  const f: CreateForm = { name: "Team", owners: [], threshold: "1", windowMin: "10", fund: "10", refScript: false };
  it("by default no reference script: nothing is locked for good", () =>
    expect(createOptions(f, me, "Preprod")).toEqual({ fund: 10_000_000n, signer: me }));
  it("opted in: the code is parked at the always-fail holder", () =>
    expect(createOptions({ ...f, refScript: true }, me, "Preprod").refScriptAddress).toMatch(/^addr_test1w/));
});

import { minswapForm, minswapProblems, type MinswapForm } from "../src/owner/validate.ts";

describe("the Minswap settings form", () => {
  const filled: MinswapForm = { scope: "only", pools: ["4c50"], slippage: "3", fee: "2", hours: "24", tip: "0.5" };
  it("starts empty: no defaults", () => {
    expect(minswapForm()).toEqual({ scope: "", pools: [], slippage: "", fee: "", hours: "", tip: "" });
    expect(minswapProblems(minswapForm()).length).toBeGreaterThanOrEqual(5);
    expect(minswapProblems(minswapForm())).toContain("Choose any pool or only the pools you pick.");
  });
  it("turns a filled form into the chain's settings", () => {
    expect(minswapProblems(filled)).toEqual([]);
    expect(minswapForm.toSettings(filled)).toEqual({ pools: ["4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 86_400_000n, maxCancelTip: 500_000n });
  });
  it("any pool: no pool list needed, and the picked pools are dropped", () => {
    const any: MinswapForm = { ...filled, scope: "any" };
    expect(minswapProblems({ ...any, pools: [] })).toEqual([]);
    expect(minswapForm.toSettings(any).pools).toBe("any");
  });
  it("refuses what the chain would refuse or what can't work", () => {
    expect(minswapProblems({ ...filled, slippage: "21" })).toContain("Max slippage is at most 20%.");
    expect(minswapProblems({ ...filled, slippage: "0" })).toContain("Max slippage must be more than 0%.");
    expect(minswapProblems({ ...filled, pools: [] })).toContain("Pick at least one pool.");
    expect(minswapProblems({ ...filled, fee: "0" })).toContain("Max batcher fee must be more than 0 ADA.");
    expect(minswapProblems({ ...filled, hours: "0" })).toContain("Order lifetime must be more than 0 hours.");
    expect(minswapProblems({ ...filled, tip: "x" })).toContain("Cancel tip must be an ADA amount (0 is fine).");
  });
  it("shows current settings when editing", () => {
    expect(minswapForm({ pools: ["4c50"], maxSlippageBps: 150n, maxBatcherFee: 1_500_000n, maxOrderTtlMs: 7_200_000n, maxCancelTip: 0n })).toEqual({ scope: "only", pools: ["4c50"], slippage: "1.5", fee: "1.5", hours: "2", tip: "0" });
    expect(minswapForm({ pools: "any", maxSlippageBps: 150n, maxBatcherFee: 1_500_000n, maxOrderTtlMs: 7_200_000n, maxCancelTip: 0n }).scope).toBe("any");
  });
});

import { editedDatum } from "../src/owner/validate.ts";

describe("an agent's apps", () => {
  it("an edit carries the apps the owners picked", () => {
    const al = { agent: "9".repeat(56), destinations: [], caps: [{ policy: "", name: "", windowCap: 1n, txCap: 1n }], spent: [0n], windowStart: 0n, periodMs: 1n, expiresAt: 2n, maxFee: 0n, apps: [] };
    const next = editedDatum(al, { perPayment: 1n, budget: 1n, period: undefined, payees: [], expiresAt: 2n, apps: ["minswap"] }, () => { throw new Error("no payees"); });
    expect(next.apps).toEqual(["minswap"]);
  });
});

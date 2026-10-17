import { describe, expect, it } from "vitest";
import { configChangeProblems, isValidConfig, wellFormedProblems } from "../../src/core/limits.js";
import { tradeProblems } from "../../src/core/apps/minswap/rules.js";
import type { AllowanceDatum, ConfigDatum } from "../../src/core/data.js";
import type { MinswapOrder, MinswapPool, MinswapSettings } from "../../src/core/apps/minswap/data.js";
import { settingsToData } from "../../src/core/apps/minswap/data.js";
import { amountOut, minimumFor } from "../../src/core/apps/minswap/quote.js";

const h = (b: string) => b.repeat(28);
const settings: MinswapSettings = { pools: ["4c51", "4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n };
const app = (over: Partial<ConfigDatum["apps"][0]> = {}) => ({ name: "minswap", adapter: h("ad"), orderScript: h("0d"), settings: settingsToData(settings), ...over });
const cfg: ConfigDatum = { owners: [h("a1"), h("b2"), h("c3")], threshold: 2n, paused: false, maxTxValidityMs: 3_600_000n, apps: [app()] };
const al: AllowanceDatum = {
  agent: h("e5"), destinations: [{ payment: { type: "Key", hash: h("7a") }, stake: null }],
  caps: [{ policy: "", name: "", windowCap: 50_000_000n, txCap: 20_000_000n }], spent: [0n],
  windowStart: 0n, periodMs: 86_400_000n, expiresAt: 10n ** 13n, maxFee: 1_000_000n, apps: ["minswap"],
};

describe("app fields mirror the chain's validation", () => {
  it("config: at most 4 apps, unique names of 1..32 bytes, 28-byte hashes", () => {
    expect(isValidConfig(cfg)).toEqual([]);
    expect(isValidConfig({ ...cfg, apps: ["a", "b", "c", "d", "e"].map((name) => app({ name })) })).not.toEqual([]);
    expect(isValidConfig({ ...cfg, apps: [app(), app()] })).not.toEqual([]);
    expect(isValidConfig({ ...cfg, apps: [app({ name: "" })] })).not.toEqual([]);
    expect(isValidConfig({ ...cfg, apps: [app({ name: "x".repeat(33) })] })).not.toEqual([]);
    expect(isValidConfig({ ...cfg, apps: [app({ name: "é".repeat(16) })] })).toEqual([]); // 32 bytes
    expect(isValidConfig({ ...cfg, apps: [app({ adapter: "00" })] })).not.toEqual([]);
    expect(isValidConfig({ ...cfg, apps: [app({ orderScript: "00" })] })).not.toEqual([]);
  });
  it("allowance: at most 4 app names, no duplicates", () => {
    expect(wellFormedProblems(al)).toEqual([]);
    expect(wellFormedProblems({ ...al, apps: ["a", "b", "c", "d", "e"] })).not.toEqual([]);
    expect(wellFormedProblems({ ...al, apps: ["minswap", "minswap"] })).not.toEqual([]);
  });
  it("one owner's pause may not touch the apps", () => {
    expect(configChangeProblems(cfg, { ...cfg, paused: true }, [h("a1")])).toEqual([]);
    expect(configChangeProblems(cfg, { ...cfg, paused: true, apps: [] }, [h("a1")])).not.toEqual([]);
  });
});

describe("trade rules mirror the adapter", () => {
  const vault = { payment: { type: "Script" as const, hash: h("0a") }, stake: null };
  const pool: MinswapPool = { assetA: { policy: "", name: "" }, assetB: { policy: h("7c"), name: "544f4b454e" }, totalLiquidity: 1n, reserveA: 10n ** 12n, reserveB: 2n * 10n ** 12n, feeA: 30n, feeB: 30n };
  const upper = 1_000_000n;
  const fair = amountOut(pool.reserveA, pool.reserveB, 5_000_000n, 30n);
  const order: MinswapOrder = {
    adapter: h("ad"), receiver: vault, lp: { policy: h("d6"), name: "4c50" }, aToB: true, amount: 5_000_000n,
    minimumReceive: minimumFor(fair, 300n), maxBatcherFee: 1_000_000n, expiry: upper + 3_600_000n, tip: 0n,
  };
  const base = { config: cfg, allowance: al, adapter: h("ad"), lpPolicy: h("d6"), vault, upper, order, pool, orderValue: { lovelace: 8_000_000n } };
  const problems = (over: Partial<typeof base>) => tradeProblems({ ...base, ...over });
  it("an honest order passes", () => expect(problems({})).toEqual([]));
  it.each([
    ["app not enabled", { config: { ...cfg, apps: [] } }],
    ["app not granted", { allowance: { ...al, apps: [] } }],
    ["another canceller", { order: { ...order, adapter: h("ee") } }],
    ["another receiver", { order: { ...order, receiver: { payment: { type: "Key" as const, hash: h("f6") }, stake: null } } }],
    ["zero amount", { order: { ...order, amount: 0n } }],
    ["pool not allowed", { order: { ...order, lp: { policy: h("d6"), name: "4c59" } } }],
    ["another LP policy", { order: { ...order, lp: { policy: h("7c"), name: "4c50" } } }],
    ["batcher fee over", { order: { ...order, maxBatcherFee: 2_000_001n } }],
    ["expiry too late", { order: { ...order, expiry: upper + 3_600_001n } }],
    ["tip over", { order: { ...order, tip: 500_001n } }],
    ["below the floor", { order: { ...order, minimumReceive: minimumFor(fair, 300n) - 1n } }],
    ["extra token", { orderValue: { lovelace: 8_000_000n, [h("7c") + "4a554e4b"]: 1n } }],
  ])("refuses: %s", (_name, over) => expect(problems(over as Partial<typeof base>)).not.toEqual([]));
});

import { describe, expect, it } from "vitest";
import { decodeRecipe, encodeRecipe, titleOf, type Recipe } from "../src/owner/recipes.ts";

describe("recipes", () => {
  it("round-trip through JSON with bigints intact", () => {
    const [a, b] = ["a".repeat(56), "b".repeat(56)];
    const r: Recipe = { op: "config", owners: [a, b], threshold: 2n, signers: [a, b] };
    expect(decodeRecipe(JSON.parse(JSON.stringify(encodeRecipe(r))))).toEqual(r);
    const any: Recipe = { op: "apps", action: "enable", name: "minswap", settings: { pools: "any", maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n }, signers: [a] };
    expect(decodeRecipe(JSON.parse(JSON.stringify(encodeRecipe(any))))).toEqual(any);
  });
  it("refuses anything that isn't a recipe", () => {
    for (const x of [null, 5, { op: "steal" }, { op: "unpause" }]) expect(decodeRecipe(x)).toBeUndefined();
  });
  it("an app change round-trips, settings and all", () => {
    const a = "a".repeat(56);
    const r: Recipe = { op: "apps", action: "enable", name: "minswap", settings: { pools: ["4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n }, signers: [a] };
    expect(decodeRecipe(JSON.parse(JSON.stringify(encodeRecipe(r))))).toEqual(r);
    const any: Recipe = { op: "apps", action: "enable", name: "minswap", settings: { pools: "any", maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n }, signers: [a] };
    expect(decodeRecipe(JSON.parse(JSON.stringify(encodeRecipe(any))))).toEqual(any);
    expect(decodeRecipe({ op: "apps", action: "enable", name: "minswap", signers: [a] })).toBeUndefined(); // enable needs settings
    expect(decodeRecipe({ op: "apps", action: "steal", name: "minswap", signers: [a] })).toBeUndefined();
    expect(titleOf(r, {})).toBe("Enable Minswap");
    expect(titleOf({ op: "apps", action: "disable", name: "minswap", signers: [a] }, {})).toBe("Disable Minswap");
  });
});

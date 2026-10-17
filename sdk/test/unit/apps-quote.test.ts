import { describe, expect, it } from "vitest";
import { amountOut, floorOk, minimumFor } from "../../src/core/apps/minswap/quote.js";

describe("Minswap quotes", () => {
  it("match Minswap's own formula vector", () => {
    expect(amountOut(25434557769208n, 413300185707175n, 1000000000n, 30n)).toBe(16200168971n);
  });
  it("the minimum is the smallest amount the on-chain floor accepts", () => {
    let seed = 7n;
    const rnd = (max: bigint) => ((seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n), seed % max);
    for (let i = 0; i < 2000; i++) {
      const fair = rnd(10n ** 15n);
      const bps = 1n + rnd(2000n);
      const min = minimumFor(fair, bps);
      expect(floorOk(min, fair, bps)).toBe(true);
      if (min > 0n) expect(floorOk(min - 1n, fair, bps)).toBe(false);
    }
  });
  it("floorOk is the chain's inequality", () => {
    expect(floorOk(9700n, 10000n, 300n)).toBe(true);
    expect(floorOk(9699n, 10000n, 300n)).toBe(false);
  });
});

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

import { lpNameOf } from "../../src/core/apps/minswap/quote.js";

describe("Minswap LP names", () => {
  const ada = { policy: "", name: "" };
  it("match Minswap's compute_lp_asset_name and a real preprod pool", () => {
    expect(lpNameOf({ assetA: ada, assetB: { policy: "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6", name: "4d494e" } })).toBe("82e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75");
    expect(lpNameOf({ assetA: ada, assetB: { policy: "f9f812798ef9323119314c30f1ca5dd16e9eec5c116fa2c2e3a55b16", name: "0014df104e41435245" } })).toBe("e5358cee5d14b83d0a4e93f321c0c3addaf8fb5010a1127b6da6a8adc0a16fd3");
  });
});

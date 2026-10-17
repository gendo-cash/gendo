import { describe, expect, it } from "vitest";
import { appFor } from "../../src/core/apps/catalogue.js";
import { poolDatumToData } from "../../src/core/apps/minswap/data.js";
import { lpNameOf } from "../../src/core/apps/minswap/quote.js";
import { findPool } from "../../src/core/apps/minswap/trade.js";

const dep = appFor("minswap", "Custom")!.network;
const P = dep.deployment.lpPolicy;
const lpX = dep.pools[0]!.lpName;
const ada = { policy: "", name: "" };
const pool = (assetB: { policy: string; name: string }, reserveB: bigint, holds: Record<string, bigint>) => ({
  txHash: "aa".repeat(32), outputIndex: 0, address: dep.poolAddress,
  assets: { lovelace: 2_000_000n, [P + "4d5350"]: 1n, ...holds },
  datum: poolDatumToData({ assetA: ada, assetB, totalLiquidity: 1n, reserveA: 10n ** 12n, reserveB, feeA: 30n, feeB: 30n, batchingStakeScript: "fb".repeat(28) }),
});

describe("finding the order's pool", () => {
  it("skips a look-alike that holds the LP as a reserve, even when it's listed first", async () => {
    const lpY = lpNameOf({ assetA: ada, assetB: { policy: P, name: lpX } });
    const fake = pool({ policy: P, name: lpX }, 1n, { [P + lpY]: 1000n, [P + lpX]: 1n });
    const real = pool({ policy: P, name: "54455354" }, 2n * 10n ** 12n, { [P + lpX]: 1_000_000n });
    const lucid = { config: () => ({ network: "Custom" }), utxosAtWithUnit: async () => [fake, real] };
    const found = await findPool({ lucid } as never, lpX);
    expect(found.pool.reserveB).toBe(2n * 10n ** 12n);
  });
  it("no genuine pool is a readable refusal", async () => {
    const lpY = lpNameOf({ assetA: ada, assetB: { policy: P, name: lpX } });
    const lucid = { config: () => ({ network: "Custom" }), utxosAtWithUnit: async () => [pool({ policy: P, name: lpX }, 1n, { [P + lpY]: 1000n, [P + lpX]: 1n })] };
    await expect(findPool({ lucid } as never, lpX)).rejects.toThrow(/doesn't exist/);
  });
});

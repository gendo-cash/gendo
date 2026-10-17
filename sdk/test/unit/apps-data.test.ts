// The SDK's encoders against golden CBOR traced by Aiken itself
// (onchain/lib/apps/minswap/golden.test.ak). Compared as decoded Plutus data:
// Aiken and Lucid may frame lists differently; the chain compares data.
import { Data } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { allowanceFromData, allowanceToData, configFromData, configToData, spendRedeemer, type AllowanceDatum, type ConfigDatum } from "../../src/core/data.js";
import { orderDatumFromData, orderDatumToData, poolDatumFromData, settingsFromData, settingsToData, type MinswapOrder, type MinswapSettings } from "../../src/core/apps/minswap/data.js";

const G = {
  order: "D8799FD87B9F581CAD000000000000000000000000000000000000000000000000000000FFD8799FD87A9F581C0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0AFFD87A80FFD87980D8799FD87A9F581C0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0A0AFFD87A80FFD87980D8799F581CD6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6D6424C50FFD8799FD87A80D8799F1A004C4B40FF1A009390C4D87A80FF1A000F4240D8799F9F1B0000019B7751ACC000FFFFFF",
  settings: "D8799F9F424C51424C50FF19012C1A001E84801A0036EE801A0007A120FF",
  pool: "D8799FD8799FD87A9F581CFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFBFFFFD8799F4040FFD8799F581C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C7C45544F4B454EFF1A3B9ACA001B000000E8D4A510001B000001D1A94A2000181E181ED87A80D87980FF",
  config: "D8799F9F581CA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1581CB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2581CC3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3C3FF02D879801A0036EE809FD8799F476D696E73776170581CAD000000000000000000000000000000000000000000000000000000581C0D000000000000000000000000000000000000000000000000000000D8799F9F424C51424C50FF19012C1A001E84801A0036EE801A0007A120FFFFFFFF",
  allowance: "D8799F581CE5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E5E59FD8799FD8799F581C7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7A7AFFD87A80FFD8799FD8799F581C7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7B7BFFD8799FD8799FD8799F581C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8C8CFFFFFFFFFF9FD8799F40401A02FAF0801A01312D00FFD8799F581C5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D5D435553441903E8190258FFFF9F0000FF1B0000019B76DAA8001A05265C001B0000019C115970001A000F42409F476D696E73776170FFFF",
  redeemer: "D87C9F58201E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1EFF",
};
const same = (sdkHex: string, golden: string) => expect(Data.from(sdkHex)).toEqual(Data.from(golden.toLowerCase()));
const h = (byte: string) => byte.repeat(28);
const T0 = 1_767_225_600_000n, HOUR = 3_600_000n, DAY = 86_400_000n;

const settings: MinswapSettings = { pools: ["4c51", "4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: HOUR, maxCancelTip: 500_000n };
const vaultHome = { payment: { type: "Script" as const, hash: h("0a") }, stake: null };
const order: MinswapOrder = {
  adapter: "ad" + "00".repeat(27),
  receiver: vaultHome,
  lp: { policy: h("d6"), name: "4c50" },
  aToB: true,
  amount: 5_000_000n,
  minimumReceive: 0x9390c4n,
  maxBatcherFee: 1_000_000n,
  expiry: T0 + HOUR + 10n * 60_000n + HOUR,
  tip: 0n,
};

describe("app datums match the chain's encoding", () => {
  it("Minswap settings", () => {
    same(settingsToData(settings), G.settings);
    expect(settingsFromData(G.settings.toLowerCase())).toEqual(settings);
  });
  it("a Minswap order: swap-exact-in, specific amount, killable, receivers without datum, expiry as a 2-list", () => {
    same(orderDatumToData(order), G.order);
    expect(orderDatumFromData(G.order.toLowerCase())).toEqual(order);
  });
  it("anything that isn't one of our orders doesn't decode as ours", () => {
    expect(orderDatumFromData(Data.to(0n))).toBeNull();
    const notKillable = G.order.toLowerCase().replace("1a009390c4d87a80ff", "1a009390c4d87980ff");
    expect(orderDatumFromData(notKillable)).toBeNull();
  });
  it("a Minswap pool", () => {
    expect(poolDatumFromData(G.pool.toLowerCase())).toEqual({
      assetA: { policy: "", name: "" },
      assetB: { policy: h("7c"), name: "544f4b454e" },
      totalLiquidity: 1_000_000_000n,
      reserveA: 1_000_000_000_000n,
      reserveB: 2_000_000_000_000n,
      feeA: 30n,
      feeB: 30n,
    });
  });
  it("a config with an enabled app", () => {
    const c: ConfigDatum = {
      owners: [h("a1"), h("b2"), h("c3")],
      threshold: 2n,
      paused: false,
      maxTxValidityMs: HOUR,
      apps: [{ name: "minswap", adapter: "ad" + "00".repeat(27), orderScript: "0d" + "00".repeat(27), settings: settingsToData(settings) }],
    };
    same(configToData(c), G.config);
    expect(configFromData(G.config.toLowerCase())).toEqual(c);
  });
  it("an allowance granting an app", () => {
    const a: AllowanceDatum = {
      agent: h("e5"),
      destinations: [
        { payment: { type: "Key", hash: h("7a") }, stake: null },
        { payment: { type: "Key", hash: h("7b") }, stake: { type: "Key", hash: h("8c") } },
      ],
      caps: [
        { policy: "", name: "", windowCap: 50_000_000n, txCap: 20_000_000n },
        { policy: h("5d"), name: "555344", windowCap: 1000n, txCap: 600n },
      ],
      spent: [0n, 0n],
      windowStart: T0,
      periodMs: DAY,
      expiresAt: T0 + 30n * DAY,
      maxFee: 1_000_000n,
      apps: ["minswap"],
    };
    same(allowanceToData(a), G.allowance);
    expect(allowanceFromData(G.allowance.toLowerCase())).toEqual(a);
  });
  it("the AgentTrade redeemer is constructor 3", () => {
    same(spendRedeemer({ kind: "AgentTrade", intentHash: "1e".repeat(32) }), G.redeemer);
  });
});

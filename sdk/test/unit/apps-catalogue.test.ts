import { getAddressDetails, mintingPolicyToId, scriptFromNative, validatorToScriptHash } from "@lucid-evolution/lucid";
import { describe, expect, it } from "vitest";
import { appFor, catalogue } from "../../src/core/apps/catalogue.js";
import { minswapAdapter } from "../../src/core/apps/minswap/adapter.js";
import { refHolderAddress } from "../../src/core/vault.js";

const payHash = (a: string) => getAddressDetails(a).paymentCredential!.hash;

describe("apps catalogue", () => {
  it("lists Minswap, and only what each app supports", () => {
    expect(catalogue().map((a) => a.name)).toEqual(["minswap"]);
    expect(appFor("minswap", "Preprod")?.app.actions).toEqual(["swap"]);
    expect(appFor("minswap", "Mainnet" as never)).toBeUndefined();
  });
  it("preprod uses Minswap's published deployment", () => {
    const n = appFor("minswap", "Preprod")!.network;
    expect(n.deployment.lpPolicy).toBe("d6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b");
    expect(n.deployment.orderScript).toBe(payHash(n.orderAddress));
    expect(n.deployment.poolScript).toBe(payHash(n.poolAddress));
    expect(getAddressDetails(n.orderAddress).stakeCredential).toBeUndefined();
    expect(n.pools.map((p) => p.label)).toContain("ADA ↔ NACRE");
    for (const p of n.pools) expect(p.lpName).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the devnet deployment is deterministic: an open mint policy, the always-fail holder, Minswap's real order script", () => {
    const n = appFor("minswap", "Custom")!.network;
    expect(n.deployment.lpPolicy).toBe(mintingPolicyToId(scriptFromNative({ type: "all", scripts: [] })));
    expect(n.poolAddress).toBe(refHolderAddress("Custom"));
    expect(n.deployment.poolScript).toBe(payHash(refHolderAddress("Custom")));
    expect(n.deployment.orderScript).toBe(appFor("minswap", "Preprod")!.network.deployment.orderScript);
    expect(n.pools).toEqual([{ lpName: "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f", label: "ADA ↔ TEST", assetA: "lovelace", assetB: n.deployment.lpPolicy + "54455354" }]);
  });
  it("settings have help text and never a default value", () => {
    const fields = appFor("minswap", "Preprod")!.app.settings;
    expect(fields.map((f) => f.field)).toEqual(["pools", "maxSlippageBps", "maxBatcherFee", "maxOrderTtlMs", "maxCancelTip"]);
    for (const f of fields) {
      expect(f.help.length).toBeGreaterThan(10);
      expect(Object.keys(f)).not.toContain("default");
    }
  });
});

describe("the Minswap adapter script", () => {
  it("is the compiled adapter with the network's deployment applied", () => {
    const pre = minswapAdapter("Preprod");
    const dev = minswapAdapter("Custom");
    expect(pre.script.type).toBe("PlutusV3");
    expect(pre.hash).toBe(validatorToScriptHash(pre.script));
    expect(pre.hash).not.toBe(dev.hash);
    expect(minswapAdapter("Preprod").hash).toBe(pre.hash);
    expect(pre.rewardAddress.startsWith("stake_test1")).toBe(true);
  });
});

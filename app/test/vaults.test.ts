import { describe, expect, it } from "vitest";
import { makeVault } from "../../sdk/src/core/index.ts";
import { consistentVaults, sidebarVaults, staleCount } from "../src/owner/vaults.ts";

describe("your vault list", () => {
  it("drops an entry whose vault id isn't the vault the policy names", () => {
    const a = makeVault("Preprod", { txHash: "aa".repeat(32), outputIndex: 0 });
    const idA = `gendo:preprod:${"aa".repeat(32)}#0`, idB = `gendo:preprod:${"bb".repeat(32)}#0`;
    const list = [{ policy: a.hash, vaultId: idA, name: "A", listed: false }, { policy: a.hash, vaultId: idB, name: "forged", listed: false }, { policy: a.hash, vaultId: "junk", name: "x", listed: false }];
    expect(consistentVaults(list).map((v) => v.name)).toEqual(["A"]);
  });
});

describe("the sidebar's vaults", () => {
  const v = (n: number) => ({ policy: `p${n}`, vaultId: `id${n}`, name: `V${n}`, listed: false });
  const list = [1, 2, 3, 4, 5, 6, 7].map(v); // newest added first, as the server sends them
  it("shows five: vaults waiting on you first, then the newest", () => {
    expect(sidebarVaults(list, { p6: 2, p3: 1 }).map((x) => x.name)).toEqual(["V3", "V6", "V1", "V2", "V4"]);
  });
  it("keeps the open vault in view even when it's further down", () => {
    expect(sidebarVaults(list, {}, "p7").map((x) => x.name)).toEqual(["V1", "V2", "V3", "V4", "V7"]);
    expect(sidebarVaults(list, {}, "p2").map((x) => x.name)).toEqual(["V1", "V2", "V3", "V4", "V5"]);
  });
  it("fewer than five shows them all", () => expect(sidebarVaults(list.slice(0, 2), {})).toHaveLength(2));
});

describe("vaults from before an update", () => {
  it("counts the saved vaults whose ids no longer derive their address", () => {
    const a = makeVault("Preprod", { txHash: "aa".repeat(32), outputIndex: 0 });
    const ok = { policy: a.hash, vaultId: `gendo:preprod:${"aa".repeat(32)}#0`, name: "A", listed: false };
    const old = { policy: "ff".repeat(28), vaultId: `gendo:preprod:${"bb".repeat(32)}#0`, name: "Old", listed: false };
    expect(staleCount([ok, old, old])).toBe(2);
    expect(staleCount([ok])).toBe(0);
  });
});

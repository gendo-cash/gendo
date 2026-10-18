import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/route.ts";
const P = "ab".repeat(28);
describe("routes", () => {
  it("maps paths to pages", () => {
    expect(parseRoute(`/w/${P}`)).toEqual({ page: "public", policy: P });
    expect(parseRoute("/")).toEqual({ page: "inbox" });
    expect(parseRoute("/vaults")).toEqual({ page: "vaults" });
    expect(parseRoute(`/v/${P}`)).toEqual({ page: "vault", policy: P, tab: "agents" });
    expect(parseRoute(`/v/${P}/settings`)).toEqual({ page: "vault", policy: P, tab: "settings" });
    expect(parseRoute(`/v/${P}/apps`)).toEqual({ page: "vault", policy: P, tab: "apps" });
    expect(parseRoute(`/v/${P}/apps/minswap/settings`)).toEqual({ page: "vault", policy: P, tab: "apps", app: "minswap" });
    expect(parseRoute(`/v/${P}/apps/minswap`)).toEqual({ page: "missing" });
    expect(parseRoute(`/v/${P}/agents/new`)).toEqual({ page: "agent", policy: P });
    expect(parseRoute(`/v/${P}/agents/${P}11`)).toEqual({ page: "agent", policy: P, unit: `${P}11` });
  });
  it("anything else is not found", () => {
    for (const p of ["/w/xyz", "/v/abc", "/nope", "/inbox", `/v/${P}/agents/zz`]) expect(parseRoute(p)).toEqual({ page: "missing" });
  });
  it("/new is the create wizard", () => expect(parseRoute("/new")).toEqual({ page: "create" }));
  it("/v/<policy>/connect connects an agent", () => expect(parseRoute(`/v/${P}/connect`)).toEqual({ page: "connect", policy: P }));
});

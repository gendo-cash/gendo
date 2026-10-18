// The agent's swap surface (what the MCP tools call), on a real emulator vault.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChainQuery } from "../../src/core/idempotency.js";
import { witnessFor } from "../../src/node/signer/core.js";
import { budget, sessionFromParts, swap, type AgentSession } from "../../src/node/session.js";
import { DEVNET, mintPool, tradeWorld } from "../trade-world.js";

// The emulator has no indexer: "can't tell" for history, the emulator's clock for the tip.
let w: Awaited<ReturnType<typeof tradeWorld>>;
let s: AgentSession;

beforeAll(async () => {
  w = await tradeWorld({ pools: ["860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n });
  const q: ChainQuery = {
    txExists: async () => false,
    spenderOf: async () => undefined,
    txInputs: async () => undefined,
    tipMs: async () => w.emulator.now(),
    txMetadata: async () => undefined,
  };
  // The session reads the wall clock; the emulator keeps its own (ahead of it after many blocks).
  vi.spyOn(Date, "now").mockImplementation(() => w.emulator.now());
  s = sessionFromParts({ lucid: w.lucid, vault: w.vault, unit: w.unit, home: mkdtempSync(join(tmpdir(), "gendo-swap-")), q, sign: async (cbor) => witnessFor(cbor, w.agent.privateKey) });
});

describe("the agent's swap tools (emulator)", () => {
  it("get_budget lists the apps the agent may use, with the vault's rules", async () => {
    const b = await budget(s);
    expect(b.apps).toEqual([{ app: "minswap", title: "Minswap", pools: ["ADA ↔ TEST"], max_slippage_pct: 3, max_batcher_fee_ada: 2, max_order_lifetime_minutes: 60, cancel_tip_ada: 0.5 }]);
  });

  it("swap places an order and says where the proceeds go", async () => {
    const r = await swap(s, { app: "minswap", pool: "ADA ↔ TEST", amount_ada: 2, intent_id: "S-1", purpose: "test" });
    expect(r).toMatchObject({ status: "placed", tx: expect.stringMatching(/^[0-9a-f]{64}$/), note: expect.stringMatching(/treasury/) });
  });

  it("a pool the vault doesn't allow is blocked with a reason, not an error", async () => {
    const r = await swap(s, { app: "minswap", pool: "ADA ↔ NACRE", amount_ada: 1, intent_id: "S-2", purpose: "test" });
    expect(r).toMatchObject({ status: "blocked", code: "APP" });
  });

  it("over the per-payment limit is blocked with the next step", async () => {
    const r = await swap(s, { app: "minswap", pool: "ADA ↔ TEST", amount_ada: 19, intent_id: "S-3", purpose: "test" });
    expect(r).toMatchObject({ status: "blocked", code: "TX_CAP", next_step: expect.any(String) });
  });

  it("selling an asset that isn't in the pool is refused, not swapped for the pool's other asset", async () => {
    const r = await swap(s, { app: "minswap", pool: "ADA ↔ TEST", asset: { unit: "ab".repeat(28) + "4e4f50", quantity: 100 }, intent_id: "S-4", purpose: "x" });
    expect(r).toMatchObject({ status: "blocked", code: "APP", reason: expect.stringMatching(/isn't in that pool/) });
  });

  it("a fractional token quantity is refused with a reason", async () => {
    const r = await swap(s, { app: "minswap", pool: "ADA ↔ TEST", asset: { unit: w.vault.hash.slice(0, 0) + "d441227553a0f1a965fee7d60a0f724b368dd1bddbc208730fccebcf54455354", quantity: 1.5 }, intent_id: "S-5", purpose: "x" });
    expect(r).toMatchObject({ status: "blocked", code: "APP", reason: expect.stringMatching(/whole number/) });
  });
});

describe("a vault that allows any Minswap pool (emulator)", () => {
  let wa: Awaited<ReturnType<typeof tradeWorld>>;
  let sa: AgentSession;
  const OTHER = DEVNET.deployment.lpPolicy + "4f54484552";

  beforeAll(async () => {
    wa = await tradeWorld({ pools: "any", maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n });
    wa.lucid.selectWallet.fromPrivateKey(wa.a.privateKey);
    await mintPool(wa.lucid, wa.emulator, wa.a, "4f54484552"); // ADA ↔ OTHER: not in the catalogue
    const q: ChainQuery = { txExists: async () => false, spenderOf: async () => undefined, txInputs: async () => undefined, tipMs: async () => wa.emulator.now(), txMetadata: async () => undefined };
    vi.spyOn(Date, "now").mockImplementation(() => wa.emulator.now());
    sa = sessionFromParts({ lucid: wa.lucid, vault: wa.vault, unit: wa.unit, home: mkdtempSync(join(tmpdir(), "gendo-swap-any-")), q, sign: async (cbor) => witnessFor(cbor, wa.agent.privateKey) });
  });

  it("get_budget says any pool, and names the known ones", async () => {
    const b = await budget(sa);
    expect(b.apps[0]).toMatchObject({ pools: "any", known_pools: ["ADA ↔ TEST"] });
  });

  it("swaps into a pool outside the catalogue, named by its two assets (either order)", async () => {
    const r = await swap(sa, { app: "minswap", pool: `lovelace/${OTHER}`, amount_ada: 2, intent_id: "A-1", purpose: "test" });
    expect(r).toMatchObject({ status: "placed" });
    const r2 = await swap(sa, { app: "minswap", pool: `${OTHER}/ADA`, amount_ada: 2, intent_id: "A-2", purpose: "test" });
    expect(r2).toMatchObject({ status: "placed" });
  });

  it("a pool that doesn't exist on Minswap is blocked", async () => {
    const r = await swap(sa, { app: "minswap", pool: `lovelace/${DEVNET.deployment.lpPolicy}4e4f4e45`, amount_ada: 1, intent_id: "A-3", purpose: "test" });
    expect(r).toMatchObject({ status: "blocked", code: "APP", reason: expect.stringMatching(/no Minswap pool/) });
  });

  it("a vault that lists its pools still refuses that pool", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => w.emulator.now());
    w.lucid.selectWallet.fromPrivateKey(w.a.privateKey);
    await mintPool(w.lucid, w.emulator, w.a, "4f54484552");
    const r = await swap(s, { app: "minswap", pool: `lovelace/${OTHER}`, amount_ada: 1, intent_id: "A-4", purpose: "test" });
    expect(r).toMatchObject({ status: "blocked", code: "APP", reason: expect.stringMatching(/isn't one the vault allows/) });
  });
});

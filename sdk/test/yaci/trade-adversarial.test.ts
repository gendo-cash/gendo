// Trades against the real ledger: a compromised agent key builds each malicious trade blind
// (no SDK checks, no local script evaluation); only the vault, the Minswap adapter and the
// ledger stand in the way. The baseline proves the harness's honest trade is accepted.
// Devnet: run scripts/devnet-apps.sh first (fixture pool + adapter registration).
import { beforeAll, describe, expect, it } from "vitest";
import { Constr, Data, type UTxO } from "@lucid-evolution/lucid";
import { appFor } from "../../src/core/apps/catalogue.js";
import { minswapAdapter, minswapAppConfig } from "../../src/core/apps/minswap/adapter.js";
import { orderDatumToData, type MinswapOrder, type MinswapSettings } from "../../src/core/apps/minswap/data.js";
import { amountOut, minimumFor } from "../../src/core/apps/minswap/quote.js";
import { findPool } from "../../src/core/apps/minswap/trade.js";
import { toPlutusAddress } from "../../src/core/address.js";
import { spendRedeemer } from "../../src/core/data.js";
import * as owner from "../../src/core/owner.js";
import { SCRIPT_FAILURE, attack, setPayee, type Attack, type Ctx } from "./attacker.js";
import { ADA, NETWORK, grant, readAllowance, readConfig, signSubmit, yaciWorld, type World } from "./world.js";

const found = appFor("minswap", NETWORK)!;
const POOL = found.network.pools[0]!.lpName;
const settings: MinswapSettings = { pools: [POOL], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n };
const adapter = minswapAdapter(NETWORK);
let w: World;
let unit: string;
let pool: { utxo: UTxO; pool: Awaited<ReturnType<typeof findPool>>["pool"] };

async function ctx(): Promise<Ctx> {
  const { lucid, vault, refScript, collateral, agent } = w;
  return { lucid, vault, refScript, collateral, agent, config: await readConfig(lucid, vault), allowance: await readAllowance(lucid, vault, unit) };
}

const AMOUNT = 3n * ADA;
/** The honest order, expiring at `upperMs`: well inside the tx's upper bound (tip + 90 s) plus the vault's 1 h lifetime. */
function honestOrder(upperMs: number): MinswapOrder {
  const fair = amountOut(pool.pool.reserveA, pool.pool.reserveB, AMOUNT, pool.pool.feeA);
  return {
    adapter: adapter.hash, receiver: toPlutusAddress(w.vault.address), lp: { policy: found.network.deployment.lpPolicy, name: POOL },
    aToB: true, amount: AMOUNT, minimumReceive: minimumFor(fair, settings.maxSlippageBps), maxBatcherFee: 2_000_000n, expiry: BigInt(upperMs), tip: 0n,
  };
}
const orderValue = { lovelace: AMOUNT + 2_000_000n + 2_000_000n };

/** A trade attack: one order output (datum from `datum`), the adapter's withdrawal, AgentTrade. */
async function trade(o: { datum?: (upperMs: number) => string; to?: string; withdraw?: boolean; extra?: Partial<Attack> } = {}) {
  return attack(ctx, {
    redeemer: spendRedeemer({ kind: "AgentTrade", intentHash: "1e".repeat(32) }),
    payments: [],
    // Blind ex-units on two redeemers plus the adapter inline cost about 1.63 ADA. The fee must cover that
    // and leave less than a minimum UTxO, or Lucid pays the rest as change to the agent (a non-payee).
    fee: 1_800_000n,
    refInputs: [(await readConfig(w.lucid, w.vault)).utxo, w.refScript, pool.utxo],
    tweak: (b) => (o.withdraw === false ? b : b.withdraw(adapter.rewardAddress, 0n, Data.void()).attach.WithdrawalValidator(adapter.script)),
    extraOutputs: [{ to: o.to ?? found.network.orderAddress, assets: orderValue, datum: (o.datum ?? ((u) => orderDatumToData(honestOrder(u))))(Date.now() + 1_800_000) }],
    ...o.extra,
  });
}
/** The honest order's datum with one Plutus field replaced. */
const mutated = (field: number, value: unknown) => (u: number) => {
  const c = Data.from(orderDatumToData(honestOrder(u))) as Constr<unknown>;
  c.fields[field] = value as never;
  return Data.to(c as never);
};
const expectRefused = (r: { ok: boolean; body: string }) => {
  expect(r.ok, r.body.slice(0, 300)).toBe(false);
  expect(r.body).toMatch(SCRIPT_FAILURE);
};

beforeAll(async () => {
  w = await yaciWorld();
  setPayee(w.payee.address);
  await signSubmit(w.lucid, async () => owner.enableApp(w.lucid, w.vault, await readConfig(w.lucid, w.vault), minswapAppConfig(NETWORK, settings), [w.a.pkh, w.b.pkh]), [w.a, w.b]);
  unit = await grant(w, { apps: ["minswap"] });
  pool = await findPool({ lucid: w.lucid }, POOL);
}, 600_000);

describe("baseline", () => {
  it("the harness's honest trade is accepted", async () => {
    const r = await trade();
    expect(r.ok, r.body.slice(0, 400)).toBe(true);
  });
});

describe("orders the adapter refuses", () => {
  it("T1 minimum one unit under the price floor", async () => expectRefused(await trade({ datum: (u) => orderDatumToData({ ...honestOrder(u), minimumReceive: honestOrder(u).minimumReceive - 1n }) })));
  it("T2 proceeds to the attacker", async () => expectRefused(await trade({ datum: mutated(3, (Data.from(orderDatumToData({ ...honestOrder(0), receiver: toPlutusAddress(w.stranger.address) })) as Constr<unknown>).fields[3]) })));
  it("T3 refunds to the attacker", async () => expectRefused(await trade({ datum: mutated(1, (Data.from(orderDatumToData({ ...honestOrder(0), receiver: toPlutusAddress(w.stranger.address) })) as Constr<unknown>).fields[1]) })));
  it("T4 no expiry", async () => expectRefused(await trade({ datum: mutated(8, new Constr(1, [])) })));
  it("T5 a Donation step (gives the funds to the pool)", async () => expectRefused(await trade({ datum: mutated(6, new Constr(10, [])) })));
  it("T6 the attacker's key can cancel", async () => expectRefused(await trade({ datum: mutated(0, new Constr(0, [w.agent.pkh])) })));
  it("T7 a pool the vault doesn't allow", async () => expectRefused(await trade({ datum: (u) => orderDatumToData({ ...honestOrder(u), lp: { policy: found.network.deployment.lpPolicy, name: "4c59" } }) })));
});

describe("trades the vault refuses", () => {
  it("T8 no adapter withdrawal", async () => expectRefused(await trade({ withdraw: false })));
  it("T9 the order paid to another script", async () => expectRefused(await trade({ to: w.refHolder })));
});

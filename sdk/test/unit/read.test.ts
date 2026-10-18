// sdk/test/unit/read.test.ts
import { describe, expect, it } from "vitest";
import { Constr, Data } from "@lucid-evolution/lucid";
import { asBytes, asConstr, asInt, asList, decodePlutusData, type PData } from "../../src/read/plutus-cbor.js";
import { orderDatumToData } from "../../src/core/apps/minswap/data.js";

// The reference: Lucid's own encoder. The decoder must read exactly what the SDK writes.
const toPlain = (d: PData): unknown =>
  d.k === "constr" ? { c: d.index, f: d.fields.map(toPlain) }
  : d.k === "int" ? d.v.toString()
  : d.k === "bytes" ? d.hex
  : d.k === "list" ? d.items.map(toPlain)
  : d.entries.map(([a, b]) => [toPlain(a), toPlain(b)]);
const lucidPlain = (x: Data): unknown =>
  x instanceof Constr ? { c: x.index, f: x.fields.map(lucidPlain) }
  : typeof x === "bigint" ? x.toString()
  : typeof x === "string" ? x
  : Array.isArray(x) ? x.map(lucidPlain)
  : [...(x as Map<Data, Data>).entries()].map(([a, b]) => [lucidPlain(a), lucidPlain(b)]);

describe("decodePlutusData", () => {
  const cases: Data[] = [
    0n, 23n, 24n, 255n, 65_535n, 4_294_967_296n, -1n, -500n,
    2n ** 64n + 5n, -(2n ** 70n), 10n ** 30n,
    "", "ab", "00".repeat(28), "ff".repeat(64), "ee".repeat(65), "cd".repeat(200),
    [], [1n, 2n], new Constr(0, []), new Constr(1, ["ab", 5n]), new Constr(6, [[]]),
    new Constr(7, [1n]), new Constr(127, []), new Constr(128, [9n]),
    new Map<Data, Data>([[1n, "aa"], ["bb", new Constr(0, [])]]),
    new Constr(0, [["aa", "bb"], 2n, new Constr(1, []), 600_000n]),
  ];
  for (const x of cases)
    it(`reads ${Data.to(x).slice(0, 24)}… like Lucid`, () => expect(toPlain(decodePlutusData(Data.to(x)))).toEqual(lucidPlain(x)));

  it("rejects trailing bytes and truncated input", () => {
    expect(() => decodePlutusData(Data.to(5n) + "00")).toThrow(/trailing/);
    expect(() => decodePlutusData("9f01")).toThrow(/end of input/);
  });

  it("accessors check the shape", () => {
    const d = decodePlutusData(Data.to(new Constr(1, [7n, "ab", [1n]])));
    const [i, b, l] = asConstr(d, 1, 3);
    expect([asInt(i!), asBytes(b!), asList(l!).length]).toEqual([7n, "ab", 1]);
    expect(() => asConstr(d, 0)).toThrow(/constructor 0/);
    expect(() => asInt(b!)).toThrow(/integer/);
  });
});

import { allowanceToData, configToData, type AllowanceDatum, type PlutusAddress } from "../../src/core/data.js";
import { fromPlutusAddress } from "../../src/core/address.js";
import { makeVault } from "../../src/core/vault.js";
import { addressToBech32, allowanceFromCbor, configFromCbor, scriptAddress } from "../../src/read/decode.js";

const h = (n: number) => n.toString(16).padStart(2, "0").repeat(28);

describe("datums without Lucid", () => {
  it("reads a config like the SDK writes it", () => {
    const cfg = { owners: [h(1), h(2), h(3)], threshold: 2n, paused: true, maxTxValidityMs: 600_000n, apps: [] };
    expect(configFromCbor(configToData(cfg))).toEqual(cfg);
  });
  it("reads an allowance like the SDK writes it", () => {
    const a: AllowanceDatum = {
      agent: h(9),
      destinations: [
        { payment: { type: "Key", hash: h(4) }, stake: null },
        { payment: { type: "Key", hash: h(5) }, stake: { type: "Key", hash: h(6) } },
        { payment: { type: "Key", hash: h(7) }, stake: { pointer: [1n, 2n, 3n] } },
      ],
      caps: [{ policy: "", name: "", windowCap: 25_000_000n, txCap: 10_000_000n }, { policy: h(8), name: "746f6b", windowCap: 100n, txCap: 10n }],
      spent: [3_000_000n, 0n],
      windowStart: 1_790_000_000_000n,
      periodMs: 86_400_000n,
      expiresAt: 1_800_000_000_000n,
      maxFee: 1_000_000n,
      apps: [],
    };
    expect(allowanceFromCbor(allowanceToData(a))).toEqual(a);
  });
  it("rejects a datum of the wrong shape", () => {
    expect(() => allowanceFromCbor(configToData({ owners: [h(1)], threshold: 1n, paused: false, maxTxValidityMs: 1n, apps: [] }))).toThrow();
  });
});

describe("addresses without Lucid", () => {
  const forms: PlutusAddress[] = [
    { payment: { type: "Key", hash: h(4) }, stake: null },
    { payment: { type: "Key", hash: h(4) }, stake: { type: "Key", hash: h(5) } },
    { payment: { type: "Key", hash: h(4) }, stake: { type: "Script", hash: h(5) } },
    { payment: { type: "Script", hash: h(4) }, stake: { type: "Key", hash: h(5) } },
    { payment: { type: "Script", hash: h(4) }, stake: null },
  ];
  for (const a of forms)
    it(`matches Lucid for ${a.payment.type}/${a.stake === null ? "none" : "pointer" in a.stake ? "pointer" : a.stake.type}`, () =>
      expect(addressToBech32(a, "Preprod")).toBe(fromPlutusAddress("Preprod", a)));
  // The SDK refuses pointer addresses, so the reference is CIP-19's own test vector.
  it("encodes a pointer address like the CIP-19 test vector", () =>
    expect(
      addressToBech32({ payment: { type: "Key", hash: "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e" }, stake: { pointer: [2_498_243n, 27n, 3n] } }, "Preprod"),
    ).toBe("addr_test1gz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrdw5vky"));
  it("derives the vault address from its policy id", () => {
    const v = makeVault("Preprod", { txHash: "11".repeat(32), outputIndex: 0 });
    expect(scriptAddress(v.hash, "Preprod")).toBe(v.address);
  });
});

import { allowanceHistory, readVault, type Get } from "../../src/read/chain.js";
import { utf8ToHex } from "../../src/core/bytes.js";

describe("vault state from the chain", () => {
  const policy = h(0x0a);
  const addr = scriptAddress(policy, "Preprod");
  const cfg = { owners: [h(1), h(2), h(3)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] };
  const unitA = policy + h(0x0b);
  const day = 86_400_000n;
  const allowance = (spent: bigint, windowStart: bigint): AllowanceDatum => ({
    agent: h(9),
    destinations: [{ payment: { type: "Key", hash: h(4) }, stake: null }],
    caps: [{ policy: "", name: "", windowCap: 25_000_000n, txCap: 10_000_000n }],
    spent: [spent],
    windowStart,
    periodMs: day,
    expiresAt: windowStart + 30n * day,
    maxFee: 1_000_000n,
    apps: [],
  });
  const utxo = (tx: string, units: Record<string, string>, datum: string | null) => ({
    tx_hash: tx, output_index: 0, inline_datum: datum,
    amount: Object.entries(units).map(([unit, quantity]) => ({ unit, quantity })),
  });
  const fakeGet = (utxos: unknown[]): Get => async (path) => (path.startsWith(`/addresses/${addr}/utxos`) ? (path.includes("page=1") ? utxos : []) : undefined);
  const t0 = 1_790_000_000_000n;
  const cfgUtxo = utxo("c0".repeat(32), { lovelace: "2000000", [policy + utf8ToHex("config")]: "1" }, configToData(cfg));

  it("reads config, treasury and an allowance with its budget", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(3_000_000n, t0))), utxo("e0".repeat(32), { lovelace: "150000000" }, null)]), policy, "Preprod", Number(t0 + 3_600_000n));
    expect(v!.config).toEqual(cfg);
    expect(v!.treasuryLovelace).toBe(150_000_000n);
    expect(v!.allowances[0]!.apps).toEqual([]);
    const a = v!.allowances[0]!;
    expect(a.status).toBe("active");
    expect([a.txHash, a.outputIndex]).toEqual(["a1".repeat(32), 0]);
    expect(a.caps[0]).toMatchObject({ unit: "lovelace", perPayment: 10_000_000n, perPeriod: 25_000_000n, spentThisPeriod: 3_000_000n, leftThisPeriod: 22_000_000n });
    expect(a.payees).toEqual([addressToBech32({ payment: { type: "Key", hash: h(4) }, stake: null }, "Preprod")]);
  });
  it("a period that rolled over shows nothing spent this period", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(9_000_000n, t0)))]), policy, "Preprod", Number(t0 + 2n * day + 5n));
    expect(v!.allowances[0]!.caps[0]!.spentThisPeriod).toBe(0n);
    expect(v!.allowances[0]!.periodEndsAt).toBe(Number(t0 + 3n * day));
  });
  it("past expiry reads expired", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(0n, t0)))]), policy, "Preprod", Number(t0 + 31n * day));
    expect(v!.allowances[0]!.status).toBe("expired");
  });
  it("a malformed allowance is reported, not fatal", async () => {
    const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "5000000", [unitA]: "1" }, "d87980")]), policy, "Preprod", Number(t0));
    expect(v!.allowances[0]!.status).toBe("malformed");
  });
  it("a vault with no allowances has an empty list", async () => {
    const v = await readVault(fakeGet([cfgUtxo]), policy, "Preprod", Number(t0));
    expect(v!.allowances).toEqual([]);
  });
  it("funds at the address without the config token are not a vault", async () => {
    expect(await readVault(fakeGet([utxo("e0".repeat(32), { lovelace: "150000000" }, null)]), policy, "Preprod", Number(t0))).toBeUndefined();
  });
  it("a datum that decodes but breaks the on-chain rules is malformed, not active", async () => {
    const bad = { ...allowance(0n, t0), caps: [{ policy: "", name: "", windowCap: 5_000_000n, txCap: 10_000_000n }] };
    const far = { ...allowance(0n, t0), expiresAt: 2n ** 70n };
    for (const d of [bad, far]) {
      const v = await readVault(fakeGet([cfgUtxo, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(d))]), policy, "Preprod", Number(t0));
      expect(v!.allowances[0]!.status).toBe("malformed");
    }
  });
  it("in a paused vault, an agent within its dates reads paused", async () => {
    const paused = utxo("c0".repeat(32), { lovelace: "2000000", [policy + utf8ToHex("config")]: "1" }, configToData({ ...cfg, paused: true }));
    const v = await readVault(fakeGet([paused, utxo("a1".repeat(32), { lovelace: "60000000", [unitA]: "1" }, allowanceToData(allowance(0n, t0)))]), policy, "Preprod", Number(t0 + 1n));
    expect(v!.allowances[0]!.status).toBe("paused");
  });
  it("nothing at the address is no vault", async () => {
    expect(await readVault(async () => undefined, policy, "Preprod", Number(t0))).toBeUndefined();
  });

  // History: what each tx did comes from the chain (redeemer, fee, allowance value);
  // only the purpose and intent id come from the agent-written metadata.
  const payee = addressToBech32({ payment: { type: "Key", hash: h(4) }, stake: null }, "Preprod");
  const ownerWallet = addressToBech32({ payment: { type: "Key", hash: h(1) }, stake: null }, "Preprod");
  const redeemer = (index: number) => Data.to(new Constr(index, index < 2 ? ["aa".repeat(32)] : []));
  const lovelace = (n: number) => ({ unit: "lovelace", quantity: String(n) });
  const allowanceAmt = (n: number) => [lovelace(n), { unit: unitA, quantity: "1" }];
  const chain = (txs: Record<string, { utxos: unknown; redeemers?: { tx_index: number; purpose: string; redeemer_data_hash: string }[]; datums?: Record<string, string>; meta?: unknown; fees?: string; time?: number }>): Get =>
    async (path) => {
      const m = /^\/txs\/([0-9a-f]{64})(\/\w+)?$/.exec(path);
      const d = /^\/scripts\/datum\/(\w+)\/cbor$/.exec(path);
      if (d) for (const t of Object.values(txs)) if (t.datums?.[d[1]!]) return { cbor: t.datums[d[1]!] };
      const t = m && txs[m[1]!];
      if (!t) return undefined;
      if (m![2] === "/utxos") return t.utxos;
      if (m![2] === "/redeemers") return t.redeemers ?? [];
      if (m![2] === "/metadata") return t.meta ?? [];
      return m![2] ? undefined : { block_time: t.time ?? 1_790_000_100, fees: t.fees ?? "0" };
    };
  const grant = { utxos: { inputs: [{ tx_hash: "ff".repeat(32), output_index: 0, amount: [lovelace(9)] }], outputs: [] } };

  it("takes the kind from the redeemer, not from the agent's metadata, and counts the fee", async () => {
    const lie = { v: 1, id: "INV-1", kind: "co_signed_spend", purpose: "hosting" };
    const get = chain({
      ["b2".repeat(32)]: {
        utxos: {
          inputs: [
            { tx_hash: "00".repeat(32), output_index: 0, reference: true, amount: [lovelace(5)] },
            { tx_hash: "e9".repeat(32), output_index: 0, collateral: true, amount: [lovelace(10_000_000)] },
            { tx_hash: "a0".repeat(32), output_index: 1, amount: [lovelace(2_000_000)] },
            { tx_hash: "b1".repeat(32), output_index: 0, amount: allowanceAmt(40_000_000) },
          ],
          outputs: [
            { address: payee, amount: [lovelace(4_000_000)] },
            { address: addr, amount: allowanceAmt(35_632_158) },
            { address: "addr_test1vqcollateralreturn", collateral: true, amount: [lovelace(9_448_236)] },
          ],
        },
        // spend inputs sorted: a0…#1 is index 0, the allowance b1…#0 is index 1
        redeemers: [{ tx_index: 0, purpose: "spend", redeemer_data_hash: "r2" }, { tx_index: 1, purpose: "spend", redeemer_data_hash: "r0" }],
        datums: { r0: redeemer(0), r2: redeemer(2) },
        meta: [{ label: "7041", json_metadata: { h: "00", j: JSON.stringify(lie).match(/.{1,64}/g) } }],
        fees: "367842",
      },
      ["b1".repeat(32)]: grant,
    });
    expect(await allowanceHistory(get, unitA, addr, "b2".repeat(32))).toEqual([
      { txHash: "b2".repeat(32), time: 1_790_000_100_000, kind: "agent", purpose: "hosting", intentId: "INV-1", fee: 367_842n, allowanceDelta: -4_367_842n, payees: [{ address: payee, lovelace: 4_000_000n }] },
    ]);
  });

  it("an owner change lists no payees (the owner's change isn't a payment), only the allowance's value change", async () => {
    const get = chain({
      ["b2".repeat(32)]: {
        utxos: {
          inputs: [{ tx_hash: "b1".repeat(32), output_index: 0, amount: allowanceAmt(30_000_000) }, { tx_hash: "c3".repeat(32), output_index: 0, amount: [lovelace(9_000_000_000)] }],
          outputs: [{ address: addr, amount: allowanceAmt(40_000_000) }, { address: ownerWallet, amount: [lovelace(8_989_000_000)] }],
        },
        redeemers: [{ tx_index: 0, purpose: "spend", redeemer_data_hash: "r2" }],
        datums: { r2: redeemer(2) },
        fees: "1000000",
      },
      ["b1".repeat(32)]: grant,
    });
    const [row] = await allowanceHistory(get, unitA, addr, "b2".repeat(32));
    expect(row).toMatchObject({ kind: "owner", payees: [], allowanceDelta: 10_000_000n });
  });
});

describe("swaps and treasury tokens from the chain", () => {
  const policy = h(0x0a);
  const addr = scriptAddress(policy, "Preprod");
  const unitA = policy + h(0x0b);
  const ORDER = "addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3";
  const NACRE_LP = "e5358cee5d14b83d0a4e93f321c0c3addaf8fb5010a1127b6da6a8adc0a16fd3";
  const NACRE = "f9f812798ef9323119314c30f1ca5dd16e9eec5c116fa2c2e3a55b160014df104e41435245";
  const lov = (n: number) => ({ unit: "lovelace", quantity: String(n) });
  const order = orderDatumToData({
    adapter: h(0xad), receiver: { payment: { type: "Script", hash: policy }, stake: null }, lp: { policy: "d6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b", name: NACRE_LP },
    aToB: true, amount: 5_000_000n, minimumReceive: 9_000_000n, maxBatcherFee: 2_000_000n, expiry: 1_790_003_600_000n, tip: 500_000n,
  });
  const tradeTx = (consumedBy?: string) => ({
    inputs: [{ tx_hash: "b1".repeat(32), output_index: 0, amount: [lov(40_000_000), { unit: unitA, quantity: "1" }] }],
    outputs: [
      { address: ORDER, output_index: 0, amount: [lov(9_500_000)], inline_datum: order, consumed_by_tx: consumedBy ?? null },
      { address: addr, output_index: 1, amount: [lov(30_100_000), { unit: unitA, quantity: "1" }] },
    ],
  });
  const get = (tx: unknown, fill?: unknown): Get => async (path) => {
    if (path === `/txs/${"b2".repeat(32)}/utxos`) return tx;
    if (path === `/txs/${"b1".repeat(32)}/utxos`) return { inputs: [{ tx_hash: "ff".repeat(32), output_index: 0, amount: [lov(9)] }], outputs: [] };
    if (path === `/txs/${"b2".repeat(32)}/redeemers`) return [{ tx_index: 0, purpose: "spend", redeemer_data_hash: "r3" }];
    if (path === "/scripts/datum/r3/cbor") return { cbor: Data.to(new Constr(3, ["aa".repeat(32)])) };
    if (path === `/txs/${"b2".repeat(32)}/metadata`) return [];
    if (path === `/txs/${"b2".repeat(32)}`) return { block_time: 1_790_000_100, fees: "400000" };
    if (path === `/txs/${"c9".repeat(32)}/utxos`) return fill;
    return undefined;
  };

  it("a trade row says what the order asks for, and that it's still pending", async () => {
    const [row] = await allowanceHistory(get(tradeTx()), unitA, addr, "b2".repeat(32));
    expect(row).toMatchObject({ kind: "trade", payees: [], trade: { app: "minswap", pool: "ADA ↔ NACRE", amountIn: 5_000_000n, minimumReceive: 9_000_000n, sells: "lovelace", buys: NACRE, orderTx: "b2".repeat(32), status: "pending" } });
  });

  it("a filled trade says what reached the vault", async () => {
    const fill = { inputs: [], outputs: [{ address: addr, output_index: 0, amount: [lov(2_000_000), { unit: NACRE, quantity: "9300000" }] }] };
    const [row] = await allowanceHistory(get(tradeTx("c9".repeat(32)), fill), unitA, addr, "b2".repeat(32));
    expect(row!.trade).toMatchObject({ status: "filled", settledTx: "c9".repeat(32), received: { lovelace: 2_000_000n, [NACRE]: 9_300_000n } });
  });

  it("the treasury lists every token it holds", async () => {
    const cfg = configToData({ owners: [h(1)], threshold: 1n, paused: false, maxTxValidityMs: 600_000n, apps: [] });
    const utxos = [
      { tx_hash: "c0".repeat(32), output_index: 0, inline_datum: cfg, amount: [lov(2_000_000), { unit: policy + utf8ToHex("config"), quantity: "1" }] },
      { tx_hash: "e0".repeat(32), output_index: 0, inline_datum: null, amount: [lov(150_000_000)] },
      { tx_hash: "e1".repeat(32), output_index: 0, inline_datum: null, amount: [lov(2_000_000), { unit: NACRE, quantity: "9300000" }] },
    ];
    const v = await readVault(async (path) => (path.startsWith(`/addresses/${addr}/utxos`) && path.includes("page=1") ? utxos : undefined), policy, "Preprod", 1_790_000_000_000);
    expect(v!.treasuryLovelace).toBe(152_000_000n);
    expect(v!.treasury).toEqual({ lovelace: 152_000_000n, [NACRE]: 9_300_000n });
  });
});

describe("app settings without Lucid", () => {
  it("Minswap settings decode the same as the SDK's", async () => {
    const { settingsToData } = await import("../../src/core/apps/minswap/data.js");
    const { minswapSettingsFromCbor } = await import("../../src/read/decode.js");
    const s = { pools: ["4c51", "4c50"], maxSlippageBps: 300n, maxBatcherFee: 2_000_000n, maxOrderTtlMs: 3_600_000n, maxCancelTip: 500_000n };
    expect(minswapSettingsFromCbor(settingsToData(s))).toEqual(s);
    expect(minswapSettingsFromCbor(settingsToData({ ...s, pools: "any" }))).toEqual({ ...s, pools: "any" });
    expect(minswapSettingsFromCbor("d87980")).toBeNull();
  });
});

describe("light encoder", () => {
  it("re-encodes any Plutus data so Lucid decodes it to the same value", async () => {
    const { Constr, Data } = await import("@lucid-evolution/lucid");
    const { decodePlutusData, encodePlutusData } = await import("../../src/read/plutus-cbor.js");
    const samples = [
      Data.to(new Constr(0, [["4c51", "4c50"], 300n, 2_000_000n, 3_600_000n, 500_000n])),
      Data.to(new Constr(9, [-5n, 2n ** 70n, -(2n ** 70n), "ab".repeat(80), new Map([[1n, "00"]])])),
      Data.to(new Constr(130, [[]])),
    ];
    for (const hex of samples) expect(Data.from(encodePlutusData(decodePlutusData(hex)))).toEqual(Data.from(hex));
  });
});

describe("version-1 vaults (before apps)", () => {
  it("a four-field config reads as version 1, with no apps; the strict reader refuses it", async () => {
    const { Constr, Data } = await import("@lucid-evolution/lucid");
    const { configFromCbor, versionedConfigFromCbor } = await import("../../src/read/decode.js");
    const v1 = Data.to(new Constr(0, [["aa".repeat(28)], 1n, new Constr(1, []), 3_600_000n]));
    expect(versionedConfigFromCbor(v1)).toEqual({ version: 1, config: { owners: ["aa".repeat(28)], threshold: 1n, paused: true, maxTxValidityMs: 3_600_000n, apps: [] } });
    expect(() => configFromCbor(v1)).toThrow();
    expect(() => versionedConfigFromCbor(v1, 2)).toThrow();
  });
  it("an eight-field allowance reads only as version 1", async () => {
    const { Constr, Data } = await import("@lucid-evolution/lucid");
    const { allowanceFromCbor } = await import("../../src/read/decode.js");
    const v1 = Data.to(new Constr(0, ["bb".repeat(28), [], [new Constr(0, ["", "", 5n, 2n])], [0n], 0n, 86_400_000n, 10n ** 13n, 1_000_000n]));
    expect(allowanceFromCbor(v1, 1).apps).toEqual([]);
    expect(() => allowanceFromCbor(v1)).toThrow();
  });
});

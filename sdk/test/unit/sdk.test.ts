import { describe, expect, it } from "vitest";
import { CML, Data, generatePrivateKey } from "@lucid-evolution/lucid";
import {
  addressFromData,
  addressToData,
  allowanceFromData,
  allowanceToData,
  configFromData,
  configToData,
  type AllowanceDatum,
} from "../../src/core/data.js";
import { canonicalJson, intentHash, intentMetadata, verifyIntent, type Intent } from "../../src/core/intent.js";
import { configChangeProblems, floorDiv, nextAllowance, wellFormedProblems, LimitError } from "../../src/core/limits.js";
import { evaluate, type SignerPolicy } from "../../src/node/signer/policy.js";

const k = (n: number) => n.toString(16).padStart(2, "0").repeat(28);

const base: AllowanceDatum = {
  agent: k(1),
  destinations: [{ payment: { type: "Key", hash: k(2) }, stake: { type: "Key", hash: k(3) } }],
  caps: [{ policy: "", name: "", windowCap: 50n, txCap: 20n }],
  spent: [0n],
  windowStart: 1000n,
  periodMs: 100n,
  expiresAt: 100_000n,
  maxFee: 5n,
  apps: [],
};

describe("data encoding", () => {
  it("allowance datum round-trips", () => {
    expect(allowanceFromData(allowanceToData(base))).toEqual(base);
  });
  it("config round-trips and Bool uses Aiken's constructor order", () => {
    const c = { owners: [k(1), k(2)], threshold: 2n, paused: true, maxTxValidityMs: 10n, apps: [] };
    expect(configFromData(configToData(c))).toEqual(c);
    expect(Data.to(addressToData({ payment: { type: "Key", hash: k(9) }, stake: null }))).toContain("d87a80"); // None = Constr 1 []
  });
  it("address with pointer round-trips", () => {
    const a = { payment: { type: "Key" as const, hash: k(4) }, stake: { pointer: [1n, 2n, 3n] as [bigint, bigint, bigint] } };
    expect(addressFromData(addressToData(a))).toEqual(a);
  });
  it("rejects garbage as an allowance datum", () => {
    expect(() => allowanceFromData(Data.to(42n))).toThrow();
  });
});

describe("limits mirror", () => {
  it("floorDiv matches Plutus divideInteger", () => {
    expect(floorDiv(-1n, 100n)).toBe(-1n);
    expect(floorDiv(199n, 100n)).toBe(1n);
  });
  it("deny-by-default problems", () => {
    expect(wellFormedProblems({ ...base, destinations: [] })).toContain("allowlist is empty");
    expect(wellFormedProblems({ ...base, spent: [-1n] })).toContain("negative spent");
    expect(wellFormedProblems({ ...base, periodMs: 0n })).toContain("period must be > 0");
    const capOut = "cap outside 0 < tx cap <= window cap";
    expect(wellFormedProblems({ ...base, caps: [{ policy: "", name: "", windowCap: 50n, txCap: 0n }] })).toContain(capOut);
    expect(wellFormedProblems({ ...base, caps: [{ policy: "", name: "", windowCap: 50n, txCap: 51n }] })).toContain(capOut);
    expect(wellFormedProblems({ ...base, caps: [{ policy: "", name: "", windowCap: 50n, txCap: 50n }] })).toEqual([]);
  });
  const cfg = { owners: [k(7)], threshold: 1n, paused: false, maxTxValidityMs: 50n, apps: [] };
  const args = { datum: base, config: cfg, fee: 1n, lower: 1010n, upper: 1020n, payTo: base.destinations };
  it("computes the next datum, rolling the window", () => {
    expect(nextAllowance({ ...args, delta: { lovelace: 10n } }).spent).toEqual([10n]);
    const rolled = nextAllowance({ ...args, datum: { ...base, spent: [50n] }, lower: 1210n, upper: 1220n, delta: { lovelace: 10n } });
    expect(rolled.windowStart).toBe(1200n);
    expect(rolled.spent).toEqual([10n]);
  });
  it("refuses straddling, caps and destinations with typed codes", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as LimitError).code;
      }
    };
    expect(code(() => nextAllowance({ ...args, lower: 1090n, upper: 1110n, delta: { lovelace: 1n } }))).toBe("TIME");
    expect(code(() => nextAllowance({ ...args, delta: { lovelace: 21n } }))).toBe("TX_CAP");
    expect(code(() => nextAllowance({ ...args, datum: { ...base, spent: [45n] }, delta: { lovelace: 10n } }))).toBe("WINDOW_CAP");
    expect(code(() => nextAllowance({ ...args, delta: { lovelace: 1n, abc: 1n } }))).toBe("UNCAPPED_ASSET");
    expect(
      code(() => nextAllowance({ ...args, delta: { lovelace: 1n }, payTo: [{ payment: { type: "Key", hash: k(2) }, stake: null }] })),
    ).toBe("DESTINATION");
    expect(code(() => nextAllowance({ ...args, config: { ...cfg, paused: true }, delta: { lovelace: 1n } }))).toBe("PAUSED");
  });
});

describe("intent records", () => {
  const intent: Intent = {
    v: 1,
    id: "INV-1",
    kind: "agent_spend",
    allowance: "aa",
    agent: k(1),
    payments: [{ to: "addr_test1...", assets: { lovelace: "5000000" } }],
    purpose: "pay invoice — ünïcödé ".repeat(10),
    created_at: "2026-10-05T00:00:00.000Z",
  };
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
  it("metadata chunks are <= 64 bytes and verify against the redeemer hash", () => {
    const m = intentMetadata(intent);
    for (const c of m.j) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(64);
    expect(verifyIntent(m, intentHash(intent))).toEqual(JSON.parse(canonicalJson(intent)));
    expect(() => verifyIntent(m, "00".repeat(32))).toThrow();
  });
});

describe("signer policy", () => {
  // Minimal tx: 1 input, outputs to the vault (carrying the allowance token) + a destination, ttl, required signer.
  const sk = CML.PrivateKey.from_bech32(generatePrivateKey());
  const agentPkh = sk.to_public().hash().to_hex();
  const vaultAddr = CML.EnterpriseAddress.new(0, CML.Credential.new_script(CML.ScriptHash.from_hex(k(5)))).to_address().to_bech32();
  const dest = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(k(6)))).to_address().to_bech32();
  const other = CML.EnterpriseAddress.new(0, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(k(8)))).to_address().to_bech32();
  // 28-byte names: the length CBOR-encodes as two bytes, which a naive `to_cbor_hex().slice(2)` keeps.
  const allowanceUnit = k(5) + "a1".repeat(28);
  const otherAllowance = k(5) + "a2".repeat(28);
  const token = k(7) + "746f6b";
  const value = (lovelace: bigint, units: Record<string, bigint>) => {
    const ma = CML.MultiAsset.new();
    for (const [u, q] of Object.entries(units))
      ma.set(CML.ScriptHash.from_hex(u.slice(0, 56)), CML.AssetName.from_raw_bytes(Buffer.from(u.slice(56), "hex")), q);
    return CML.Value.new(lovelace, ma);
  };
  const mkTx = (opts: { to?: string; lovelace?: bigint; ttl?: bigint; signer?: string; extraSigner?: string; inputs?: number; carries?: string; pays?: Record<string, bigint> }) => {
    const ins = CML.TransactionInputList.new();
    for (let i = 0; i < (opts.inputs ?? 1); i++) ins.add(CML.TransactionInput.new(CML.TransactionHash.from_hex("11".repeat(32)), BigInt(i)));
    const outs = CML.TransactionOutputList.new();
    outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(vaultAddr), value(10_000_000n, { [opts.carries ?? allowanceUnit]: 1n })));
    outs.add(CML.TransactionOutput.new(CML.Address.from_bech32(opts.to ?? dest), value(opts.lovelace ?? 5_000_000n, opts.pays ?? {})));
    const body = CML.TransactionBody.new(ins, outs, 200_000n);
    body.set_ttl(opts.ttl ?? 1_000n);
    const req = CML.Ed25519KeyHashList.new();
    req.add(CML.Ed25519KeyHash.from_hex(opts.signer ?? agentPkh));
    if (opts.extraSigner) req.add(CML.Ed25519KeyHash.from_hex(opts.extraSigner));
    body.set_required_signers(req);
    return CML.Transaction.new(body, CML.TransactionWitnessSet.new(), true).to_cbor_hex();
  };
  const policy: SignerPolicy = {
    agentKeyHash: agentPkh,
    vaultAddress: vaultAddr,
    allowanceUnit,
    destinations: [dest],
    maxTxPerHour: 2,
    maxPerDay: { lovelace: 12_000_000n, [token]: 100n },
    maxTtlMs: 600_000,
    allowCoSigned: false,
    slot: { zeroTime: 0, zeroSlot: 0, slotLength: 1000 },
  };
  const empty = () => ({ signed: [], intents: {} });
  const now = 900_000; // slot 900; ttl 1000 -> 100 s ahead
  it("signs a compliant tx", () => {
    expect(evaluate(policy, empty(), mkTx({}), now)).toEqual({ ok: true, out: { lovelace: 5_200_000n } });
  });
  it("refuses unknown destinations, long TTLs, wrong signer, extra inputs", () => {
    expect(evaluate(policy, empty(), mkTx({ to: other }), now).ok).toBe(false);
    expect(evaluate(policy, empty(), mkTx({ ttl: 10_000n }), now).ok).toBe(false);
    expect(evaluate(policy, empty(), mkTx({ signer: k(9) }), now).ok).toBe(false);
    expect(evaluate(policy, empty(), mkTx({ inputs: 2 }), now).ok).toBe(false);
  });
  it("an extra required signer on an ordinary spend doesn't earn the co-signed TTL", () => {
    const co = { ...policy, allowCoSigned: true, maxCoSignedTtlMs: 24 * 3_600_000 };
    expect(evaluate(co, empty(), mkTx({ extraSigner: k(9), ttl: 10_000n }), now)).toMatchObject({ ok: false, reason: expect.stringMatching(/ttl/) });
  });
  it("refuses extra inputs on the co-signed path too", () => {
    const co = { ...policy, allowCoSigned: true };
    expect(evaluate(co, empty(), mkTx({ inputs: 2 }), now)).toMatchObject({ ok: false, reason: expect.stringMatching(/exactly one input/) });
  });
  it("refuses a spend from any allowance other than the configured one", () => {
    expect(evaluate(policy, empty(), mkTx({ carries: otherAllowance }), now)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not carry allowance/),
    });
  });
  it("rate-limits repeated max spends (prompt-injection loop)", () => {
    const st = { signed: [{ at: now - 1000, assets: { lovelace: 5_200_000n } }, { at: now - 500, assets: { lovelace: 5_200_000n } }], intents: {} };
    const d = evaluate(policy, st, mkTx({}), now);
    expect(d).toMatchObject({ ok: false });
  });
  it("enforces the daily budget", () => {
    const st = { signed: [{ at: now - 4_000_000, assets: { lovelace: 8_000_000n } }], intents: {} };
    expect(evaluate(policy, st, mkTx({}), now)).toMatchObject({ ok: false, reason: expect.stringMatching(/daily budget/) });
  });
  it("counts native tokens against their own daily budget", () => {
    expect(evaluate(policy, empty(), mkTx({ pays: { [token]: 60n } }), now)).toEqual({
      ok: true,
      out: { lovelace: 5_200_000n, [token]: 60n },
    });
    const st = { signed: [{ at: now - 4_000_000, assets: { lovelace: 1n, [token]: 60n } }], intents: {} };
    expect(evaluate(policy, st, mkTx({ pays: { [token]: 60n } }), now)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/daily budget: .*746f6b 60 \+ 60 > 100/),
    });
  });
  it("refuses an asset that has no daily limit (deny by default)", () => {
    const stray = k(9) + "00";
    expect(evaluate(policy, empty(), mkTx({ pays: { [stray]: 1n } }), now)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/has no daily limit/),
    });
  });
});

describe("config changes (mirror of owner_manage)", () => {
  const cfg = { owners: [k(10), k(11), k(12)], threshold: 2n, paused: false, maxTxValidityMs: 600_000n, apps: [] };
  it("the threshold may make any valid change", () => {
    expect(configChangeProblems(cfg, { ...cfg, threshold: 3n }, [k(10), k(11)])).toEqual([]);
  });
  it("one owner may pause an unpaused vault, and nothing else", () => {
    expect(configChangeProblems(cfg, { ...cfg, paused: true }, [k(12)])).toEqual([]);
    expect(configChangeProblems(cfg, { ...cfg, paused: true, threshold: 1n }, [k(12)])).toHaveLength(1);
    expect(configChangeProblems(cfg, { ...cfg, paused: true, owners: [k(10), k(11), k(13)] }, [k(12)])).toHaveLength(1);
    expect(configChangeProblems({ ...cfg, paused: true }, cfg, [k(12)])).toHaveLength(1); // unpause
    expect(configChangeProblems({ ...cfg, paused: true }, { ...cfg, paused: true }, [k(12)])).toHaveLength(1);
  });
  it("a non-owner's signature counts for nothing", () => {
    expect(configChangeProblems(cfg, { ...cfg, paused: true }, [k(13)])).toHaveLength(1);
  });
});

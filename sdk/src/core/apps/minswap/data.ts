// Minswap V2 Plutus data, mirroring onchain/lib/apps/minswap/types.ak (vendored from
// minswap/minswap-dex-v2@c3293ad). Constructor indices are Minswap's; an order Minswap's
// validators can't decode is stuck forever, so every shape here is checked against golden
// CBOR from Aiken and against Minswap's own validator (test/emulator/minswap-compat.test.ts).
import { Constr, Data } from "@lucid-evolution/lucid";
import { addressFromData, addressToData, type Hex, type PlutusAddress } from "../../data.js";

/** The vault's rules for Minswap (`AppConfig.settings`). */
export type MinswapSettings = {
  /** Allowed pools, by LP asset name (hex); the LP policy is the deployment's. */
  pools: Hex[];
  maxSlippageBps: bigint;
  maxBatcherFee: bigint;
  maxOrderTtlMs: bigint;
  maxCancelTip: bigint;
};

/** The only order shape gendo places: swap exact in, a stated amount, killable, both receivers the vault without datum. */
export type MinswapOrder = {
  /** The adapter's script hash: the order's canceller (`OAMWithdrawScript`). */
  adapter: Hex;
  /** Success and refund receiver (the vault's canonical address). */
  receiver: PlutusAddress;
  lp: { policy: Hex; name: Hex };
  aToB: boolean;
  amount: bigint;
  minimumReceive: bigint;
  maxBatcherFee: bigint;
  /** POSIX ms after which anyone may refund the order to `receiver`. */
  expiry: bigint;
  tip: bigint;
};

export type MinswapPool = {
  assetA: { policy: Hex; name: Hex };
  assetB: { policy: Hex; name: Hex };
  totalLiquidity: bigint;
  reserveA: bigint;
  reserveB: bigint;
  feeA: bigint;
  feeB: bigint;
};

const bool = (b: boolean) => new Constr(b ? 1 : 0, []);
const EOD_NO_DATUM = () => new Constr(0, []);
const OAM_WITHDRAW = 2;
const SWAP_EXACT_IN = 0;
const SAO_SPECIFIC = 0;

export function settingsToData(s: MinswapSettings): string {
  return Data.to(new Constr(0, [s.pools, s.maxSlippageBps, s.maxBatcherFee, s.maxOrderTtlMs, s.maxCancelTip]));
}

export function settingsFromData(cbor: string): MinswapSettings {
  const c = Data.from(cbor) as Constr<Data>;
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 5) throw new Error("not Minswap settings");
  const [pools, slip, fee, ttl, tip] = c.fields;
  return { pools: pools as string[], maxSlippageBps: slip as bigint, maxBatcherFee: fee as bigint, maxOrderTtlMs: ttl as bigint, maxCancelTip: tip as bigint };
}

export function orderDatumToData(o: MinswapOrder): string {
  const receiver = addressToData(o.receiver);
  return Data.to(
    new Constr(0, [
      new Constr(OAM_WITHDRAW, [o.adapter]),
      receiver,
      EOD_NO_DATUM(),
      receiver,
      EOD_NO_DATUM(),
      new Constr(0, [o.lp.policy, o.lp.name]),
      new Constr(SWAP_EXACT_IN, [bool(o.aToB), new Constr(SAO_SPECIFIC, [o.amount]), o.minimumReceive, bool(true)]),
      o.maxBatcherFee,
      // Option<(Int, Int)>: Some, and an Aiken tuple is a Plutus *list*.
      new Constr(0, [[o.expiry, o.tip]]),
    ]),
  );
}

const isConstr = (d: unknown, index: number, n: number): d is Constr<Data> =>
  d instanceof Constr && d.index === index && d.fields.length === n;

/** One of our orders, or null for any other shape (another step, another canceller, a datum on a receiver, ...). */
export function orderDatumFromData(cbor: string): MinswapOrder | null {
  try {
    const c = Data.from(cbor);
    if (!isConstr(c, 0, 9)) return null;
    const [canceller, refund, refundDatum, success, successDatum, lp, step, fee, expiry] = c.fields;
    if (!isConstr(canceller, OAM_WITHDRAW, 1) || !isConstr(refundDatum, 0, 0) || !isConstr(successDatum, 0, 0)) return null;
    if (Data.to(refund!) !== Data.to(success!)) return null;
    if (!isConstr(lp, 0, 2) || !isConstr(step, SWAP_EXACT_IN, 4)) return null;
    const [dir, amountOpt, min, killable] = step.fields;
    if (!isConstr(amountOpt, SAO_SPECIFIC, 1) || !isConstr(killable, 1, 0) || !(dir instanceof Constr)) return null;
    if (!isConstr(expiry, 0, 1) || !Array.isArray(expiry.fields[0]) || (expiry.fields[0] as Data[]).length !== 2) return null;
    const [time, tip] = expiry.fields[0] as bigint[];
    return {
      adapter: canceller.fields[0] as string,
      receiver: addressFromData(success!),
      lp: { policy: lp.fields[0] as string, name: lp.fields[1] as string },
      aToB: dir.index === 1,
      amount: amountOpt.fields[0] as bigint,
      minimumReceive: min as bigint,
      maxBatcherFee: fee as bigint,
      expiry: time!,
      tip: tip!,
    };
  } catch {
    return null;
  }
}

export function poolDatumFromData(cbor: string): MinswapPool {
  const c = Data.from(cbor);
  if (!isConstr(c, 0, 10)) throw new Error("not a Minswap pool datum");
  const asset = (d: Data) => {
    if (!isConstr(d, 0, 2)) throw new Error("bad asset");
    return { policy: d.fields[0] as string, name: d.fields[1] as string };
  };
  const [, a, b, total, ra, rb, fa, fb] = c.fields;
  return { assetA: asset(a!), assetB: asset(b!), totalLiquidity: total as bigint, reserveA: ra as bigint, reserveB: rb as bigint, feeA: fa as bigint, feeB: fb as bigint };
}

/** A pool datum, for devnet fixtures and tests (gendo never writes pools on preprod). */
export function poolDatumToData(p: MinswapPool & { batchingStakeScript: Hex }): string {
  const asset = (a: { policy: Hex; name: Hex }) => new Constr(0, [a.policy, a.name]);
  return Data.to(
    new Constr(0, [
      new Constr(0, [new Constr(1, [p.batchingStakeScript])]), // Inline(Script(hash))
      asset(p.assetA),
      asset(p.assetB),
      p.totalLiquidity,
      p.reserveA,
      p.reserveB,
      p.feeA,
      p.feeB,
      new Constr(1, []), // fee_sharing_numerator_opt: None
      new Constr(0, []), // allow_dynamic_fee: False
    ]),
  );
}

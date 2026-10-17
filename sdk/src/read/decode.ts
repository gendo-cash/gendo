// sdk/src/read/decode.ts
// The vault's datums and addresses for the light read path (no Lucid). Mirrors
// sdk/src/core/data.ts constructor by constructor; tests check the two agree.
import { bech32 } from "@scure/base";
import type { AllowanceDatum, ConfigDatum, Credential, PlutusAddress } from "../core/data.js";
import { fromHex } from "../core/bytes.js";
import { asBytes, asConstr, asInt, asList, decodePlutusData, encodePlutusData, type PData } from "./plutus-cbor.js";
import { hexToUtf8 } from "../core/bytes.js";

export type ReadNetwork = "Preprod" | "Preview" | "Custom";

export function configFromCbor(hex: string): ConfigDatum {
  const [owners, threshold, paused, maxTx, apps] = asConstr(decodePlutusData(hex), 0, 5);
  const p = paused!;
  if (p.k !== "constr" || p.fields.length !== 0 || p.index > 1) throw new Error("bad Bool");
  return {
    owners: asList(owners!).map(asBytes),
    threshold: asInt(threshold!),
    paused: p.index === 1,
    maxTxValidityMs: asInt(maxTx!),
    apps: asList(apps!).map((a) => {
      const [name, adapter, orderScript, settings] = asConstr(a, 0, 4);
      return { name: hexToUtf8(asBytes(name!)), adapter: asBytes(adapter!), orderScript: asBytes(orderScript!), settings: encodePlutusData(settings!) };
    }),
  };
}

const credential = (d: PData): Credential => {
  const c = d as { k: "constr"; index: number };
  const [hash] = asConstr(d, undefined, 1);
  if (c.index > 1) throw new Error("bad credential");
  return { type: c.index === 0 ? "Key" : "Script", hash: asBytes(hash!) };
};

function address(d: PData): PlutusAddress {
  const [pay, stakeOpt] = asConstr(d, 0, 2);
  const opt = stakeOpt as { k: string; index: number };
  if (opt.k !== "constr") throw new Error("bad stake option");
  if (opt.index === 1) return { payment: credential(pay!), stake: null };
  const [ref] = asConstr(stakeOpt!, 0, 1);
  const r = ref as { k: string; index: number };
  if (r.k === "constr" && r.index === 0) return { payment: credential(pay!), stake: credential(asConstr(ref!, 0, 1)[0]!) };
  const [a, b, c] = asConstr(ref!, 1, 3);
  return { payment: credential(pay!), stake: { pointer: [asInt(a!), asInt(b!), asInt(c!)] } };
}

export function allowanceFromCbor(hex: string): AllowanceDatum {
  const [agent, dests, caps, spent, ws, period, exp, maxFee, apps] = asConstr(decodePlutusData(hex), 0, 9);
  return {
    agent: asBytes(agent!),
    destinations: asList(dests!).map(address),
    caps: asList(caps!).map((c) => {
      const [policy, name, windowCap, txCap] = asConstr(c, 0, 4);
      return { policy: asBytes(policy!), name: asBytes(name!), windowCap: asInt(windowCap!), txCap: asInt(txCap!) };
    }),
    spent: asList(spent!).map(asInt),
    windowStart: asInt(ws!),
    periodMs: asInt(period!),
    expiresAt: asInt(exp!),
    maxFee: asInt(maxFee!),
    apps: asList(apps!).map((n) => hexToUtf8(asBytes(n))),
  };
}

/** Variable-length natural number (CIP-19 pointer addresses). */
function varUint(n: bigint): number[] {
  const out = [Number(n & 0x7fn)];
  for (n >>= 7n; n > 0n; n >>= 7n) out.unshift(Number(n & 0x7fn) | 0x80);
  return out;
}

/** CIP-19 address bytes, then bech32. Testnet networks only. */
export function addressToBech32(a: PlutusAddress, network: ReadNetwork): string {
  void network; // every ReadNetwork is a testnet: network id 0, prefix addr_test
  const payScript = a.payment.type === "Script";
  let type: number;
  let tail: number[] = [];
  if (a.stake === null) type = payScript ? 7 : 6;
  else if ("pointer" in a.stake) {
    type = payScript ? 5 : 4;
    tail = a.stake.pointer.flatMap(varUint);
  } else {
    type = (payScript ? 1 : 0) | (a.stake.type === "Script" ? 2 : 0);
    tail = [...fromHex(a.stake.hash)];
  }
  const bytes = new Uint8Array([(type << 4) | 0, ...fromHex(a.payment.hash), ...tail]);
  return bech32.encode("addr_test", bech32.toWords(bytes), 1000);
}

/** The vault's canonical address: its policy id is the script hash; no stake part. */
export const scriptAddress = (policy: string, network: ReadNetwork) =>
  addressToBech32({ payment: { type: "Script", hash: policy }, stake: null }, network);

/** A Minswap order of ours (see core/apps/minswap/data.ts), without Lucid; null for any other shape. */
export function orderFromCbor(hex: string): { adapter: string; lpPolicy: string; lpName: string; aToB: boolean; amount: bigint; minimumReceive: bigint; maxBatcherFee: bigint; expiry: bigint; tip: bigint } | null {
  try {
    const [canceller, , , , , lp, step, fee, expiry] = asConstr(decodePlutusData(hex), 0, 9);
    const [adapter] = asConstr(canceller!, 2, 1);
    const [lpPolicy, lpName] = asConstr(lp!, 0, 2);
    const [dir, amountOpt, min, killable] = asConstr(step!, 0, 4);
    const [amount] = asConstr(amountOpt!, 0, 1);
    asConstr(killable!, 1, 0);
    const [pair] = asConstr(expiry!, 0, 1);
    const [time, tip] = asList(pair!);
    const d = dir as { k: string; index: number };
    if (d.k !== "constr" || time === undefined || tip === undefined) return null;
    return { adapter: asBytes(adapter!), lpPolicy: asBytes(lpPolicy!), lpName: asBytes(lpName!), aToB: d.index === 1, amount: asInt(amount!), minimumReceive: asInt(min!), maxBatcherFee: asInt(fee!), expiry: asInt(time), tip: asInt(tip) };
  } catch {
    return null;
  }
}

/** The vault's Minswap settings (`AppConfig.settings`), without Lucid; null if unreadable. */
export function minswapSettingsFromCbor(hex: string): { pools: string[]; maxSlippageBps: bigint; maxBatcherFee: bigint; maxOrderTtlMs: bigint; maxCancelTip: bigint } | null {
  try {
    const [pools, slip, fee, ttl, tip] = asConstr(decodePlutusData(hex), 0, 5);
    return { pools: asList(pools!).map(asBytes), maxSlippageBps: asInt(slip!), maxBatcherFee: asInt(fee!), maxOrderTtlMs: asInt(ttl!), maxCancelTip: asInt(tip!) };
  } catch {
    return null;
  }
}

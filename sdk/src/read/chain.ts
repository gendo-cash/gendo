// sdk/src/read/chain.ts
// Vault state and payment history from a Blockfrost-style REST API (through
// the server's /chain proxy in the app). No Lucid: datums are decoded by
// ./decode.ts, budget arithmetic reuses ../core/limits.ts.
import type { ConfigDatum } from "../core/data.js";
import type { Intent } from "../core/intent.js";
import { utf8ToHex } from "../core/bytes.js";
import { floorDiv, unitOf, wellFormedProblems } from "../core/limits.js";
import { addressToBech32, allowanceFromCbor, orderFromCbor, scriptAddress, versionedConfigFromCbor, type ReadNetwork } from "./decode.js";
import { isOrderAddress, poolByLp } from "../core/apps/catalogue.js";
import { orderStatus } from "../core/apps/minswap/status.js";
import { decodePlutusData } from "./plutus-cbor.js";

export type Get = (path: string) => Promise<unknown | undefined>;
export type CapView = { unit: string; perPayment: bigint; perPeriod: bigint; spentThisPeriod: bigint; leftThisPeriod: bigint };
export type AllowanceView = {
  unit: string;
  txHash: string;
  outputIndex: number;
  lovelace: bigint;
  status: "active" | "paused" | "expired" | "not started" | "malformed";
  agent?: string;
  caps: CapView[];
  payees: string[];
  periodMs?: bigint;
  periodEndsAt?: number;
  expiresAt?: number;
  maxFee?: bigint;
  /** Apps this agent may trade with (names; they work only while the vault enables them). */
  apps?: string[];
};
export type VaultView = {
  policy: string;
  address: string;
  config: ConfigDatum | null;
  /** The vault's code: 2 is current; 1 is from before apps (it can only move its funds to a current vault). */
  version: 1 | 2;
  treasuryLovelace: bigint;
  /** Everything the treasury holds, per unit (`lovelace` included): swap proceeds land here. */
  treasury: Record<string, bigint>;
  allowances: AllowanceView[];
};
export type TradeView = {
  app: "minswap";
  /** The catalogue's label ("ADA ↔ NACRE"), else the LP name. */
  pool: string;
  lpName: string;
  sells: string;
  buys: string;
  amountIn: bigint;
  minimumReceive: bigint;
  orderTx: string;
  status: "pending" | "filled" | "refunded" | "unknown";
  settledTx?: string;
  /** What reached the vault when it settled. */
  received?: Record<string, bigint>;
};
export type PaymentView = {
  txHash: string;
  time: number;
  /** From the vault redeemer on chain; "unknown" when it couldn't be read. */
  kind: "agent" | "co-signed" | "owner" | "trade" | "unknown";
  /** Agent-written metadata: a claim, not a control. */
  purpose?: string;
  intentId?: string;
  fee: bigint;
  /** The allowance's ADA after this tx minus before (a payment is negative, fee included). */
  allowanceDelta: bigint;
  /** Who was paid: agent and co-signed spends only (an owner tx's other outputs are the owner's own change). */
  payees: { address: string; lovelace: bigint }[];
  /** A swap (`kind: "trade"`): what the order asks for and how it settled. */
  trade?: TradeView;
};

type BfAmount = { unit: string; quantity: string };
type BfUtxo = { tx_hash: string; output_index: number; amount: BfAmount[]; inline_datum: string | null };
const qty = (amount: BfAmount[], unit: string) => BigInt(amount.find((a) => a.unit === unit)?.quantity ?? "0");

async function utxosAt(get: Get, address: string): Promise<BfUtxo[]> {
  const out: BfUtxo[] = [];
  for (let page = 1; page <= 20; page++) {
    const batch = (await get(`/addresses/${address}/utxos?page=${page}&count=100`)) as BfUtxo[] | undefined;
    if (!batch?.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const MAX_DATE_MS = 8_640_000_000_000_000n; // the largest time a JS Date can show

function allowanceView(u: BfUtxo, unit: string, network: ReadNetwork, now: bigint, version: 1 | 2 = 2): AllowanceView {
  const base = { unit, txHash: u.tx_hash, outputIndex: u.output_index, lovelace: qty(u.amount, "lovelace"), caps: [], payees: [] };
  let d;
  try {
    if (!u.inline_datum) throw new Error("no inline datum");
    d = allowanceFromCbor(u.inline_datum, version);
  } catch {
    return { ...base, status: "malformed" };
  }
  // Minting doesn't check the datum; only an agent spend does. A datum the validator would
  // refuse (or with dates no clock can show) is unspendable, so say so instead of "active".
  const inRange = (t: bigint) => t > -MAX_DATE_MS && t < MAX_DATE_MS;
  if (wellFormedProblems(d).length || !inRange(d.windowStart) || !inRange(d.expiresAt) || !inRange(d.windowStart + d.periodMs * 2n))
    return { ...base, status: "malformed" };
  const started = now >= d.windowStart;
  const k = started && d.periodMs > 0n ? floorDiv(now - d.windowStart, d.periodMs) : 0n;
  return {
    ...base,
    agent: d.agent,
    status: !started ? "not started" : now >= d.expiresAt ? "expired" : "active",
    caps: d.caps.map((c, i) => {
      const spent = k === 0n ? (d.spent[i] ?? 0n) : 0n;
      return { unit: unitOf(c.policy, c.name), perPayment: c.txCap, perPeriod: c.windowCap, spentThisPeriod: spent, leftThisPeriod: c.windowCap - spent };
    }),
    payees: d.destinations.map((a) => addressToBech32(a, network)),
    periodMs: d.periodMs,
    periodEndsAt: Number(d.windowStart + (k + 1n) * d.periodMs),
    expiresAt: Number(d.expiresAt),
    maxFee: d.maxFee,
    apps: d.apps,
  };
}

/** The vault at `policy`, or undefined when its config token isn't at its address. */
export async function readVault(get: Get, policy: string, network: ReadNetwork, nowMs: number): Promise<VaultView | undefined> {
  const address = scriptAddress(policy, network);
  const utxos = await utxosAt(get, address);
  if (!utxos.length) return undefined;
  const configUnit = policy + utf8ToHex("config");
  const now = BigInt(nowMs);
  let config: ConfigDatum | null = null;
  let version: 1 | 2 = 2;
  const cfgUtxo = utxos.find((u) => u.amount.some((a) => a.unit === configUnit));
  if (!cfgUtxo) return undefined;
  try {
    ({ config, version } = versionedConfigFromCbor(cfgUtxo.inline_datum ?? ""));
  } catch {
    config = null;
  }
  let treasuryLovelace = 0n;
  const treasury: Record<string, bigint> = {};
  const allowances: AllowanceView[] = [];
  for (const u of utxos) {
    const vaultUnits = u.amount.filter((a) => a.unit.startsWith(policy) && a.unit !== "lovelace");
    if (vaultUnits.some((a) => a.unit === configUnit)) continue;
    else if (vaultUnits.length === 1 && vaultUnits[0]!.quantity === "1") allowances.push(allowanceView(u, vaultUnits[0]!.unit, network, now, version));
    else if (vaultUnits.length === 0) {
      treasuryLovelace += qty(u.amount, "lovelace");
      for (const a of u.amount) treasury[a.unit] = (treasury[a.unit] ?? 0n) + BigInt(a.quantity);
    }
  }
  if (config?.paused) for (const a of allowances) if (a.status === "active") a.status = "paused";
  return { policy, address, config, version, treasuryLovelace, treasury, allowances };
}

// Blockfrost flags reference and collateral inputs, and the collateral-return output: none of
// them is part of what the tx did to the allowance.
type BfIn = { tx_hash: string; output_index: number; amount: BfAmount[]; reference?: boolean; collateral?: boolean };
type BfTxUtxos = { inputs: BfIn[]; outputs: { address: string; amount: BfAmount[]; collateral?: boolean; inline_datum?: string | null }[] };
type BfRedeemer = { tx_index: number; purpose: string; redeemer_data_hash: string };
const KINDS = ["agent", "co-signed", "owner", "trade"] as const; // SpendRedeemer constructors 0, 1, 2, 3

/** The vault redeemer on the allowance input: the ledger indexes spend redeemers by sorted input. */
async function spendKind(get: Get, txHash: string, io: BfTxUtxos, input: BfIn): Promise<PaymentView["kind"]> {
  const spends = io.inputs
    .filter((x) => !x.reference && !x.collateral)
    .sort((a, b) => (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.output_index - b.output_index));
  const index = spends.indexOf(input);
  const r = ((await get(`/txs/${txHash}/redeemers`)) as BfRedeemer[] | undefined)?.find((x) => x.purpose === "spend" && x.tx_index === index);
  const datum = r && ((await get(`/scripts/datum/${r.redeemer_data_hash}/cbor`)) as { cbor: string } | undefined);
  try {
    const c = datum && decodePlutusData(datum.cbor);
    if (c && c.k === "constr" && c.index < KINDS.length) return KINDS[c.index]!;
  } catch {
    // unreadable redeemer: fall through
  }
  return "unknown";
}

function readIntent(meta: { label: string; json_metadata: { j?: string[] } }[] | undefined): Partial<Intent> | undefined {
  try {
    const j = meta?.find((m) => m.label === "7041")?.json_metadata.j;
    return j ? (JSON.parse(j.join("")) as Partial<Intent>) : undefined;
  } catch {
    return undefined;
  }
}

/** Newest first: each tx that spent this allowance, back to (not including) the grant. */
export async function allowanceHistory(get: Get, unit: string, vaultAddress: string, fromTx: string, lookback = 20): Promise<PaymentView[]> {
  const out: PaymentView[] = [];
  let cur: string | undefined = fromTx;
  for (let i = 0; cur && i < lookback; i++) {
    const io = (await get(`/txs/${cur}/utxos`)) as BfTxUtxos | undefined;
    const prev = io?.inputs.find((x) => !x.reference && !x.collateral && x.amount.some((a) => a.unit === unit));
    if (!io || !prev) break; // the grant mints the token: nothing older to show
    const [meta, tx, kind] = await Promise.all([
      get(`/txs/${cur}/metadata`) as Promise<{ label: string; json_metadata: { j?: string[] } }[] | undefined>,
      get(`/txs/${cur}`) as Promise<{ block_time: number; fees?: string } | undefined>,
      spendKind(get, cur, io, prev),
    ]);
    const intent = readIntent(meta);
    const after = io.outputs.find((o) => !o.collateral && o.address === vaultAddress && o.amount.some((a) => a.unit === unit));
    const trade = kind === "trade" ? await tradeOf(get, cur, io, vaultAddress) : undefined;
    out.push({
      txHash: cur,
      time: (tx?.block_time ?? 0) * 1000,
      kind,
      ...(intent?.purpose !== undefined ? { purpose: String(intent.purpose) } : {}),
      ...(intent?.id !== undefined ? { intentId: String(intent.id) } : {}),
      fee: BigInt(tx?.fees ?? "0"),
      allowanceDelta: (after ? qty(after.amount, "lovelace") : 0n) - qty(prev.amount, "lovelace"),
      payees:
        kind === "agent" || kind === "co-signed" || kind === "trade"
          ? io.outputs.filter((o) => !o.collateral && o.address !== vaultAddress && !isOrderAddress(o.address)).map((o) => ({ address: o.address, lovelace: qty(o.amount, "lovelace") }))
          : [],
      ...(trade ? { trade } : {}),
    });
    cur = prev.tx_hash;
  }
  return out;
}

/** The order a trade placed (decoded from its own output) and how it settled. */
async function tradeOf(get: Get, txHash: string, io: BfTxUtxos, vaultAddress: string): Promise<TradeView | undefined> {
  const out = io.outputs.find((o) => isOrderAddress(o.address) && o.inline_datum);
  const order = out?.inline_datum ? orderFromCbor(out.inline_datum) : null;
  if (!out || !order) return undefined;
  const found = poolByLp(order.lpName);
  const [sells, buys] = found ? (order.aToB ? [found.pool.assetA, found.pool.assetB] : [found.pool.assetB, found.pool.assetA]) : ["?", "?"];
  const st = await orderStatus(get, { orderTx: txHash, orderAddress: out.address, vaultAddress, inUnit: sells, outUnit: buys, minimumReceive: order.minimumReceive });
  return {
    app: "minswap",
    pool: found?.pool.label ?? order.lpName,
    lpName: order.lpName,
    sells,
    buys,
    amountIn: order.amount,
    minimumReceive: order.minimumReceive,
    orderTx: txHash,
    status: st.status,
    ...(st.status === "filled" || st.status === "refunded" ? { settledTx: st.tx, received: st.received } : {}),
  };
}

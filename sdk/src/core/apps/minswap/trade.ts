// Agent side: build (never sign) a Minswap swap from the allowance (vault `AgentTrade` +
// the Minswap adapter's withdraw-zero). Everything that leaves the allowance (swap amount,
// batcher fee, Minswap's deposit, the cancel tip, the tx fee) counts against the caps;
// what comes back from Minswap goes to the vault's treasury.
import { Data, type Assets, type UTxO } from "@lucid-evolution/lucid";
import { add, fmt, sub } from "../../assets.js";
import { computeNext, feeRoom, makeIntent, validity, type BuiltSpend, type SpendRequest } from "../../agent.js";
import { estimateMinFee } from "../../chain.js";
import { allowanceToData, spendRedeemer } from "../../data.js";
import { toPlutusAddress } from "../../address.js";
import { assertAgentShape } from "../../guards.js";
import { INTENT_LABEL, intentHash, intentMetadata } from "../../intent.js";
import { LimitError } from "../../limits.js";
import { appFor } from "../catalogue.js";
import { minswapAdapter } from "./adapter.js";
import { orderDatumToData, poolDatumFromData, type MinswapOrder, type MinswapPool } from "./data.js";
import { amountOut, minimumFor } from "./quote.js";
import { minswapSettings, tradeProblems } from "./rules.js";

/** What Minswap's batchers expect to hold back for the order output, returned with the proceeds. */
export const ORDER_DEPOSIT = 2_000_000n;
const POOL_AUTH = "4d5350";

export type TradeRequest = Omit<SpendRequest, "payments"> & {
  /** The pool's LP asset name (hex), from the vault's allowed pools. */
  pool: string;
  amountIn: bigint;
  /** True: sell the pool's asset A (ADA for ADA pools) for asset B. */
  aToB: boolean;
  /** The adapter's published reference script; attached inline if absent. */
  adapterRef?: UTxO;
  /** Adversarial tests only (with skipPreflight): change the order to prove the chain refuses it. */
  tamper?: (o: MinswapOrder) => MinswapOrder;
};

export type BuiltTrade = BuiltSpend & { order: MinswapOrder; orderValue: Assets; fair: bigint };

/** The live pool for an LP asset: the UTxO at Minswap's pool address holding the pool token and that LP. */
export async function findPool(req: Pick<TradeRequest, "lucid">, lpName: string): Promise<{ utxo: UTxO; pool: MinswapPool }> {
  const found = appFor("minswap", req.lucid.config().network!);
  if (!found) throw new Error("Minswap isn't deployed on this network");
  const { lpPolicy } = found.network.deployment;
  const utxo = (await req.lucid.utxosAtWithUnit(found.network.poolAddress, lpPolicy + lpName)).find((u) => u.assets[lpPolicy + POOL_AUTH] === 1n && u.datum);
  if (!utxo) throw new LimitError("APP", "that pool doesn't exist on Minswap");
  return { utxo, pool: poolDatumFromData(utxo.datum!) };
}

export async function buildAgentTrade(req: TradeRequest): Promise<BuiltTrade> {
  const { lucid, vault, allowance, config, collateral } = req;
  const network = lucid.config().network!;
  const found = appFor("minswap", network);
  if (!found) throw new LimitError("APP", `Minswap isn't available on ${network}`);
  const adapter = minswapAdapter(network);
  const settings = minswapSettings(config.config, adapter.hash);
  if (!settings) throw new LimitError("APP", "Minswap isn't enabled on this vault (the owners can enable it under Apps)");
  const app = config.config.apps.find((a) => a.adapter === adapter.hash)!;
  if (!allowance.datum.apps.includes(app.name)) throw new LimitError("APP", "this agent isn't allowed to use Minswap (the owners can allow it in its budget)");
  if (!settings.pools.includes(req.pool)) throw new LimitError("APP", "that pool isn't one the vault allows");
  if (req.amountIn <= 0n) throw new LimitError("APP", "the swap amount must be positive");

  const { utxo: poolUtxo, pool } = await findPool(req, req.pool);
  const v = validity(req);
  const [assetIn, rIn, rOut, feeNum] = req.aToB ? [pool.assetA, pool.reserveA, pool.reserveB, pool.feeA] : [pool.assetB, pool.reserveB, pool.reserveA, pool.feeB];
  const fair = amountOut(rIn, rOut, req.amountIn, feeNum);
  const vaultHome = toPlutusAddress(vault.address);
  const honest: MinswapOrder = {
    adapter: adapter.hash,
    receiver: vaultHome,
    lp: { policy: found.network.deployment.lpPolicy, name: req.pool },
    aToB: req.aToB,
    amount: req.amountIn,
    minimumReceive: minimumFor(fair, settings.maxSlippageBps),
    maxBatcherFee: settings.maxBatcherFee,
    // The script sees the tx's exclusive upper bound (v.upper + 1).
    expiry: v.upper + 1n + settings.maxOrderTtlMs,
    tip: settings.maxCancelTip,
  };
  const order = req.tamper ? req.tamper(honest) : honest;
  const unitIn = assetIn.policy === "" ? "lovelace" : assetIn.policy + assetIn.name;
  const lovelace = order.maxBatcherFee + ORDER_DEPOSIT + order.tip + (unitIn === "lovelace" ? req.amountIn : 0n);
  const orderValue: Assets = unitIn === "lovelace" ? { lovelace } : { lovelace, [unitIn]: req.amountIn };
  const problems = tradeProblems({
    config: config.config, allowance: allowance.datum, adapter: adapter.hash, lpPolicy: found.network.deployment.lpPolicy,
    vault: vaultHome, upper: v.upper + 1n, order, pool, orderValue,
  });
  if (problems.length && !req.skipPreflight) throw new LimitError("APP", problems.join("; "));

  const intent = makeIntent(req, "agent_trade", [{ to: found.network.orderAddress, assets: orderValue }]);
  intent.trade = { app: "minswap", pool: req.pool, amount_in: req.amountIn.toString(), minimum_receive: order.minimumReceive.toString() };
  const refs = [config.utxo, poolUtxo, ...(req.refScript ? [req.refScript] : []), ...(req.adapterRef ? [req.adapterRef] : [])];

  const buildOnce = async (fee: bigint) => {
    const delta = add(orderValue, { lovelace: fee });
    const next = computeNext(req, delta, fee, v.lower, v.upper, []);
    let b = lucid
      .newTx()
      .collectFrom([allowance.utxo], spendRedeemer({ kind: "AgentTrade", intentHash: intentHash(intent) }))
      .readFrom(refs)
      .withdraw(adapter.rewardAddress, 0n, Data.void())
      .pay.ToContract(found.network.orderAddress, { kind: "inline", value: orderDatumToData(order) }, orderValue)
      .pay.ToContract(vault.address, { kind: "inline", value: allowanceToData(next) }, sub(allowance.utxo.assets, delta))
      .addSignerKey(allowance.datum.agent)
      .validFrom(v.lowerMs)
      .validTo(v.ttlMs)
      .attachMetadata(INTENT_LABEL, intentMetadata(intent));
    if (!req.refScript) b = b.attach.SpendingValidator(vault.script);
    if (!req.adapterRef) b = b.attach.WithdrawalValidator(adapter.script);
    const tx = await b.complete({ coinSelection: false, presetWalletInputs: [collateral], includeLeftoverLovelaceAsFee: true, setCollateral: (fee * 3n) / 2n + 1n });
    return { tx, next };
  };

  // Two passes, as for payments: measure, then rebuild with the ledger minimum + margin,
  // never probing with a fee the caps can't hold.
  const room = req.skipPreflight ? undefined : feeRoom(req, [], v, orderValue);
  let probeFee = room === undefined ? 600_000n : room.fee < 600_000n ? room.fee : 600_000n;
  let probe: Awaited<ReturnType<typeof buildOnce>> | undefined;
  for (let i = 0; i < 4 && !probe; i++) {
    try {
      probe = await buildOnce(probeFee);
    } catch (e) {
      if (e instanceof LimitError) throw e;
      // A script refused it: a bigger fee won't help, and retrying would bury the real reason.
      if (/failed script execution/.test(String((e as Error)?.message ?? e))) throw e;
      if (room && probeFee >= room.fee) throw new LimitError(room.code, `no room for the fee: at most ${room.fee} lovelace fits under the ${room.code} limit`);
      if (i === 3) throw e;
      probeFee = room === undefined ? probeFee * 2n : (probeFee * 2n < room.fee ? probeFee * 2n : room.fee);
    }
  }
  const refBytes = (req.refScript ? vault.script.script.length / 2 : 0) + (req.adapterRef ? adapter.script.script.length / 2 : 0);
  let fee = (estimateMinFee(lucid, probe!.tx, 1, refBytes) * 103n) / 100n + 2_000n;
  if (!req.skipPreflight && fee > allowance.datum.maxFee) throw new LimitError("FEE", `required fee ${fee} > max_fee ${allowance.datum.maxFee}`);
  let built = await buildOnce(fee);
  const min = estimateMinFee(lucid, built.tx, 1, refBytes);
  if (min > fee) {
    fee = (min * 103n) / 100n + 2_000n;
    built = await buildOnce(fee);
  }
  assertAgentShape(built.tx, allowance.utxo, collateral, { outputs: 2, fee, withdrawal: adapter.rewardAddress });
  void fmt;
  return { tx: built.tx, fee, next: built.next, intent, validity: { lower: v.lower, upper: v.upper }, order, orderValue, fair };
}

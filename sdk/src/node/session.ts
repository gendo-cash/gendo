// The paying agent's whole surface: check its budget, pay within it, ask the
// owners for more. Shared by the MCP server and the demo LLM agent. Nothing here
// holds a key or runs an owner operation: payments are signed by the signer
// daemon, and over-limit payments go to the owners as unsigned files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialToAddress, type Assets, type LucidEvolution, type Network, type UTxO } from "@lucid-evolution/lucid";
import { buildOverLimitSpend } from "../core/agent.js";
import { fromPlutusAddress } from "../core/address.js";
import { readAllowance, readConfig } from "../core/chain.js";
import { describeTx } from "../core/cosign.js";
import { AlreadyPaid, assertNotPaid, blockfrostQuery, txFacts, txFate, type ChainQuery, type IntentJournal } from "../core/idempotency.js";
import { FileJournal } from "./journal.js";
import { INTENT_LABEL } from "../core/intent.js";
import { floorDiv, unitOf } from "../core/limits.js";
import { offlineTtlMs } from "../core/owner.js";
import { payOnce } from "../core/pay.js";
import { connect, providerFromEnv } from "../core/provider.js";
import { requestWitness } from "./signer/client.js";
import { makeVault, type Vault } from "../core/vault.js";
import { appFor } from "../core/apps/catalogue.js";
import { minswapAdapter } from "../core/apps/minswap/adapter.js";
import { orderDatumFromData } from "../core/apps/minswap/data.js";
import { minswapSettings } from "../core/apps/minswap/rules.js";
import { orderStatus } from "../core/apps/minswap/status.js";
import { tradeOnce } from "../core/trade.js";
import { hexToUtf8 } from "../core/bytes.js";

export type AgentSession = {
  lucid: LucidEvolution;
  vault: Vault;
  /** The allowance this agent pays from. */
  unit: string;
  home: string;
  q: ChainQuery;
  journal: IntentJournal;
  sign: (txCbor: string) => Promise<string>;
  refScript?: { txHash: string; outputIndex: number };
};

/** A session from parts already in hand (gendo-agent: chain through the server, an in-process signer). */
export function sessionFromParts(p: Omit<AgentSession, "journal">): AgentSession {
  return { ...p, journal: new FileJournal(join(p.home, "intents.jsonl")) };
}

/** `home` is a VAULT_HOME joined to the vault (`vault join <id>`); it holds no key. */
export async function openSession(opts: { home: string; unit: string; signerSocket: string }): Promise<AgentSession> {
  const statePath = join(opts.home, "state.json");
  if (!existsSync(statePath)) throw new Error(`${statePath} not found: run \`vault join <id>\` with VAULT_HOME=${opts.home}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const cfg = providerFromEnv();
  const lucid = await connect(cfg);
  if (state.network !== lucid.config().network) throw new Error(`vault is on ${state.network}, VAULT_NETWORK is ${lucid.config().network}`);
  return sessionFromParts({
    lucid,
    vault: makeVault(lucid.config().network!, state.seed),
    unit: opts.unit,
    home: opts.home,
    q: blockfrostQuery(cfg.blockfrostUrl, cfg.blockfrostProjectId),
    sign: (cbor) => requestWitness(opts.signerSocket, cbor),
    refScript: state.refScript,
  });
}

const ada = (lovelace: bigint) => Number(lovelace) / 1e6;
/** Amounts an LLM reads easily: ADA for lovelace, raw quantity for tokens. */
const human = (unit: string, q: bigint) => (unit === "lovelace" ? { asset: "ADA", amount: ada(q) } : { asset: unit, amount: Number(q) });

/** The agent's key address must hold a pure-ADA UTxO: the ledger takes collateral only from a key address. */
async function agentWallet(s: AgentSession, agentPkh: string) {
  const addr = credentialToAddress(s.lucid.config().network!, { type: "Key", hash: agentPkh });
  const collateral = (await s.lucid.utxosAt(addr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef);
  if (!collateral) throw Object.assign(new Error(`agent address ${addr} needs a pure-ADA UTxO for collateral (a few tADA)`), { code: "NO_COLLATERAL" });
  s.lucid.selectWallet.fromAddress(addr, [collateral]);
  const [ref] = s.refScript ? await s.lucid.utxosByOutRef([s.refScript]) : [];
  return { collateral, refScript: ref?.scriptRef ? (ref as UTxO) : undefined };
}

/** What the agent may spend right now, and the rules it spends under. */
export async function budget(s: AgentSession) {
  const [al, cfg, tip] = await Promise.all([readAllowance(s.lucid, s.vault, s.unit), readConfig(s.lucid, s.vault), s.q.tipMs()]);
  const d = al.datum;
  const now = BigInt(tip ?? Date.now());
  const started = now >= d.windowStart;
  const k = started ? floorDiv(now - d.windowStart, d.periodMs) : 0n;
  const windowStart = d.windowStart + k * d.periodMs;
  const network = s.lucid.config().network as Network;
  return {
    paused: cfg.config.paused,
    expires_at: new Date(Number(d.expiresAt)).toISOString(),
    period_resets_at: new Date(Number(windowStart + d.periodMs)).toISOString(),
    max_fee_ada: ada(d.maxFee),
    limits: d.caps.map((c, i) => {
      const unit = unitOf(c.policy, c.name);
      const spent = k === 0n ? d.spent[i]! : 0n;
      const left = c.windowCap - spent;
      return {
        asset: human(unit, 0n).asset,
        per_payment: human(unit, c.txCap).amount,
        per_period: human(unit, c.windowCap).amount,
        spent_this_period: human(unit, spent).amount,
        left_this_period: human(unit, left).amount,
        largest_payment_now: human(unit, left < c.txCap ? left : c.txCap).amount,
      };
    }),
    approved_payees: d.destinations.map((a) => fromPlutusAddress(network, a)),
    apps: appsOf(network, d.apps, cfg.config),
    held_in_allowance: Object.fromEntries(Object.entries(al.utxo.assets).map(([u, q]) => [u === "lovelace" ? "ADA" : u, human(u, q).amount])),
    note: "The fee counts toward the ADA limits. Payments over a limit need the owners: use request_approval. A swap counts its amount plus Minswap's deposit, batcher fee and cancel tip; what comes back goes to the vault's treasury, not to this budget.",
  };
}

/** The apps this agent may trade with right now (granted, enabled on the vault, deployed here), with the vault's rules. */
function appsOf(network: Network, granted: string[], config: Parameters<typeof minswapSettings>[0]) {
  return granted.flatMap((name) => {
    const found = name === "minswap" ? appFor(name, network) : undefined;
    const s = found ? minswapSettings(config, minswapAdapter(network).hash) : undefined;
    if (!found || !s) return [];
    return [{
      app: name,
      title: found.app.title,
      pools: s.pools.map((lp) => found.network.pools.find((p) => p.lpName === lp)?.label ?? lp),
      max_slippage_pct: Number(s.maxSlippageBps) / 100,
      max_batcher_fee_ada: ada(s.maxBatcherFee),
      max_order_lifetime_minutes: Number(s.maxOrderTtlMs) / 60_000,
      cancel_tip_ada: ada(s.maxCancelTip),
    }];
  });
}

/** What to do about each refusal, phrased for an agent. */
export const NEXT_STEP: Record<string, string> = {
  TX_CAP: "Over the per-payment limit. Call request_approval with the same intent_id; don't split it into smaller payments.",
  WINDOW_CAP: "Over this period's budget. Wait for period_resets_at (see get_budget), or call request_approval.",
  DESTINATION: "Payee is not approved. Do not retry. Report it; only the owners can approve a payee.",
  PAUSED: "The owners paused all spending. Stop and report it.",
  TIME: "Too close to a period boundary or the expiry. Retry after the boundary, or report an expiring allowance.",
  EXPIRED: "The allowance has expired. Stop and report it.",
  FEE: "The fee is above the allowed max. Report it; don't raise fees.",
  UNCAPPED_ASSET: "That asset isn't in the allowance. Report it.",
  NO_COLLATERAL: "The agent's own address needs a few tADA for collateral. Report it to the operator.",
  SIGNER_REFUSED: "The signer refused it: its own rate or daily limit, its payee list, or a different tx for an intent it already signed. Report the reason; don't retry with a new intent_id.",
  SCRIPT_OR_LEDGER: "Rejected by the chain. Report it with the reason; don't retry blindly.",
  APP: "Not allowed by the vault's app rules (app not enabled or not allowed for you, or a pool the owners didn't approve). Report it; only the owners can change them.",
};

const toAssets = (amount_ada?: number, asset?: { unit: string; quantity: number }): Assets => {
  if (asset) return { [asset.unit]: BigInt(asset.quantity), ...(amount_ada ? { lovelace: BigInt(Math.round(amount_ada * 1e6)) } : {}) };
  if (amount_ada === undefined || !(amount_ada > 0)) throw new Error("amount_ada must be positive");
  return { lovelace: BigInt(Math.round(amount_ada * 1e6)) };
};

export type PaymentRequest = { to: string; amount_ada?: number; asset?: { unit: string; quantity: number }; intent_id: string; purpose: string };

/** Pay once per intent id. Never throws for a refusal: returns it with the next step. */
export async function pay(s: AgentSession, p: PaymentRequest) {
  try {
    const w = await agentWallet(s, (await readAllowance(s.lucid, s.vault, s.unit)).datum.agent);
    const r = await payOnce(
      {
        lucid: s.lucid,
        vault: s.vault,
        allowanceUnit: s.unit,
        collateral: w.collateral,
        refScript: w.refScript,
        payments: [{ to: p.to, assets: toAssets(p.amount_ada, p.asset) }],
        intentId: p.intent_id,
        purpose: p.purpose,
        ref: p.intent_id,
      },
      { q: s.q, journal: s.journal, sign: s.sign },
    );
    return r.status === "paid"
      ? { status: "paid" as const, tx: r.txHash, fee_ada: ada(r.built.fee) }
      : { status: "already_paid" as const, tx: r.txHash, note: "This intent_id was paid before; nothing new was sent." };
  } catch (e) {
    const err = e as Error & { code?: string };
    const code = err.code ?? (err.message.startsWith("signer refused:") ? "SIGNER_REFUSED" : "SCRIPT_OR_LEDGER");
    return {
      status: "blocked" as const,
      code,
      reason: err.message.split("\n")[0]?.slice(0, 300),
      next_step: NEXT_STEP[code] ?? NEXT_STEP.SCRIPT_OR_LEDGER,
    };
  }
}

/**
 * Prepare an over-limit payment for the owners. Writes an unsigned tx to
 * `<home>/approvals/<intent_id>.cbor` that owners check (`vault tx describe`) and
 * sign on their own machines; the agent operator adds the agent's witness.
 */
export async function requestApproval(s: AgentSession, p: PaymentRequest & { reason: string }) {
  try {
    const current = await readAllowance(s.lucid, s.vault, s.unit);
    await assertNotPaid(s.q, s.journal, s.unit, current.utxo.txHash, p.intent_id, INTENT_LABEL);
    const config = await readConfig(s.lucid, s.vault);
    const dir = join(s.home, "approvals");
    const file = join(dir, `${p.intent_id.replace(/[^\w.-]/g, "_")}.cbor`);
    // A request built earlier that can still land is sent again unchanged: the signer re-signs
    // the same body, while a new body for the same intent would wait for the old one's TTL.
    let cbor: string | undefined;
    if (existsSync(file)) {
      const old = readFileSync(file, "utf8").trim();
      if ((await txFate(s.q, txFacts(s.lucid, old), (await s.q.tipMs()) ?? Date.now(), 0)) === "unknown") cbor = old;
    }
    if (!cbor) {
      const w = await agentWallet(s, current.datum.agent);
      const built = await buildOverLimitSpend({
        lucid: s.lucid,
        vault: s.vault,
        allowance: current,
        config,
        collateral: w.collateral,
        refScript: w.refScript,
        tipMs: await s.q.tipMs(),
        payments: [{ to: p.to, assets: toAssets(p.amount_ada, p.asset) }],
        intentId: p.intent_id,
        purpose: `${p.purpose} (owner approval: ${p.reason.slice(0, 80)})`,
        cosigners: config.config.owners.slice(0, Number(config.config.threshold)),
        // Owners sign on their own machines: give them hours, not the agent's minutes.
        validityMs: Number(process.env.VAULT_TX_TTL_MS ?? offlineTtlMs(s.lucid.config().network!)),
      });
      cbor = built.tx.toCBOR();
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, cbor);
    }
    const ttlSlot = describeTx(cbor).validity.ttlSlot;
    const expires_at = ttlSlot ? new Date(s.lucid.slotToUnixTime(Number(ttlSlot))).toISOString() : undefined;
    const server = process.env.GENDO_SERVER;
    const token = process.env.GENDO_AGENT_TOKEN;
    if (server && token) {
      const res = await fetch(`${server.replace(/\/$/, "")}/requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ cbor, agentWitness: await s.sign(cbor), intentId: p.intent_id, purpose: p.purpose, reason: p.reason }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) return { status: "blocked" as const, code: "SERVER", reason: body.error ?? `server answered ${res.status}` };
      return {
        status: "awaiting_owners" as const,
        request_id: body.id,
        expires_at,
        note: "The owners see it in their inbox. Any other payment from this allowance before they sign makes it stale; if it goes dead, call request_approval again with the same intent_id.",
      };
    }
    return {
      status: "awaiting_owners" as const,
      file,
      expires_at,
      note: "Hand this file to the owners. Any other payment from this allowance before they submit it makes it stale; if they report it dead, call request_approval again with the same intent_id.",
    };
  } catch (e) {
    if (e instanceof AlreadyPaid) return { status: "already_paid" as const, tx: e.txHash };
    const err = e as Error & { code?: string };
    return { status: "blocked" as const, code: err.code ?? "ERROR", reason: err.message.split("\n")[0]?.slice(0, 300) };
  }
}

export type SwapRequest = { app: string; pool: string; amount_ada?: number; asset?: { unit: string; quantity: number }; intent_id: string; purpose: string };

/** Place one swap per intent id through an enabled, granted app. Never throws for a refusal. */
export async function swap(s: AgentSession, p: SwapRequest) {
  try {
    const network = s.lucid.config().network as Network;
    if (p.app !== "minswap") throw Object.assign(new Error(`unknown app ${p.app}`), { code: "APP" });
    const found = appFor("minswap", network);
    if (!found) throw Object.assign(new Error(`Minswap isn't available on ${network}`), { code: "APP" });
    const pool = found.network.pools.find((x) => x.label === p.pool || x.lpName === p.pool);
    if (!pool) throw Object.assign(new Error(`unknown pool ${p.pool}; use one from get_budget`), { code: "APP" });
    // Selling ADA (amount_ada) or the pool's other asset (asset).
    const sellingAda = !p.asset;
    const amountIn = sellingAda ? BigInt(Math.round((p.amount_ada ?? 0) * 1e6)) : BigInt(p.asset!.quantity);
    const aToB = sellingAda ? pool.assetA === "lovelace" : pool.assetA === p.asset!.unit;
    const al = await readAllowance(s.lucid, s.vault, s.unit);
    const w = await agentWallet(s, al.datum.agent);
    const [adapterRef] = found.network.adapterRef ? await s.lucid.utxosByOutRef([found.network.adapterRef]) : [];
    const r = await tradeOnce(
      {
        lucid: s.lucid, vault: s.vault, allowanceUnit: s.unit, collateral: w.collateral, refScript: w.refScript, adapterRef: adapterRef?.scriptRef ? adapterRef : undefined,
        pool: pool.lpName, amountIn, aToB, intentId: p.intent_id, purpose: p.purpose, ref: p.intent_id,
      },
      { q: s.q, journal: s.journal, sign: s.sign },
    );
    if (r.status === "already-traded") return { status: "already_placed" as const, tx: r.txHash, note: "This intent_id was traded before; nothing new was sent." };
    const out = aToB ? pool.assetB : pool.assetA;
    return {
      status: "placed" as const,
      tx: r.txHash,
      selling: human(sellingAda ? "lovelace" : p.asset!.unit, amountIn),
      minimum_receive: human(out, r.built.order.minimumReceive),
      expires_at: new Date(Number(r.built.order.expiry)).toISOString(),
      fee_ada: ada(r.built.fee),
      note: "Minswap's batchers fill it (on preprod, sometimes hours later). Proceeds go to the vault's treasury, which only the owners spend; if it isn't filled by expires_at, it can be refunded to the vault. Check it with order_status.",
    };
  } catch (e) {
    const err = e as Error & { code?: string };
    const code = err.code ?? (err.message.startsWith("signer refused:") ? "SIGNER_REFUSED" : "SCRIPT_OR_LEDGER");
    return { status: "blocked" as const, code, reason: err.message.split("\n")[0]?.slice(0, 300), next_step: NEXT_STEP[code] ?? NEXT_STEP.SCRIPT_OR_LEDGER };
  }
}

/** Where a swap stands: pending, filled (and what arrived at the vault) or refunded. */
export async function orderStatusOf(s: AgentSession, tx: string) {
  const network = s.lucid.config().network as Network;
  const found = appFor("minswap", network);
  const get = s.q.getJson?.bind(s.q);
  if (!found || !get) return { status: "unknown" as const, note: "This connection can't read order history." };
  const placed = (await get(`/txs/${tx}/utxos`)) as { outputs?: { address: string; inline_datum?: string | null }[] } | undefined;
  const o = placed?.outputs?.find((x) => x.address === found.network.orderAddress);
  const order = o?.inline_datum ? orderDatumFromData(o.inline_datum) : null;
  const pool = order ? found.network.pools.find((p) => p.lpName === order.lp.name) : undefined;
  if (!order || !pool) return { status: "unknown" as const, note: "That isn't one of this vault's Minswap orders." };
  const [inUnit, outUnit] = order.aToB ? [pool.assetA, pool.assetB] : [pool.assetB, pool.assetA];
  const st = await orderStatus(get, { orderTx: tx, orderAddress: found.network.orderAddress, vaultAddress: s.vault.address, inUnit, outUnit, minimumReceive: order.minimumReceive });
  if (st.status === "filled" || st.status === "refunded")
    return { status: st.status, tx: st.tx, received_by_vault: Object.fromEntries(Object.entries(st.received).map(([u, q]) => [u === "lovelace" ? "ADA" : u, human(u, q).amount])) };
  return st;
}
void hexToUtf8;

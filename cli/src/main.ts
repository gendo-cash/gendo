// vault: CLI for gendo, budgeted on-chain accounts for AI agents. Every flow of the SDK is a command.
//
// State lives in $VAULT_HOME (default ./.vault): state.json (vault seed, ref
// script) and keys/<name>.sk (0600; local test keys only, never custody).
// Network via env: VAULT_NETWORK=Preprod (default, needs BLOCKFROST_PROJECT_ID)
// or VAULT_NETWORK=Custom for a local devnet (scripts/devnet.sh).
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CML,
  agent,
  awaitSettled,
  AlreadyPaid,
  FileJournal,
  INTENT_LABEL,
  NeverLands,
  assertNotPaid,
  blockfrostQuery,
  txFacts,
  liveness as coreLiveness,
  payOnce,
  tradeOnce,
  appFor,
  minswap,
  submitResolving,
  connect,
  cosign,
  credentialToAddress,
  fromPlutusAddress,
  generatePrivateKey,
  listAllowances,
  makeVault,
  formatVaultId,
  parseVaultId as coreParseVaultId,
  type VaultId,
  owner,
  providerFromEnv,
  readAllowance,
  readConfig,
  requestWitness,
  startSigner,
  treasuryUtxos,
  refHolderAddress,
  type Assets,
  type LucidEvolution,
  type TxSignBuilder,
  type Vault,
} from "./sdk.js";

const HOME = resolve(process.env.VAULT_HOME ?? ".vault");
/** TTL for owner and over-limit txs; set in main() from --ttl, VAULT_TX_TTL_MS, or the defaults. */
let txTtlMs = 0;
const KEYS = join(HOME, "keys");
const STATE = join(HOME, "state.json");
const ADA = 1_000_000n;

type State = { network: string; seed: { txHash: string; outputIndex: number }; refScript?: { txHash: string; outputIndex: number } };

// --- helpers ---------------------------------------------------------------

const die = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const out = (x: unknown) =>
  console.log(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

function keyPath(name: string) {
  return join(KEYS, `${name}.sk`);
}
function loadKey(name: string) {
  if (!existsSync(keyPath(name))) die(`no key named ${name} (vault keys gen ${name})`);
  const privateKey = readFileSync(keyPath(name), "utf8").trim();
  const pkh = CML.PrivateKey.from_bech32(privateKey).to_public().hash().to_hex();
  return { name, privateKey, pkh };
}
function addressOf(lucid: LucidEvolution, pkh: string) {
  return credentialToAddress(lucid.config().network!, { type: "Key", hash: pkh });
}
/** A party given as a key name, or a raw 56-hex key hash. */
function pkhOf(x: string) {
  return /^[0-9a-f]{56}$/.test(x) ? x : loadKey(x).pkh;
}
function loadState(): State {
  if (!existsSync(STATE)) die(`no vault yet (vault vault create ...); state file ${STATE}`);
  return JSON.parse(readFileSync(STATE, "utf8"));
}
/** Chain queries for fate checks, and the operator-wide intent journal. */
function chainQuery() {
  const cfg = providerFromEnv();
  return blockfrostQuery(cfg.blockfrostUrl, cfg.blockfrostProjectId);
}
const journal = () => new FileJournal(join(HOME, "intents.jsonl"));

/**
 * Submit with a fate check: if the node says the inputs are already spent,
 * decide whether THIS tx landed (success) or can never land (NeverLands ->
 * main() rebuilds). Never blindly rebuild: that is how double payments happen.
 */
async function submitSafely(lucid: LucidEvolution, signedCbor: string, intent?: { id: string; allowance: string }) {
  const j = intent ? journal() : undefined;
  const hash = await submitResolving(lucid, chainQuery(), signedCbor, { journal: j, intentId: intent?.id, allowance: intent?.allowance });
  await awaitSettled(lucid, signedCbor);
  if (j && intent) {
    const e = j.get(intent.id);
    if (e) j.put({ ...e, status: "landed", at: new Date().toISOString() });
  }
  return hash;
}

/**
 * One line that identifies a vault, for owners and operators to share instead
 * of copying state.json: `gendo:<network>:<seed tx>#<i>[:<ref-script tx>#<i>]`.
 */
const vaultId = (s: State) => formatVaultId(s as VaultId);
function parseVaultId(id: string): State {
  try {
    return coreParseVaultId(id);
  } catch (e) {
    return die((e as Error).message);
  }
}

function vaultOf(lucid: LucidEvolution): Vault {
  const s = loadState();
  if (s.network !== lucid.config().network) die(`state is for ${s.network}, connected to ${lucid.config().network} (edge I5)`);
  return makeVault(lucid.config().network!, s.seed);
}
/** describeTx with each spent input's address looked up, so only the vault's own redeemers are named. */
async function describe(lucid: LucidEvolution, cbor: string) {
  const refs = cosign.describeTx(cbor).inputs.map((r) => {
    const [txHash, i] = r.split("#");
    return { txHash: txHash!, outputIndex: Number(i) };
  });
  const utxos = refs.length ? await lucid.utxosByOutRef(refs) : [];
  const inputAddresses = Object.fromEntries(utxos.map((u) => [`${u.txHash}#${u.outputIndex}`, u.address]));
  return cosign.describeTx(cbor, { vault: vaultOf(lucid), inputAddresses });
}

/** When an unsigned tx stops being submittable: signers must finish before this. */
const expiresAt = (lucid: LucidEvolution, ttlSlot?: string) =>
  ttlSlot === undefined ? undefined : new Date(lucid.slotToUnixTime(Number(ttlSlot))).toISOString();

/**
 * Can this tx still land? Checked before anyone spends a signature on it. An
 * escalation is built on the allowance's current UTxO, so any other payment
 * the agent makes from that allowance before submission kills it.
 */
async function liveness(lucid: LucidEvolution, cbor: string) {
  const facts = txFacts(lucid, cbor);
  const isUnspent = async (txHash: string, index: number) => {
    // Providers without a spender index: an input missing from its address's unspent set is gone.
    // (A lookup by reference returns the output even after it was spent.)
    const [o] = await lucid.utxosByOutRef([{ txHash, outputIndex: index }]);
    if (!o) return undefined;
    return (await lucid.utxosAt(o.address)).some((u) => u.txHash === txHash && u.outputIndex === index);
  };
  const l = await coreLiveness(chainQuery(), facts, Date.now(), isUnspent);
  if (l.state === "landed") return { state: "landed" as const, reason: `already on-chain as ${l.hash}` };
  if (l.state === "dead")
    return {
      state: "dead" as const,
      reason: l.reason.startsWith("it expired")
        ? `${l.reason}. Build it again with a longer --ttl`
        : `${l.reason} (for an escalation: the agent made another payment). Ask whoever built it to build it again, then sign the new file`,
    };
  return { state: "submittable" as const, expiresAt: new Date(l.expiresAtMs).toISOString() };
}

/** Refuse to sign or submit a tx that can't land, with the reason. */
async function requireLive(lucid: LucidEvolution, cbor: string) {
  const l = await liveness(lucid, cbor);
  if (l.state !== "submittable") die(`not signing: this tx is ${l.state}: ${l.reason}`);
}

async function refScriptOf(lucid: LucidEvolution) {
  const s = loadState();
  if (!s.refScript) return undefined;
  const [u] = await lucid.utxosByOutRef([s.refScript]);
  // Fall back to an inline script if the reference UTxO is missing (edge I3).
  return u?.scriptRef ? u : undefined;
}
const list = (x?: string) => (x ? x.split(",").map((s) => s.trim()).filter(Boolean) : []);
const ada = (x?: string) => (x === undefined ? undefined : BigInt(Math.round(Number(x) * 1e6)));
const duration = (x: string): bigint => {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(x);
  if (!m) return die(`bad duration ${x}`);
  const mult = { ms: 1n, s: 1000n, m: 60_000n, h: 3_600_000n, d: 86_400_000n }[(m[2] ?? "ms") as "ms"];
  return BigInt(m[1]!) * mult;
};
/** "lovelace:WINDOW:TX" (ADA amounts) or "<policy><name>:WINDOW:TX" (raw units). */
function parseCap(spec: string) {
  const [unit, w, t] = spec.split(":");
  if (!unit || !w || !t) return die(`bad cap ${spec}`);
  if (unit === "lovelace" || unit === "ada") return { policy: "", name: "", windowCap: ada(w)!, txCap: ada(t)! };
  return { policy: unit.slice(0, 56), name: unit.slice(56), windowCap: BigInt(w), txCap: BigInt(t) };
}
/** "--ada 5" plus optional "--asset unit:qty,...". */
function assetsOf(v: { ada?: string; asset?: string }): Assets {
  const a: Assets = {};
  if (v.ada) a.lovelace = ada(v.ada)!;
  for (const s of list(v.asset)) {
    const [u, q] = s.split(":");
    a[u!] = BigInt(q!);
  }
  return a;
}

/**
 * Finish a multi-party tx: either sign locally with each named key and submit,
 * or write the unsigned CBOR for offline witnessing (`vault tx witness`).
 */
async function finishTx(lucid: LucidEvolution, tx: TxSignBuilder, v: { sign?: string; out?: string; propose?: string }) {
  const cbor = tx.toCBOR();
  if (v.out) {
    writeFileSync(v.out, cbor);
    const summary = await describe(lucid, cbor);
    out({ unsigned: v.out, hash: tx.toHash(), expiresAt: expiresAt(lucid, summary.validity.ttlSlot), witnessesNeeded: "every required signer, plus the proposer", summary });
    return;
  }
  // The proposer's wallet paid the fee, so their witness is always needed.
  const signers = [...new Set([...list(v.sign), ...(v.propose ? [v.propose] : [])])];
  if (!list(v.sign).length) die("pass --sign k1,k2 to sign locally, or --out file.cbor for offline signing");
  const ws = await Promise.all(signers.map((n) => cosign.witness(lucid, cbor, loadKey(n).privateKey)));
  const signed = await cosign.assemble(lucid, cbor, ws);
  const hash = await submitSafely(lucid, signed.toCBOR());
  out({ submitted: hash });
  return hash;
}

/** "--apps minswap,..." or "none". */
const appsArg = (x?: string) => (x === undefined || x === "none" ? [] : list(x));

/** Minswap settings from flags. Every one is required: owners choose each value (no defaults). */
function minswapSettingsArg(lucid: LucidEvolution, v: { pools?: string; slippage?: string; fee?: string; ttl?: string; tip?: string }): minswap.MinswapSettings {
  const found = appFor("minswap", lucid.config().network!) ?? die(`Minswap isn't available on ${lucid.config().network}`);
  const given = v.pools ?? die("--pools any|<lp name or label,...> required");
  // "any": any genuine Minswap pool (a hijacked agent could then lose its budget to a rigged pool).
  const pools = given === "any" ? ("any" as const) : list(given).map(
    (p) => found!.network.pools.find((x) => x.label === p || x.lpName === p)?.lpName ?? (/^[0-9a-f]{2,64}$/.test(p) ? p : die(`unknown pool ${p}`)),
  );
  return {
    pools,
    maxSlippageBps: BigInt(Math.round(Number(v.slippage ?? die("--slippage <percent> required")) * 100)),
    maxBatcherFee: ada(v.fee ?? die("--fee <ada> required (max batcher fee)"))!,
    maxOrderTtlMs: duration(v.ttl ?? die("--ttl <duration> required (max order lifetime)")),
    maxCancelTip: ada(v.tip ?? die("--tip <ada> required (max cancel tip)"))!,
  };
}

async function appChange(argv: string[], kind: "enable" | "update") {
  // `--ttl` is taken by the tx TTL (main), so the order lifetime is `--order-ttl`; `--ttl` before it is the tx's.
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: appFlags });
  if ((positionals[0] ?? "minswap") !== "minswap") die("only minswap is available");
  const lucid = await connect(providerFromEnv());
  const vault = vaultOf(lucid);
  lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
  const settings = minswapSettingsArg(lucid, { ...v, ttl: v["order-ttl"] });
  const app = minswap.minswapAppConfig(lucid.config().network!, settings);
  const cfg = await readConfig(lucid, vault);
  const signers = list(v.sign ?? v.signers).map(pkhOf);
  const tx = kind === "enable" ? await owner.enableApp(lucid, vault, cfg, app, signers) : await owner.updateApp(lucid, vault, cfg, app, signers);
  await finishTx(lucid, tx, v);
}

const appFlags = {
  pools: { type: "string" as const },
  slippage: { type: "string" as const },
  fee: { type: "string" as const },
  "order-ttl": { type: "string" as const },
  tip: { type: "string" as const },
  propose: { type: "string" as const },
  sign: { type: "string" as const },
  signers: { type: "string" as const },
  out: { type: "string" as const },
};

// --- commands ----------------------------------------------------------------

const commands: Record<string, (argv: string[]) => Promise<void>> = {
  async "keys gen"(argv) {
    const [name] = argv;
    if (!name) return die("usage: vault keys gen <name>");
    mkdirSync(KEYS, { recursive: true, mode: 0o700 });
    if (existsSync(keyPath(name))) die(`key ${name} exists`);
    writeFileSync(keyPath(name), generatePrivateKey() + "\n", { mode: 0o600 });
    chmodSync(keyPath(name), 0o600);
    await commands["keys show"]!([name]);
  },

  async "keys show"(argv) {
    const k = loadKey(argv[0] ?? die("usage: vault keys show <name>"));
    // No provider needed: the network comes from VAULT_NETWORK alone.
    const network = (process.env.VAULT_NETWORK ?? "Preprod") as "Preprod" | "Custom";
    out({ name: k.name, pkh: k.pkh, address: credentialToAddress(network, { type: "Key", hash: k.pkh }) });
  },

  async "vault create"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: { owners: { type: "string" }, threshold: { type: "string" }, "max-validity": { type: "string", default: "10m" }, payer: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const payer = loadKey(v.payer ?? die("--payer <key> required"));
    lucid.selectWallet.fromPrivateKey(payer.privateKey);
    const { tx, vault } = await owner.createVault(
      lucid,
      { owners: list(v.owners).map(pkhOf), threshold: BigInt(v.threshold ?? die("--threshold required")), paused: false, maxTxValidityMs: duration(v["max-validity"]!), apps: [] },
      { refScriptAddress: refHolderAddress(lucid.config().network!) },
    );
    const signedTx = await tx.sign.withWallet().complete();
    const hash = await submitSafely(lucid, signedTx.toCBOR());
    const ref = (await lucid.utxosByOutRef([{ txHash: hash, outputIndex: 0 }, { txHash: hash, outputIndex: 1 }])).find(
      (u) => u.scriptRef?.script === vault.script.script,
    );
    mkdirSync(HOME, { recursive: true });
    writeFileSync(
      STATE,
      JSON.stringify({ network: lucid.config().network, seed: vault.seed, refScript: ref ? { txHash: ref.txHash, outputIndex: ref.outputIndex } : undefined }, null, 2),
    );
    out({ submitted: hash, vault: { address: vault.address, policy: vault.hash }, id: vaultId(loadState()), state: STATE });
  },

  async "vault join"(argv) {
    const s = parseVaultId(argv[0] ?? die("usage: vault vault join <id>   (vault info prints the id)"));
    const lucid = await connect(providerFromEnv());
    if (s.network !== lucid.config().network) die(`id is for ${s.network}, but VAULT_NETWORK is ${lucid.config().network}`);
    if (existsSync(STATE) && vaultId(loadState()) !== vaultId(s)) die(`${STATE} already holds another vault; use a different VAULT_HOME`);
    const vault = makeVault(lucid.config().network!, s.seed);
    // Fails unless a vault with this seed exists on-chain, so a typo can't produce a wrong state file.
    const cfg = await readConfig(lucid, vault);
    mkdirSync(HOME, { recursive: true });
    writeFileSync(STATE, JSON.stringify(s, null, 2));
    out({ joined: vaultId(s), address: vault.address, owners: cfg.config.owners, threshold: cfg.config.threshold, state: STATE });
  },

  async "vault info"() {
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const cfg = await readConfig(lucid, vault);
    const treasury = await treasuryUtxos(lucid, vault);
    const allowances = await listAllowances(lucid, vault);
    out({
      id: vaultId(loadState()),
      address: vault.address,
      policy: vault.hash,
      config: cfg.config,
      treasury: { utxos: treasury.length, lovelace: treasury.reduce((s, u) => s + (u.assets.lovelace ?? 0n), 0n) },
      allowances: allowances.map((a) => ({ unit: a.unit, lovelace: a.utxo.assets.lovelace, datum: a.datum ?? "MALFORMED (reclaim with allowance revoke)" })),
    });
  },

  async "treasury fund"(argv) {
    const { values: v } = parseArgs({ args: argv, options: { ada: { type: "string" }, payer: { type: "string" } } });
    const lucid = await connect(providerFromEnv());
    lucid.selectWallet.fromPrivateKey(loadKey(v.payer ?? die("--payer required")).privateKey);
    const tx = await owner.fundTreasury(lucid, vaultOf(lucid), { lovelace: ada(v.ada) ?? die("--ada required") });
    const signedTx = await tx.sign.withWallet().complete();
    const hash = await submitSafely(lucid, signedTx.toCBOR());
    out({ submitted: hash });
  },

  async "treasury pay"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: { to: { type: "string" }, ada: { type: "string" }, asset: { type: "string" }, propose: { type: "string" }, sign: { type: "string" }, out: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const tx = await owner.treasuryPay(
      lucid,
      vault,
      await readConfig(lucid, vault),
      await treasuryUtxos(lucid, vault),
      [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
      list(v.sign).map(pkhOf),
    );
    await finishTx(lucid, tx, v);
  },

  async "config set"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        owners: { type: "string" },
        threshold: { type: "string" },
        pause: { type: "boolean" },
        unpause: { type: "boolean" },
        "max-validity": { type: "string" },
        propose: { type: "string" },
        sign: { type: "string" },
        "signers": { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const cur = await readConfig(lucid, vault);
    const next = {
      ...cur.config,
      ...(v.owners ? { owners: list(v.owners).map(pkhOf) } : {}),
      ...(v.threshold ? { threshold: BigInt(v.threshold) } : {}),
      ...(v.pause ? { paused: true } : {}),
      ...(v.unpause ? { paused: false } : {}),
      ...(v["max-validity"] ? { maxTxValidityMs: duration(v["max-validity"]) } : {}),
    };
    // Current owners sign; --signers names them when signing offline.
    const signers = list(v.sign ?? v.signers).map(pkhOf);
    const tx = await owner.updateConfig(lucid, vault, cur, next, signers);
    await finishTx(lucid, tx, v);
    if (!v.out) out({ address: vault.address, unchanged: "vault address and policy are independent of the owner set" });
  },

  async "allowance grant"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        agent: { type: "string" },
        dest: { type: "string" },
        cap: { type: "string", multiple: true },
        period: { type: "string", default: "1d" },
        expires: { type: "string", default: "30d" },
        "max-fee": { type: "string", default: "2" },
        fund: { type: "string" },
        "from-treasury": { type: "boolean" },
        apps: { type: "string" },
        propose: { type: "string" },
        sign: { type: "string" },
        signers: { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const now = BigInt(Date.now());
    const { tx, unit } = await owner.grantAllowance(
      lucid,
      vault,
      await readConfig(lucid, vault),
      {
        agent: pkhOf(v.agent ?? die("--agent required")),
        destinations: list(v.dest),
        caps: (v.cap ?? []).map(parseCap),
        periodMs: duration(v.period!),
        windowStart: now - 60_000n,
        expiresAt: now + duration(v.expires!),
        maxFee: ada(v["max-fee"])!,
        fund: { lovelace: ada(v.fund) ?? die("--fund <ada> required") },
        apps: appsArg(v.apps),
      },
      list(v.sign ?? v.signers).map(pkhOf),
      v["from-treasury"] ? { fromTreasury: await treasuryUtxos(lucid, vault) } : {},
    );
    out({ allowance: unit });
    await finishTx(lucid, tx, v);
  },

  async "allowance list"() {
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    out(
      (await listAllowances(lucid, vault)).map((a) => ({
        unit: a.unit,
        lovelace: a.utxo.assets.lovelace,
        agent: a.datum?.agent,
        spent: a.datum?.spent,
        windowStart: a.datum ? new Date(Number(a.datum.windowStart)).toISOString() : undefined,
        destinations: a.datum?.destinations.map((d) => fromPlutusAddress(lucid.config().network!, d)),
      })),
    );
  },

  async "allowance revoke"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { propose: { type: "string" }, sign: { type: "string" }, signers: { type: "string" }, out: { type: "string" } },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const unit = positionals[0] ?? die("usage: vault allowance revoke <unit>");
    // Read raw: revocation must work even if the datum is corrupted (edge U6).
    const [utxo] = await lucid.utxosAtWithUnit(vault.address, unit);
    if (!utxo) die(`no allowance ${unit}`);
    const tx = await owner.revokeAllowance(lucid, vault, await readConfig(lucid, vault), { utxo: utxo!, unit }, list(v.sign ?? v.signers).map(pkhOf));
    await finishTx(lucid, tx, v);
  },

  async "allowance edit"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dest: { type: "string" },
        cap: { type: "string", multiple: true },
        "max-fee": { type: "string" },
        "top-up": { type: "string" },
        apps: { type: "string" },
        propose: { type: "string" },
        sign: { type: "string" },
        signers: { type: "string" },
        out: { type: "string" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const al = await readAllowance(lucid, vault, positionals[0] ?? die("usage: vault allowance edit <unit> ..."));
    const { toPlutusAddress } = await import("./sdk.js");
    const caps = v.cap ? v.cap.map(parseCap) : al.datum.caps;
    const next = {
      ...al.datum,
      ...(v.dest ? { destinations: list(v.dest).map((d) => toPlutusAddress(d)) } : {}),
      caps,
      spent: v.cap ? caps.map(() => 0n) : al.datum.spent,
      ...(v["max-fee"] ? { maxFee: ada(v["max-fee"])! } : {}),
      ...(v.apps !== undefined ? { apps: appsArg(v.apps) } : {}),
    };
    const tx = await owner.editAllowance(lucid, vault, await readConfig(lucid, vault), al, next, list(v.sign ?? v.signers).map(pkhOf), v["top-up"] ? { lovelace: ada(v["top-up"])! } : {});
    await finishTx(lucid, tx, v);
  },

  async "agent spend"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: "string" },
        to: { type: "string" },
        ada: { type: "string" },
        asset: { type: "string" },
        "intent-id": { type: "string" },
        purpose: { type: "string", default: "" },
        ref: { type: "string" },
        "signer-socket": { type: "string" },
        "skip-preflight": { type: "boolean" },
        out: { type: "string" },
      },
    });
    const intentId = v["intent-id"] ?? die("--intent-id <id> is required: it makes the payment idempotent (one payment per id)");
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const unit = positionals[0] ?? die("usage: vault agent spend <allowance-unit> --to addr --ada N --intent-id ID");
    const al = await readAllowance(lucid, vault, unit);
    const agentAddr = addressOf(lucid, al.datum.agent);
    const collateral =
      (await lucid.utxosAt(agentAddr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef) ??
      die(`agent ${agentAddr} needs a pure-ADA UTxO for collateral`);
    lucid.selectWallet.fromAddress(agentAddr, [collateral!]);
    const base = {
      lucid,
      vault,
      collateral: collateral!,
      refScript: await refScriptOf(lucid),
      payments: [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
      intentId,
      purpose: v.purpose!,
      ref: v.ref,
    };
    // The agent's key is held by the signer daemon, or (dev only) a local key file.
    const sign = (cbor: string) =>
      v["signer-socket"]
        ? requestWitness(v["signer-socket"], cbor)
        : cosign.witness(lucid, cbor, loadKey(v.agent ?? die("--signer-socket or --agent <key> required")).privateKey);
    try {
      if (v.out || v["skip-preflight"]) {
        // Export-only, or a deliberate preflight bypass (demos/tests): one build, no retries.
        const built = await agent.buildAgentSpend({ ...base, allowance: al, config: await readConfig(lucid, vault), skipPreflight: v["skip-preflight"] });
        if (v.out) {
          writeFileSync(v.out, built.tx.toCBOR());
          out({ unsigned: v.out, fee: built.fee, next: built.next });
          return;
        }
        const signed = await cosign.assemble(lucid, built.tx.toCBOR(), [await sign(built.tx.toCBOR())]);
        out({ submitted: await submitSafely(lucid, signed.toCBOR(), { id: intentId, allowance: unit }) });
        return;
      }
      const r = await payOnce({ ...base, allowanceUnit: unit }, { q: chainQuery(), journal: journal(), sign });
      if (r.status === "already-paid") out({ alreadyPaid: r.txHash, source: r.source, intentId });
      else out({ submitted: r.txHash, fee: r.built.fee, spent: r.built.next.spent, intent: r.built.intent });
    } catch (e) {
      const err = e as Error & { code?: string };
      out({ blocked: err.code ?? "SCRIPT_OR_LEDGER", reason: err.message.split("\n")[0]?.slice(0, 400) });
      process.exitCode = 3;
    }
  },

  async "app enable"(argv) {
    await appChange(argv, "enable");
  },

  async "app update"(argv) {
    await appChange(argv, "update");
  },

  async "app disable"(argv) {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { propose: { type: "string" }, sign: { type: "string" }, signers: { type: "string" }, out: { type: "string" } } });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    lucid.selectWallet.fromPrivateKey(loadKey(v.propose ?? die("--propose <key> required")).privateKey);
    const tx = await owner.disableApp(lucid, vault, await readConfig(lucid, vault), positionals[0] ?? die("usage: vault app disable minswap"), list(v.sign ?? v.signers).map(pkhOf));
    await finishTx(lucid, tx, v);
  },

  async "app list"() {
    const lucid = await connect(providerFromEnv());
    const cfg = await readConfig(lucid, vaultOf(lucid));
    out(cfg.config.apps.map((a) => ({ name: a.name, adapter: a.adapter, orderScript: a.orderScript, settings: a.name === "minswap" ? minswap.settingsFromData(a.settings) : a.settings })));
  },

  async "agent swap"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        agent: { type: "string" },
        pool: { type: "string" },
        ada: { type: "string" },
        asset: { type: "string" },
        "intent-id": { type: "string" },
        purpose: { type: "string", default: "" },
        "signer-socket": { type: "string" },
      },
    });
    const intentId = v["intent-id"] ?? die("--intent-id <id> is required: one order per id");
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const unit = positionals[0] ?? die("usage: vault agent swap <allowance-unit> --pool <lp|label> --ada N --intent-id ID");
    const found = appFor("minswap", lucid.config().network!) ?? die("Minswap isn't available on this network");
    const pool = found!.network.pools.find((x) => x.label === v.pool || x.lpName === v.pool);
    const lpName = pool?.lpName ?? (v.pool && /^[0-9a-f]{2,64}$/.test(v.pool) ? v.pool : die("--pool <lp name or label> required"));
    const al = await readAllowance(lucid, vault, unit);
    const agentAddr = addressOf(lucid, al.datum.agent);
    const collateral = (await lucid.utxosAt(agentAddr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef) ?? die(`agent ${agentAddr} needs a pure-ADA UTxO for collateral`);
    lucid.selectWallet.fromAddress(agentAddr, [collateral!]);
    const [token, qty] = v.asset ? v.asset.split(":") : [];
    const unitOfAsset = (a: { policy: string; name: string }) => (a.policy === "" ? "lovelace" : a.policy + a.name);
    const sign = (cbor: string) =>
      v["signer-socket"] ? requestWitness(v["signer-socket"], cbor) : cosign.witness(lucid, cbor, loadKey(v.agent ?? die("--signer-socket or --agent <key> required")).privateKey);
    try {
      // The live pool says which side is A (pools outside the catalogue too).
      const live = await minswap.findPool({ lucid }, lpName!);
      const r = await tradeOnce(
        {
          lucid, vault, allowanceUnit: unit, collateral: collateral!, refScript: await refScriptOf(lucid), pool: lpName,
          amountIn: token ? BigInt(qty!) : ada(v.ada ?? die("--ada N or --asset unit:qty required"))!,
          aToB: unitOfAsset(live.pool.assetA) === (token ?? "lovelace"),
          intentId, purpose: v.purpose!, ref: intentId,
        },
        { q: chainQuery(), journal: journal(), sign },
      );
      if (r.status === "already-traded") out({ alreadyTraded: r.txHash, source: r.source, intentId });
      else out({ submitted: r.txHash, fee: r.built.fee, minimumReceive: r.built.order.minimumReceive, expiresAt: new Date(Number(r.built.order.expiry)).toISOString(), spent: r.built.next.spent });
    } catch (e) {
      const err = e as Error & { code?: string };
      out({ blocked: err.code ?? "SCRIPT_OR_LEDGER", reason: err.message.split("\n")[0]?.slice(0, 400) });
      process.exitCode = 3;
    }
  },

  async "agent overlimit"(argv) {
    const { values: v, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string" },
        ada: { type: "string" },
        asset: { type: "string" },
        purpose: { type: "string", default: "" },
        "intent-id": { type: "string" },
        cosigners: { type: "string" },
        out: { type: "string" },
      },
    });
    const intentId = v["intent-id"] ?? die("--intent-id <id> is required (idempotency key)");
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const unitArg = positionals[0] ?? die("usage: vault agent overlimit <unit> ...");
    try {
      const current = await readAllowance(lucid, vault, unitArg!);
      await assertNotPaid(chainQuery(), journal(), unitArg!, current.utxo.txHash, intentId, INTENT_LABEL);
    } catch (e) {
      if (e instanceof AlreadyPaid) return out({ alreadyPaid: e.txHash, source: e.source, intentId });
      throw e;
    }
    const al = await readAllowance(lucid, vault, unitArg!);
    const agentAddr = addressOf(lucid, al.datum.agent);
    const collateral = (await lucid.utxosAt(agentAddr)).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef) ?? die("agent needs collateral");
    lucid.selectWallet.fromAddress(agentAddr, [collateral!]);
    const built = await agent.buildOverLimitSpend({
      tipMs: await chainQuery().tipMs(),
      lucid,
      vault,
      allowance: al,
      config: await readConfig(lucid, vault),
      collateral: collateral!,
      refScript: await refScriptOf(lucid),
      payments: [{ to: v.to ?? die("--to required"), assets: assetsOf(v) }],
      intentId,
      purpose: v.purpose!,
      cosigners: list(v.cosigners).map(pkhOf),
      validityMs: txTtlMs,
    });
    const file = v.out ?? die("--out tx.cbor required (owners co-sign offline)");
    writeFileSync(file, built.tx.toCBOR());
    const summary = cosign.describeTx(built.tx.toCBOR());
    out({
      unsigned: file,
      hash: built.tx.toHash(),
      expiresAt: expiresAt(lucid, summary.validity.ttlSlot),
      fee: built.fee,
      requiredSigners: summary.requiredSigners,
      note: "Spends the allowance's current UTxO: any other payment from this allowance before submission kills it. If owners see it as dead, run this command again with the same --intent-id.",
    });
  },

  async "tx describe"(argv) {
    const cbor = readFileSync(argv[0] ?? die("usage: vault tx describe <tx.cbor>"), "utf8").trim();
    const lucid = await connect(providerFromEnv());
    out({ status: await liveness(lucid, cbor), ...(await describe(lucid, cbor)) });
  },

  async "tx witness"(argv) {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { key: { type: "string" }, out: { type: "string" } } });
    const cbor = readFileSync(positionals[0] ?? die("usage: vault tx witness <tx.cbor> --key k --out k.wit"), "utf8").trim();
    const lucid = await connect(providerFromEnv());
    await requireLive(lucid, cbor);
    const w = await cosign.witness(lucid, cbor, loadKey(v.key ?? die("--key required")).privateKey);
    writeFileSync(v.out ?? die("--out required"), w);
    out({ witness: v.out, body: lucid.fromTx(cbor).toHash() });
  },

  async "tx assemble"(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    const [txFile, ...wits] = positionals;
    if (!txFile || !wits.length) return die("usage: vault tx assemble <tx.cbor> <a.wit> <b.wit> ...");
    const lucid = await connect(providerFromEnv());
    const cbor = readFileSync(txFile, "utf8").trim();
    const l = await liveness(lucid, cbor);
    if (l.state === "landed") return out({ submitted: lucid.fromTx(cbor).toHash(), alreadyLanded: true });
    if (l.state === "dead") die(`not submitting: this tx is dead: ${l.reason}`);
    // Lucid needs *a* wallet selected to finish a tx; a read-only one suffices.
    const first = cosign.describeTx(cbor).requiredSigners[0] ?? die("tx has no required signers");
    lucid.selectWallet.fromAddress(addressOf(lucid, first!), []);
    const signed = await cosign.assemble(lucid, cbor, wits.map((f) => readFileSync(f, "utf8").trim()));
    const intent = (await describe(lucid, cbor)).intent;
    // A fixed body can't be rebuilt here: on NeverLands the parties must build and sign a new one.
    try {
      out({ submitted: await submitSafely(lucid, signed.toCBOR(), intent ? { id: intent.id, allowance: intent.allowance } : undefined) });
    } catch (e) {
      if (e instanceof NeverLands) die(`${e.message}. This body can't be rebuilt here: the agent must build a new tx and owners re-sign it.`);
      throw e;
    }
  },

  async "signer start"(argv) {
    const { values: v } = parseArgs({
      args: argv,
      options: {
        key: { type: "string" },
        socket: { type: "string" },
        allowance: { type: "string" },
        dest: { type: "string" },
        "max-tx-per-hour": { type: "string", default: "20" },
        "max-ada-per-day": { type: "string", default: "100" },
        "max-per-day": { type: "string" },
        "max-ttl": { type: "string", default: "15m" },
        "max-cosigned-ttl": { type: "string", default: "2h" },
        "allow-cosigned": { type: "boolean" },
        audit: { type: "string" },
        "socket-mode": { type: "string", default: "600" },
      },
    });
    const lucid = await connect(providerFromEnv());
    const vault = vaultOf(lucid);
    const k = loadKey(v.key ?? die("--key required"));
    // Like ssh: a key file anyone else can read isn't held by the signer alone.
    if (statSync(keyPath(k.name)).mode & 0o077) die(`${keyPath(k.name)} is readable by group or others; chmod 600 it`);
    const socketMode = ({ "600": 0o600, "660": 0o660 } as const)[v["socket-mode"] as "600" | "660"] ?? die("--socket-mode must be 600 or 660");
    const coSignedTtl = Number(duration(v["max-cosigned-ttl"]!));
    if (coSignedTtl > owner.MAX_OFFLINE_TTL_MS) die(`--max-cosigned-ttl can be at most ${owner.MAX_OFFLINE_TTL_MS / 3_600_000}h`);
    const { SLOT_CONFIG_NETWORK } = await import("./sdk.js");
    await startSigner({
      socketPath: v.socket ?? join(HOME, "signer.sock"),
      privateKey: k.privateKey,
      auditLog: v.audit ?? join(HOME, "signer-audit.jsonl"),
      socketMode,
      // Rate/budget counters and the intent-id dedupe table survive restarts.
      statePath: join(HOME, "signer-state.json"),
      chain: chainQuery(),
      policy: {
        agentKeyHash: k.pkh,
        vaultAddress: vault.address,
        allowanceUnit: v.allowance ?? die("--allowance required"),
        destinations: list(v.dest),
        maxTxPerHour: Number(v["max-tx-per-hour"]),
        // Every asset that may leave needs a daily limit; tokens without one are refused.
        maxPerDay: {
          lovelace: ada(v["max-ada-per-day"])!,
          ...Object.fromEntries(
            list(v["max-per-day"]).map((e) => {
              const [unit, qty] = e.split(":");
              if (!unit || !qty || !/^\d+$/.test(qty)) die(`--max-per-day expects unit:quantity, got ${e}`);
              return [unit, BigInt(qty!)];
            }),
          ),
        },
        maxTtlMs: Number(duration(v["max-ttl"]!)),
        maxCoSignedTtlMs: coSignedTtl,
        allowCoSigned: !!v["allow-cosigned"],
        slot: SLOT_CONFIG_NETWORK[lucid.config().network!],
      },
    });
    console.error(`signer listening on ${v.socket ?? join(HOME, "signer.sock")} (key ${k.name})`);
  },
};

const HELP = `vault <command>
  keys gen|show <name>
  vault create --owners a,b,c --threshold 2 [--max-validity 10m] --payer a
  vault info                                  (prints the vault id to share)
  vault join <id>                             (owners and operators: no need to copy state.json)
  treasury fund --ada N --payer a
  treasury pay --to addr --ada N --propose a --sign a,b | --signers a,b --out tx.cbor
  config set [--owners ..] [--threshold N] [--pause|--unpause] [--max-validity 10m] --propose a --sign a,b
  allowance grant --agent k --dest addr1,addr2 --cap lovelace:WINDOW_ADA:TX_ADA [--period 1d] [--expires 30d]
                  [--max-fee 2] --fund N [--from-treasury] --propose a --sign a,b
  allowance list | edit <unit> ... [--apps minswap|none] | revoke <unit> --propose a --sign a,b
  app enable|update minswap --pools any|<lp|label,...> --slippage <pct> --fee <ada> --order-ttl <dur> --tip <ada> --propose a --sign a,b
      (every flag required: no defaults)   app disable minswap --propose a --sign a,b   app list
  agent swap <unit> --pool <lp|label> (--ada N | --asset unit:qty) --intent-id ID --purpose "..." (--signer-socket path | --agent k)
  agent spend <unit> --to addr --ada N --intent-id ID --purpose "..." (--signer-socket path | --agent k) [--skip-preflight]
  agent overlimit <unit> --to addr --ada N --intent-id ID --purpose "..." --cosigners a,c --out tx.cbor
  tx describe <tx.cbor> | tx witness <tx.cbor> --key k --out k.wit | tx assemble <tx.cbor> <wits...>
  --ttl 6h  how long an owner or over-limit tx stays submittable (default 10m, or 2h with --out; max 24h)
  signer start --key agent --allowance <unit> --dest addr1,addr2 [--socket path] [--max-ada-per-day N]
               [--max-per-day unit:qty,...] [--max-tx-per-hour N] [--max-ttl 15m] [--allow-cosigned] [--max-cosigned-ttl 2h]
               [--socket-mode 600|660]   660: run the signer as its own OS user; the agent connects via the group
env: VAULT_NETWORK=Preprod|Custom, BLOCKFROST_PROJECT_ID, VAULT_HOME`;


async function main() {
  const [a, b, ...rest] = process.argv.slice(2);
  const cmd = commands[`${a} ${b}`];
  if (!cmd) {
    console.log(HELP);
    process.exit(a ? 2 : 0);
  }
  // Txs signed on several machines (--out) need longer than one sitting.
  const i = rest.indexOf("--ttl");
  const ttlArg = i >= 0 ? rest.splice(i, 2)[1] ?? die("--ttl needs a duration, e.g. 6h") : undefined;
  const network = process.env.VAULT_NETWORK ?? "Preprod";
  txTtlMs = ttlArg
    ? Number(duration(ttlArg))
    : process.env.VAULT_TX_TTL_MS
      ? Number(process.env.VAULT_TX_TTL_MS)
      : rest.includes("--out")
        ? owner.offlineTtlMs(network)
        : network === "Custom"
          ? 90_000
          : 10 * 60_000;
  if (txTtlMs > owner.MAX_OFFLINE_TTL_MS) die(`--ttl can be at most ${owner.MAX_OFFLINE_TTL_MS / 3_600_000}h`);
  owner.setOwnerTxTtl(txTtlMs);
  for (let attempt = 1; ; attempt++) {
    try {
      return await cmd!(rest);
    } catch (e) {
      // Edge I6: rebuild ONLY when the attempted tx provably can never land
      // (its inputs were spent by another tx, or its TTL passed). See idempotency.ts.
      if (!(e instanceof NeverLands) || attempt >= 6) throw e;
      console.error(`attempt ${attempt} can never land (stale provider view); re-reading chain state and rebuilding`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

main().catch((e) => die((e as Error).message?.split("\n")[0] ?? String(e)));


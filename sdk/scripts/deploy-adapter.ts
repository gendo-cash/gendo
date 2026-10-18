// Puts the Minswap adapter on preprod, idempotent:
//  - checks the catalogue's pools are genuine Minswap pools;
//  - publishes the adapter as a reference script at the vault's always-fail holder (its ADA is locked for good);
//  - registers the adapter's stake credential (withdraw-zero needs it; the 2 ADA deposit can't be reclaimed:
//    the adapter only allows registration).
// Prints the reference script's out ref for the catalogue's `adapterRef`. Without --go it only reports.
// Usage: set -a && source .env && set +a && npx tsx sdk/scripts/deploy-adapter.ts [--go]
import { readFileSync } from "node:fs";
import type { LucidEvolution } from "@lucid-evolution/lucid";
import { appFor } from "../src/core/apps/catalogue.js";
import { minswapAdapter } from "../src/core/apps/minswap/adapter.js";
import { findPool } from "../src/core/apps/minswap/trade.js";
import { connect, providerFromEnv } from "../src/core/provider.js";
import { refHolderAddress } from "../src/core/vault.js";

const go = process.argv.includes("--go");
const cfg = providerFromEnv();
if (cfg.network !== "Preprod") throw new Error("preprod only: set VAULT_NETWORK=Preprod");
const keyPath = process.env.FUNDER_KEY ?? "";
if (!keyPath) throw new Error("FUNDER_KEY (path to the funded preprod key file) is required");

const lucid: LucidEvolution = await connect(cfg);
lucid.selectWallet.fromPrivateKey(readFileSync(keyPath, "utf8").trim());
const found = appFor("minswap", "Preprod")!;
const adapter = minswapAdapter("Preprod");
const holder = refHolderAddress("Preprod");

const funds = (await lucid.wallet().getUtxos()).reduce((n, u) => n + u.assets.lovelace!, 0n);
console.log(`funder: ${await lucid.wallet().address()} holds ${Number(funds) / 1e6} tADA`);
console.log(`adapter: ${adapter.hash} (${adapter.rewardAddress})`);

for (const p of found.network.pools) {
  const { pool } = await findPool({ lucid }, p.lpName);
  console.log(`pool ${p.label}: genuine, reserves ${pool.reserveA} / ${pool.reserveB}`);
}

const existing = (await lucid.utxosAt(holder)).find((u) => u.scriptRef && u.scriptRef.script === adapter.script.script);
const registered = !!(await (await fetch(`${cfg.blockfrostUrl}/accounts/${adapter.rewardAddress}`, { headers: { project_id: cfg.blockfrostProjectId! } })).json() as { active?: boolean }).active;
console.log(`reference script: ${existing ? `already at ${existing.txHash}#${existing.outputIndex}` : "not published"}`);
console.log(`stake credential: ${registered ? "registered" : "not registered"}`);
if (!go) {
  console.log("dry run: pass --go to publish and register");
  process.exit(0);
}

async function submit(build: () => ReturnType<ReturnType<LucidEvolution["newTx"]>["complete"]>) {
  const signed = await (await build()).sign.withWallet().complete();
  const hash = await signed.submit();
  await lucid.awaitTx(hash);
  return hash;
}

let ref = existing ? `${existing.txHash}#${existing.outputIndex}` : "";
if (!existing) {
  const hash = await submit(() => lucid.newTx().pay.ToAddressWithData(holder, undefined, { lovelace: 0n }, adapter.script).complete());
  const out = (await lucid.utxosAt(holder)).find((u) => u.txHash === hash && u.scriptRef);
  ref = `${hash}#${out!.outputIndex}`;
  console.log(`reference script published: ${ref} (${Number(out!.assets.lovelace) / 1e6} tADA locked)`);
}
if (!registered) console.log(`stake credential registered: ${await submit(() => lucid.newTx().register.Stake(adapter.rewardAddress).complete())}`);
console.log(`adapterRef for the catalogue: ${ref}`);

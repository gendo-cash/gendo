// Devnet fixture: a vault from before apps (version 1), built with the old code the way the old app built
// it: a four-field config, a 100 ADA treasury, one eight-field agent budget of 20 ADA. Prints its vault id.
// Usage: VAULT_NETWORK=Custom npx tsx sdk/scripts/devnet-v1-vault.ts <owner key file> <agent key hash>
import { readFileSync } from "node:fs";
import { CML, Constr, Data } from "@lucid-evolution/lucid";
import { addressToData, mintRedeemer } from "../src/core/data.js";
import { makeVaultV1 } from "../src/core/legacy.js";
import { connect, providerFromEnv } from "../src/core/provider.js";
import { allowanceName, formatVaultId } from "../src/core/vault.js";

const [keyFile, agent] = process.argv.slice(2);
if (!keyFile || !/^[0-9a-f]{56}$/.test(agent ?? "")) throw new Error("usage: devnet-v1-vault.ts <owner key file> <agent key hash>");
const cfg = providerFromEnv();
if (cfg.network !== "Custom") throw new Error("devnet only: set VAULT_NETWORK=Custom");
const lucid = await connect(cfg);
const sk = readFileSync(keyFile, "utf8").trim();
lucid.selectWallet.fromPrivateKey(sk);
const owner = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
const ADA = 1_000_000n;
const HOUR = 3_600_000n;

const submit = async (b: ReturnType<typeof lucid.newTx>) => {
  const hash = await (await (await b.complete()).sign.withWallet().complete()).submit();
  await lucid.awaitTx(hash);
  await new Promise((r) => setTimeout(r, 2000)); // let the indexer catch up
  return hash;
};
const pureAda = async () => (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1 && !u.scriptRef)!;

const seed = await pureAda();
const vault = makeVaultV1("Custom", { txHash: seed.txHash, outputIndex: seed.outputIndex });
await submit(
  lucid
    .newTx()
    .collectFrom([seed])
    .mintAssets({ [vault.configUnit]: 1n }, mintRedeemer("InitConfig"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(vault.address, { kind: "inline", value: Data.to(new Constr(0, [[owner], 1n, new Constr(0, []), 2n * 60_000n])) }, { lovelace: 2n * ADA, [vault.configUnit]: 1n })
    .pay.ToAddress(vault.address, { lovelace: 100n * ADA }),
);

const config = (await lucid.utxosAt(vault.address)).find((u) => (u.assets[vault.configUnit] ?? 0n) > 0n)!;
const s2 = await pureAda();
const unit = vault.hash + allowanceName({ txHash: s2.txHash, outputIndex: s2.outputIndex });
const now = BigInt(Date.now());
const payee = addressToData({ payment: { type: "Key", hash: agent! }, stake: null });
await submit(
  lucid
    .newTx()
    .collectFrom([s2])
    .readFrom([config])
    .mintAssets({ [unit]: 1n }, mintRedeemer("ManageAllowances"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(
      vault.address,
      { kind: "inline", value: Data.to(new Constr(0, [agent!, [payee], [new Constr(0, ["", "", 25n * ADA, 10n * ADA])], [0n], now - HOUR, 86_400_000n, now + 30n * 86_400_000n, 1_000_000n])) },
      { lovelace: 20n * ADA, [unit]: 1n },
    )
    .addSignerKey(owner),
);
console.log(JSON.stringify({ vaultId: formatVaultId({ network: "Custom", seed: vault.seed }), policy: vault.hash, unit }));

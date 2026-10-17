// Devnet stand-in for Minswap (the catalogue's Custom deployment), idempotent:
//  - a fixture pool (MSP + LP "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f" + TEST under the open policy) at the always-fail holder;
//  - the Minswap adapter's stake credential, registered (withdraw-zero needs it);
//  - Minswap's expired-order-cancel stake credential, registered (so expired orders refund).
// Usage: VAULT_NETWORK=Custom npx tsx sdk/scripts/devnet-apps.ts
import { CML, credentialToAddress, generatePrivateKey, scriptFromNative, validatorToRewardAddress, type LucidEvolution, type Script } from "@lucid-evolution/lucid";
import scripts from "../test/fixtures/minswap-preprod-scripts.json" with { type: "json" };
import { appFor } from "../src/core/apps/catalogue.js";
import { minswapAdapter } from "../src/core/apps/minswap/adapter.js";
import { poolDatumToData } from "../src/core/apps/minswap/data.js";
import { connect, providerFromEnv } from "../src/core/provider.js";

const cfg = providerFromEnv();
if (cfg.network !== "Custom") throw new Error("devnet only: set VAULT_NETWORK=Custom");
const dep = appFor("minswap", "Custom")!.network;
const P = dep.deployment.lpPolicy;

async function funded(lucid: LucidEvolution) {
  const sk = generatePrivateKey();
  const pkh = CML.PrivateKey.from_bech32(sk).to_public().hash().to_hex();
  const address = credentialToAddress("Custom", { type: "Key", hash: pkh });
  for (let i = 0; i < 30; i++) {
    await fetch(`${cfg.devnet!.adminUrl}/addresses/topup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, adaAmount: 200 }) }).catch(() => undefined);
    for (let j = 0; j < 10; j++) {
      if ((await lucid.utxosAt(address)).length) return sk;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("devnet faucet didn't fund the setup key");
}

async function submit(lucid: LucidEvolution, sk: string, build: () => Promise<{ sign: { withPrivateKey(k: string): { complete(): Promise<{ submit(): Promise<string> }> } } }>) {
  const tx = await build();
  const hash = await (await tx.sign.withPrivateKey(sk).complete()).submit();
  await lucid.awaitTx(hash);
  return hash;
}

const lucid = await connect(cfg);
const sk = await funded(lucid);
lucid.selectWallet.fromPrivateKey(sk);

const pools = (await lucid.utxosAtWithUnit(dep.poolAddress, P + "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f")).filter((u) => u.assets[P + "4d5350"] === 1n);
if (pools.length) console.log("fixture pool: already there");
else {
  const datum = poolDatumToData({ assetA: { policy: "", name: "" }, assetB: { policy: P, name: "54455354" }, totalLiquidity: 1_000_000n, reserveA: 1_000_000_000_000n, reserveB: 2_000_000_000_000n, feeA: 30n, feeB: 30n, batchingStakeScript: "fb".repeat(28) });
  const h = await submit(lucid, sk, () =>
    lucid
      .newTx()
      .mintAssets({ [P + "4d5350"]: 1n, [P + "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
      .attach.MintingPolicy(scriptFromNative({ type: "all", scripts: [] }))
      .pay.ToContract(dep.poolAddress, { kind: "inline", value: datum }, { lovelace: 5_000_000n, [P + "4d5350"]: 1n, [P + "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f"]: 1_000_000n, [P + "54455354"]: 1_000_000n })
      .complete() as never,
  );
  console.log(`fixture pool: placed (${h})`);
}

for (const [name, reward] of [["Minswap adapter", minswapAdapter("Custom").rewardAddress], ["Minswap expired-order cancel", validatorToRewardAddress("Custom", scripts.expiredOrderCancelScript as Script)]] as const) {
  try {
    await submit(lucid, sk, () => lucid.newTx().register.Stake(reward).complete() as never);
    console.log(`${name}: registered (${reward})`);
  } catch (e) {
    if (/StakeKeyRegistered|already registered|ReRegistration|StakeKeyAlreadyRegistered/i.test(String((e as Error).message ?? e))) console.log(`${name}: already registered`);
    else throw e;
  }
}

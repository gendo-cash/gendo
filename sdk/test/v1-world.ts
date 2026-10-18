// Version-1 vaults (from before apps) in the emulator, built the way the old code built them:
// a four-field config, eight-field allowances, the old compiled validator.
import { Constr, Data, type Emulator, type LucidEvolution, type UTxO } from "@lucid-evolution/lucid";
import { makeVaultV1 } from "../src/core/legacy.js";
import { toPlutusAddress } from "../src/core/address.js";
import { addressToData, mintRedeemer } from "../src/core/data.js";
import { allowanceName, type Vault } from "../src/core/vault.js";
import { ADA, signAndSubmit, type Party } from "./helpers.js";

const HOUR = 3_600_000n;

export const v1ConfigData = (owners: string[], threshold: bigint) => Data.to(new Constr(0, [owners, threshold, new Constr(0, []), HOUR]));

export async function createV1Vault(lucid: LucidEvolution, emulator: Emulator, creator: Party, owners: string[], threshold: bigint): Promise<Vault> {
  lucid.selectWallet.fromPrivateKey(creator.privateKey);
  const seed = (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1)!;
  const vault = makeVaultV1("Custom", { txHash: seed.txHash, outputIndex: seed.outputIndex });
  const tx = await lucid
    .newTx()
    .collectFrom([seed])
    .mintAssets({ [vault.configUnit]: 1n }, mintRedeemer("InitConfig"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(vault.address, { kind: "inline", value: v1ConfigData(owners, threshold) }, { lovelace: 2n * ADA, [vault.configUnit]: 1n })
    .pay.ToAddress(vault.address, { lovelace: 100n * ADA })
    .complete();
  await signAndSubmit(lucid, emulator, tx, [creator]);
  return vault;
}

/** An old allowance: the token minted with ManageAllowances, an eight-field datum, `fund` ADA. */
export async function grantV1(lucid: LucidEvolution, emulator: Emulator, vault: Vault, proposer: Party, signers: Party[], agent: string, payee: string, fund: bigint): Promise<string> {
  lucid.selectWallet.fromPrivateKey(proposer.privateKey);
  const seed = (await lucid.wallet().getUtxos()).find((u) => Object.keys(u.assets).length === 1)!;
  const config = (await lucid.utxosAt(vault.address)).find((u) => (u.assets[vault.configUnit] ?? 0n) > 0n) as UTxO;
  const unit = vault.hash + allowanceName({ txHash: seed.txHash, outputIndex: seed.outputIndex });
  const now = BigInt(emulator.now());
  const datum = Data.to(
    new Constr(0, [agent, [addressToData(toPlutusAddress(payee))], [new Constr(0, ["", "", 50n * ADA, 20n * ADA])], [0n], now - HOUR, 86_400_000n, now + 30n * 86_400_000n, 1_000_000n]),
  );
  let b = lucid
    .newTx()
    .collectFrom([seed])
    .readFrom([config])
    .mintAssets({ [unit]: 1n }, mintRedeemer("ManageAllowances"))
    .attach.MintingPolicy(vault.script)
    .pay.ToContract(vault.address, { kind: "inline", value: datum }, { lovelace: fund, [unit]: 1n });
  for (const s of signers) b = b.addSignerKey(s.pkh);
  await signAndSubmit(lucid, emulator, await b.complete(), signers);
  return unit;
}

// Vaults from before apps (version 1). Their code is fixed on chain, so they can't gain apps; their
// owners can only move everything into a current vault (owner.moveToCurrentVault). This keeps the
// old compiled code (from gendo a211626) so their ids still derive their address.
import { Constr, Data, type Network } from "@lucid-evolution/lucid";
import { allowanceFromData, configFromData, type AllowanceDatum, type ConfigDatum } from "./data.js";
import v1 from "./legacy/vault-v1.json" with { type: "json" };
import { makeVault, type OutRef, type Vault, type VaultId } from "./vault.js";

export const makeVaultV1 = (network: Network, seed: OutRef): Vault => makeVault(network, seed, v1.compiledCode);

/** Which code a saved vault runs: the current one (2) or the one before apps (1); undefined if its id names neither. */
export function vaultVersionOf(id: VaultId, policy: string): { version: 1 | 2; vault: Vault } | undefined {
  const current = makeVault(id.network, id.seed);
  if (current.hash === policy) return { version: 2, vault: current };
  const old = makeVaultV1(id.network, id.seed);
  return old.hash === policy ? { version: 1, vault: old } : undefined;
}

/** A version-1 allowance (eight fields), read as a current one with no apps. */
export function allowanceFromDataV1(cbor: string): AllowanceDatum {
  const c = Data.from(cbor) as Constr<Data>;
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 8) throw new Error("not a version-1 AllowanceDatum");
  return allowanceFromData(Data.to(new Constr(0, [...c.fields, []])));
}

/** A version-1 config (four fields), read as a current one with no apps. */
export function configFromDataV1(cbor: string): ConfigDatum {
  const c = Data.from(cbor) as Constr<Data>;
  if (!(c instanceof Constr) || c.index !== 0 || c.fields.length !== 4) throw new Error("not a version-1 ConfigDatum");
  return configFromData(Data.to(new Constr(0, [...c.fields, []])));
}

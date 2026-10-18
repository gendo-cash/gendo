// A proposal's recipe: what to build, so any required signer can rebuild it when it goes stale.
import type { AllowanceDatum, Explanation } from "../../../sdk/src/core/index.ts";
import type { Grant } from "../../../sdk/src/core/owner.ts";
import { appChanges } from "../../../sdk/src/core/explain.ts";
import { minswapAppConfig } from "../../../sdk/src/core/apps/minswap/adapter.ts";
import type { MinswapSettings } from "../../../sdk/src/core/apps/minswap/data.ts";
import { CML, CONFIG_TOKEN_NAME, listAllowances, makeVault, parseVaultId, multiAssetToAssets, owner, readAllowance, readConfig, treasuryUtxos, type LucidEvolution, type TxSignBuilder, type Vault } from "../../../sdk/src/core/index.ts";

export type Recipe =
  | { op: "pause" }
  | { op: "unpause"; signers: string[] }
  | { op: "config"; owners: string[]; threshold: bigint; signers: string[] }
  | { op: "edit"; unit: string; next: AllowanceDatum; topUp: bigint; signers: string[] }
  | { op: "grant"; grant: Grant & { collateral?: bigint }; signers: string[] }
  | { op: "revoke"; unit: string; signers: string[] }
  | { op: "fund"; lovelace: bigint }
  | { op: "apps"; action: "enable" | "update" | "disable"; name: "minswap"; settings?: MinswapSettings; signers: string[] }
  /** A vault from before apps: everything into the current vault `to` (a vault id). */
  | { op: "move"; to: string; signers: string[] };

export const encodeRecipe = (r: Recipe): unknown => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? { $n: v.toString() } : v)));

export function decodeRecipe(x: unknown): Recipe | undefined {
  try {
    const r = JSON.parse(JSON.stringify(x), (_k, v) => (v && typeof v === "object" && Object.keys(v).length === 1 && typeof v.$n === "string" && /^-?\d+$/.test(v.$n) ? BigInt(v.$n) : v)) as Recipe;
    const signers = (r as { signers?: unknown }).signers;
    const okSigners = Array.isArray(signers) && signers.every((s) => typeof s === "string" && /^[0-9a-f]{56}$/.test(s));
    switch (r?.op) {
      case "pause": return r;
      case "fund": return typeof r.lovelace === "bigint" ? r : undefined;
      case "unpause": return okSigners ? r : undefined;
      case "config": return okSigners && Array.isArray(r.owners) && typeof r.threshold === "bigint" ? r : undefined;
      case "edit": return okSigners && typeof r.unit === "string" && r.next && typeof r.topUp === "bigint" ? r : undefined;
      case "grant": return okSigners && r.grant ? r : undefined;
      case "revoke": return okSigners && typeof r.unit === "string" ? r : undefined;
      case "move": return okSigners && typeof r.to === "string" && r.to.length <= 200 ? r : undefined;
      case "apps": {
        const s = r.settings;
        const okSettings = !!s && (s.pools === "any" || (Array.isArray(s.pools) && s.pools.every((p) => typeof p === "string"))) && [s.maxSlippageBps, s.maxBatcherFee, s.maxOrderTtlMs, s.maxCancelTip].every((x) => typeof x === "bigint");
        if (!okSigners || r.name !== "minswap" || !["enable", "update", "disable"].includes(r.action)) return undefined;
        return r.action === "disable" || okSettings ? r : undefined;
      }
      default: return undefined;
    }
  } catch {
    return undefined;
  }
}

/** Build the recipe's tx with the SDK's owner builders; the connected wallet pays the fee. */
export async function buildRecipe(l: LucidEvolution, vault: Vault, r: Recipe, me: string): Promise<TxSignBuilder> {
  if (r.op === "move") {
    // The destination must be a current vault: its id derives it with the current code.
    const id = parseVaultId(r.to);
    const to = makeVault(id.network, id.seed);
    return owner.moveToCurrentVault(l, vault, to, (await readConfig(l, to)).config, r.signers);
  }
  const cfg = await readConfig(l, vault);
  switch (r.op) {
    case "pause":
      return owner.pause(l, vault, cfg, [me]);
    case "unpause":
      return owner.unpause(l, vault, cfg, r.signers);
    case "config":
      return owner.updateConfig(l, vault, cfg, { ...cfg.config, owners: r.owners, threshold: r.threshold }, r.signers);
    case "edit":
      return owner.editAllowance(l, vault, cfg, await readAllowance(l, vault, r.unit), r.next, r.signers, r.topUp > 0n ? { lovelace: r.topUp } : {});
    case "grant": {
      const fromTreasury = (r.grant.fund.lovelace ?? 0n) > 0n ? await treasuryUtxos(l, vault) : undefined;
      const { collateral, ...grant } = r.grant;
      return (await owner.grantAllowance(l, vault, cfg, grant, r.signers, { ...(fromTreasury ? { fromTreasury } : {}), ...(collateral ? { agentCollateral: collateral } : {}) })).tx;
    }
    case "revoke": {
      const al = (await listAllowances(l, vault)).find((a) => a.unit === r.unit);
      if (!al) throw new Error("that agent's allowance isn't on chain any more");
      return owner.revokeAllowance(l, vault, cfg, { utxo: al.utxo, unit: al.unit }, r.signers);
    }
    case "apps": {
      if (r.action === "disable") return owner.disableApp(l, vault, cfg, r.name, r.signers);
      const app = minswapAppConfig(l.config().network!, r.settings!);
      return r.action === "enable" ? owner.enableApp(l, vault, cfg, app, r.signers) : owner.updateApp(l, vault, cfg, app, r.signers);
    }
    case "fund": {
      // Funding needs no owner, but naming the funder as a signer lets it go through the inbox,
      // which submits a fully signed tx at once (no separate submit path on the server).
      const now = l.slotToUnixTime(l.currentSlot());
      return l.newTx().pay.ToAddress(vault.address, { lovelace: r.lovelace }).addSignerKey(me).validTo(now + owner.offlineTtlMs(l.config().network!)).complete();
    }
  }
}

export function titleOf(r: Recipe, labels: Record<string, string>): string {
  const n = (u: string) => labels[u] ?? `agent ${u.slice(56, 64)}`;
  switch (r.op) {
    case "pause": return "Pause all agents";
    case "unpause": return "Unpause";
    case "config": return "Change owners or threshold";
    case "edit": return `Change ${n(r.unit)}`;
    case "grant": return "Add an agent";
    case "revoke": return `Revoke ${n(r.unit)}`;
    case "fund": return "Fund the treasury";
    case "apps": return r.action === "enable" ? "Enable Minswap" : r.action === "disable" ? "Disable Minswap" : "Change Minswap settings";
    case "move": return "Move to the new version";
  }
}

/** Rebuild only what the dead item was: the recipe's op (and allowance) must match what its tx changed. */
export function recipeMatches(r: Recipe, e: Explanation): boolean {
  const c = e.changes;
  switch (r.op) {
    case "pause":
      return c.length === 1 && c[0]!.kind === "config" && c[0]!.after?.paused === true;
    case "unpause":
      return c.length === 1 && c[0]!.kind === "config" && c[0]!.after?.paused === false;
    case "config":
      return c.length === 1 && c[0]!.kind === "config";
    case "edit":
      return c.length === 1 && c[0]!.kind === "edit" && c[0]!.unit === r.unit;
    case "revoke":
      return c.length === 1 && c[0]!.kind === "revoke" && c[0]!.unit === r.unit;
    case "grant":
      return c.length === 1 && c[0]!.kind === "grant";
    case "fund":
      return c.length === 0 && Object.keys(e.leavesVault).length === 0;
    case "move":
      return c.every((x) => x.kind === "revoke") && Object.keys(e.leavesVault).length > 0;
    case "apps": {
      if (c.length !== 1 || c[0]!.kind !== "config") return false;
      const d = appChanges(c[0]!.before, c[0]!.after);
      return r.action === "enable" ? d.added.some((a) => a.name === r.name) : r.action === "disable" ? d.removed.includes(r.name) : d.changed.some((x) => x.name === r.name);
    }
  }
}

/** The allowance a grant tx mints (its vault-policy token that isn't the config), so it can be named before it lands. */
export function grantedUnit(cbor: string, policy: string): string | undefined {
  const minted = multiAssetToAssets(CML.Transaction.from_cbor_hex(cbor).body().mint()) as Record<string, bigint>;
  return Object.keys(minted).find((u) => u.startsWith(policy) && u !== policy + CONFIG_TOKEN_NAME && minted[u] === 1n);
}

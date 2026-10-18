// The server's list of your vaults is a convenience, not a source of truth: an entry is kept only
// when its vault id really names the vault its policy says, so a page never shows one vault and
// builds against another.
import { parseVaultId, vaultVersionOf } from "../../../sdk/src/core/index.ts";
import type { MyVault } from "./api.ts";

/** A saved vault and the code it runs: 2 is current; 1 is from before apps (it can only be moved). */
export type SavedVault = MyVault & { version: 1 | 2 };

export const knownVaults = (list: MyVault[]): SavedVault[] =>
  list.flatMap((v) => {
    try {
      const found = vaultVersionOf(parseVaultId(v.vaultId), v.policy);
      return found ? [{ ...v, version: found.version }] : [];
    } catch {
      return [];
    }
  });

/** The sidebar's few: vaults with something waiting on you first, then the newest added (the server's
 * order), and the open vault always among them. */
export function sidebarVaults<V extends MyVault>(list: V[], needYou: Record<string, number>, current?: string, n = 5): V[] {
  const order = [...list].sort((a, b) => Number(!needYou[a.policy]) - Number(!needYou[b.policy]));
  const top = order.slice(0, n);
  const open = order.find((v) => v.policy === current);
  return open && !top.includes(open) ? [...top.slice(0, n - 1), open] : top;
}

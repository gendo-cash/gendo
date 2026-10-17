// The server's list of your vaults is a convenience, not a source of truth: an entry is kept only
// when its vault id really names the vault its policy says, so a page never shows one vault and
// builds against another.
import type { MyVault } from "./api.ts";
import { vaultFromId } from "./chain.ts";

export const consistentVaults = (list: MyVault[]) =>
  list.filter((v) => {
    try {
      return vaultFromId(v.vaultId).hash === v.policy;
    } catch {
      return false;
    }
  });

/** The sidebar's few: vaults with something waiting on you first, then the newest added (the server's
 * order), and the open vault always among them. */
export function sidebarVaults(list: MyVault[], needYou: Record<string, number>, current?: string, n = 5): MyVault[] {
  const order = [...list].sort((a, b) => Number(!needYou[a.policy]) - Number(!needYou[b.policy]));
  const top = order.slice(0, n);
  const open = order.find((v) => v.policy === current);
  return open && !top.includes(open) ? [...top.slice(0, n - 1), open] : top;
}

/** Saved vaults whose ids no longer derive their address: vaults from before an update that changed the vault's code. */
export const staleCount = (list: MyVault[]) => list.length - consistentVaults(list).length;

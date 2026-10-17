import { describe, expect, it } from "vitest";
import { orderStatus } from "../../src/core/apps/minswap/status.js";

const ORDER = "addr_test1order", VAULT = "addr_test1vault", TOKEN = "7c".repeat(28) + "4e";
const order = { orderTx: "aa".repeat(32), orderAddress: ORDER, vaultAddress: VAULT, inUnit: "lovelace", outUnit: TOKEN, minimumReceive: 900n };
const chain = (spender: Record<string, unknown> | null, vaultOut?: { unit: string; quantity: string }[]) => async (path: string) => {
  if (path === `/txs/${order.orderTx}/utxos`)
    return { outputs: [{ address: "addr_test1change", output_index: 0, amount: [] }, { address: ORDER, output_index: 1, amount: [{ unit: "lovelace", quantity: "8000000" }], ...(spender ?? {}) }] };
  if (path === "/txs/bb/utxos") return { outputs: [{ address: VAULT, output_index: 0, amount: vaultOut ?? [] }] };
  return undefined;
};

describe("Minswap order status", () => {
  it("pending while the order sits unspent", async () => {
    expect(await orderStatus(chain(null), order)).toEqual({ status: "pending" });
  });
  it("filled when the batcher paid the vault at least the minimum", async () => {
    expect(await orderStatus(chain({ consumed_by_tx: "bb" }, [{ unit: "lovelace", quantity: "2000000" }, { unit: TOKEN, quantity: "950" }]), order)).toEqual({ status: "filled", tx: "bb", received: { lovelace: 2_000_000n, [TOKEN]: 950n } });
  });
  it("refunded when what came back is the input, not the output", async () => {
    expect(await orderStatus(chain({ consumed_by_tx: "bb" }, [{ unit: "lovelace", quantity: "7500000" }]), order)).toEqual({ status: "refunded", tx: "bb", received: { lovelace: 7_500_000n } });
  });
  it("unknown when the chain can't say", async () => {
    expect(await orderStatus(async () => undefined, order)).toEqual({ status: "unknown" });
  });
});

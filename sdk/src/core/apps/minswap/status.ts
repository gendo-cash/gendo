// Where a Minswap order stands, from Blockfrost-shaped chain reads (the server's /chain
// proxy for gendo-agent, Blockfrost or Yaci Store elsewhere). No Lucid.
type BfOut = { address: string; output_index: number; amount: { unit: string; quantity: string }[]; consumed_by_tx?: string | null };
export type Get = (path: string) => Promise<unknown | undefined>;

export type OrderStatus =
  | { status: "pending" }
  | { status: "filled" | "refunded"; tx: string; received: Record<string, bigint> }
  | { status: "unknown" };

export async function orderStatus(
  get: Get,
  o: { orderTx: string; orderAddress: string; vaultAddress: string; inUnit: string; outUnit: string; minimumReceive: bigint },
): Promise<OrderStatus> {
  const placed = (await get(`/txs/${o.orderTx}/utxos`)) as { outputs?: BfOut[] } | undefined;
  const out = placed?.outputs?.find((x) => x.address === o.orderAddress);
  if (!out) return { status: "unknown" };
  if (!out.consumed_by_tx) return { status: "pending" };
  const spent = (await get(`/txs/${out.consumed_by_tx}/utxos`)) as { outputs?: BfOut[] } | undefined;
  if (!spent?.outputs) return { status: "unknown" };
  const received: Record<string, bigint> = {};
  for (const x of spent.outputs.filter((y) => y.address === o.vaultAddress))
    for (const a of x.amount) received[a.unit] = (received[a.unit] ?? 0n) + BigInt(a.quantity);
  // A fill pays the bought asset (at least the minimum); a refund returns what was sold.
  const filled = (received[o.outUnit] ?? 0n) >= o.minimumReceive && (o.outUnit !== "lovelace" || !received[o.inUnit]);
  return { status: filled ? "filled" : "refunded", tx: out.consumed_by_tx, received };
}

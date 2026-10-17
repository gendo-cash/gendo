// The DeFi apps gendo supports. Being listed grants nothing: owners enable an app on
// their vault (its adapter and rules go into the vault's config, at threshold) and
// grant it per agent. To add an app, see "Adding an app" in the README.
import type { Network } from "@lucid-evolution/lucid";
import type { OutRef } from "../vault.js";

export type MinswapDeployment = {
  /** Minswap's authen policy: mints the pool auth token ("MSP") and LP tokens. */
  lpPolicy: string;
  poolScript: string;
  orderScript: string;
};

export type CatalogueNetwork = {
  deployment: MinswapDeployment;
  /** Where the pools live (payment part = poolScript). */
  poolAddress: string;
  /** Where orders are paid (orderScript's enterprise address). */
  orderAddress: string;
  /** The adapter's published reference script, once deployed. */
  adapterRef?: OutRef;
  pools: { lpName: string; label: string; assetA: string; assetB: string }[];
};

export type SettingField = { field: "pools" | "maxSlippageBps" | "maxBatcherFee" | "maxOrderTtlMs" | "maxCancelTip"; label: string; help: string };

export type CatalogueApp = {
  name: "minswap";
  title: string;
  summary: string;
  website: string;
  audits: { by: string; url: string }[];
  actions: "swap"[];
  /** Form text only. No defaults: owners choose every value. */
  settings: SettingField[];
  networks: Partial<Record<"Preprod" | "Custom", CatalogueNetwork>>;
};

const MINSWAP_ORDER_SCRIPT = "da9525463841173ad1230b1d5a1b5d0a3116bbdeb4412327148a1b7a";
/** Native script `all []`: anyone can mint. Devnet fixtures only. */
const DEVNET_POLICY = "d441227553a0f1a965fee7d60a0f724b368dd1bddbc208730fccebcf";
/** The vault's always-fail reference-script holder (ref_holder): devnet fixture pools sit there. */
const REF_HOLDER = "22c9a103ed3f2fa97c982d76d6e2af50c5d54ac306983b196c8fcdab";
const REF_HOLDER_DEVNET_ADDRESS = "addr_test1wq3vnggra5ljl2tunqkhd4hz4agvt422cvrfswcedj8um2cwsu3l3";

const MINSWAP: CatalogueApp = {
  name: "minswap",
  title: "Minswap",
  summary: "Swap tokens on Cardano's largest DEX. Orders are filled by Minswap's batchers; what comes back goes to the vault's treasury.",
  website: "https://minswap.org",
  audits: [
    { by: "CertiK", url: "https://github.com/minswap/minswap-dex-v2/tree/main/audit-report/certik" },
    { by: "Anastasia Labs", url: "https://github.com/minswap/minswap-dex-v2/tree/main/audit-report/anastasia-labs" },
  ],
  actions: ["swap"],
  settings: [
    { field: "pools", label: "Pools", help: "The only pools an agent may trade in. Any other pool is refused by the chain." },
    { field: "maxSlippageBps", label: "Max slippage", help: "Worst price an order may accept, below the pool's current price. The chain checks it against the pool itself." },
    { field: "maxBatcherFee", label: "Max batcher fee", help: "The most an order may pay Minswap's batchers. An order offering less than batchers accept never fills." },
    { field: "maxOrderTtlMs", label: "Order lifetime", help: "How long an order may wait for a batcher. After that, anyone can refund it to the vault." },
    { field: "maxCancelTip", label: "Cancel tip", help: "What an order may pay whoever refunds it after it expires. It comes out of the refund." },
  ],
  networks: {
    Preprod: {
      deployment: { lpPolicy: "d6aae2059baee188f74917493cf7637e679cd219bdfbbf4dcbeb1d0b", poolScript: "d6ba9b7509eac866288ff5072d2a18205ac56f744bc82dcd808cb8fe", orderScript: MINSWAP_ORDER_SCRIPT },
      poolAddress: "addr_test1zrtt4xm4p84vse3g3l6swtf2rqs943t0w39ustwdszxt3l5rajt8r8wqtygrfduwgukk73m5gcnplmztc5tl5ngy0upqhns793",
      orderAddress: "addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3",
      pools: [
        { lpName: "e5358cee5d14b83d0a4e93f321c0c3addaf8fb5010a1127b6da6a8adc0a16fd3", label: "ADA ↔ NACRE", assetA: "lovelace", assetB: "f9f812798ef9323119314c30f1ca5dd16e9eec5c116fa2c2e3a55b160014df104e41435245" },
        { lpName: "6c3ea488e6ff940bb6fb1b18fd605b5931d9fefde6440117015ba484cf321200", label: "ADA ↔ MIN", assetA: "lovelace", assetB: "e16c2dc8ae937e8d3790c7fd7168d7b994621ba14ca11415f39fed724d494e" },
        { lpName: "9e31ea789e7067d3ea0b557c6b088a896d21e4d88054d7c191d8cd06a8ea8398", label: "ADA ↔ tUSDM", assetA: "lovelace", assetB: "11c93226aabf1e9157620857d9ac013ba111680bd837f62a7ca902140014df10745553444d" },
      ],
    },
    Custom: {
      deployment: { lpPolicy: DEVNET_POLICY, poolScript: REF_HOLDER, orderScript: MINSWAP_ORDER_SCRIPT },
      poolAddress: REF_HOLDER_DEVNET_ADDRESS,
      orderAddress: "addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3",
      pools: [{ lpName: "860aadb43b75501995d896a52ce915b99d11cdce436b51ec079697ddd3841c8f", label: "ADA ↔ TEST", assetA: "lovelace", assetB: DEVNET_POLICY + "54455354" }],
    },
  },
};

export const catalogue = (): CatalogueApp[] => [MINSWAP];

/** An app and its deployment on `network`, or undefined where it isn't deployed. */
export function appFor(name: string, network: Network): { app: CatalogueApp; network: CatalogueNetwork } | undefined {
  const app = catalogue().find((a) => a.name === name);
  const n = app?.networks[network as "Preprod" | "Custom"];
  return app && n ? { app, network: n } : undefined;
}

/** A catalogue pool by LP asset name, on whichever network lists it (labels for reading history). */
export function poolByLp(lpName: string): { app: CatalogueApp; network: CatalogueNetwork; pool: CatalogueNetwork["pools"][number] } | undefined {
  for (const app of catalogue())
    for (const network of Object.values(app.networks)) {
      const pool = network?.pools.find((p) => p.lpName === lpName);
      if (pool && network) return { app, network, pool };
    }
  return undefined;
}

/** Whether `address` is where some catalogue app's orders are paid. */
export const isOrderAddress = (address: string) => catalogue().some((a) => Object.values(a.networks).some((n) => n?.orderAddress === address));

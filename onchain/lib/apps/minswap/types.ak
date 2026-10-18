//// Minswap V2 data types, vendored from minswap/minswap-dex-v2 at commit
//// c3293ad (lib/amm_dex_v2/types.ak), with imports moved to stdlib v4. The
//// adapter decodes real orders and pools with these, so their Data encodings
//// must stay identical to Minswap's: same constructors, same order, same
//// fields. Only the types the adapter reads are vendored.

use aiken/crypto.{ScriptHash}
use cardano/address.{Address, StakeCredential}
use cardano/assets.{AssetName, PolicyId}

pub type Asset {
  policy_id: PolicyId,
  asset_name: AssetName,
}

pub type SwapRouting {
  lp_asset: Asset,
  a_to_b_direction: Bool,
}

pub type SwapAmountOption {
  SAOSpecificAmount { swap_amount: Int }
  SAOAll { deducted_amount: Int }
}

pub type DepositAmountOption {
  DAOSpecificAmount { deposit_amount_a: Int, deposit_amount_b: Int }
  DAOAll { deducted_amount_a: Int, deducted_amount_b: Int }
}

pub type WithdrawAmountOption {
  WAOSpecificAmount { withdrawal_lp_amount: Int }
  WAOAll { deducted_amount_lp: Int }
}

pub type OrderStep {
  SwapExactIn {
    a_to_b_direction: Bool,
    swap_amount_option: SwapAmountOption,
    minimum_receive: Int,
    killable: Bool,
  }
  StopLoss {
    a_to_b_direction: Bool,
    swap_amount_option: SwapAmountOption,
    stop_loss_receive: Int,
  }
  OCO {
    a_to_b_direction: Bool,
    swap_amount_option: SwapAmountOption,
    minimum_receive: Int,
    stop_loss_receive: Int,
  }
  SwapExactOut {
    a_to_b_direction: Bool,
    maximum_swap_amount_option: SwapAmountOption,
    expected_receive: Int,
    killable: Bool,
  }
  Deposit {
    deposit_amount_option: DepositAmountOption,
    minimum_lp: Int,
    killable: Bool,
  }
  Withdraw {
    withdrawal_amount_option: WithdrawAmountOption,
    minimum_asset_a: Int,
    minimum_asset_b: Int,
    killable: Bool,
  }
  ZapOut {
    a_to_b_direction: Bool,
    withdrawal_amount_option: WithdrawAmountOption,
    minimum_receive: Int,
    killable: Bool,
  }
  PartialSwap {
    a_to_b_direction: Bool,
    total_swap_amount: Int,
    io_ratio_numerator: Int,
    io_ratio_denominator: Int,
    hops: Int,
    minimum_swap_amount_required: Int,
    max_batcher_fee_each_time: Int,
  }
  WithdrawImbalance {
    withdrawal_amount_option: WithdrawAmountOption,
    ratio_asset_a: Int,
    ratio_asset_b: Int,
    minimum_asset_a: Int,
    killable: Bool,
  }
  SwapMultiRouting {
    routings: List<SwapRouting>,
    swap_amount_option: SwapAmountOption,
    minimum_receive: Int,
  }
  Donation
}

pub type ExtraOrderDatum {
  EODNoDatum
  EODDatumHash { hash: ByteArray }
  EODInlineDatum { hash: ByteArray }
}

pub type OrderAuthorizationMethod {
  OAMSignature { pub_key_hash: ByteArray }
  OAMSpendScript { script_hash: ScriptHash }
  OAMWithdrawScript { script_hash: ScriptHash }
  OAMMintScript { script_hash: ScriptHash }
}

pub type OrderDatum {
  canceller: OrderAuthorizationMethod,
  refund_receiver: Address,
  refund_receiver_datum: ExtraOrderDatum,
  success_receiver: Address,
  success_receiver_datum: ExtraOrderDatum,
  lp_asset: Asset,
  step: OrderStep,
  max_batcher_fee: Int,
  expiry_setting_opt: Option<(Int, Int)>,
}

pub type PoolDatum {
  pool_batching_stake_credential: StakeCredential,
  asset_a: Asset,
  asset_b: Asset,
  total_liquidity: Int,
  reserve_a: Int,
  reserve_b: Int,
  base_fee_a_numerator: Int,
  base_fee_b_numerator: Int,
  fee_sharing_numerator_opt: Option<Int>,
  allow_dynamic_fee: Bool,
}

// ---------------------------------------------------------------------------
// Ours (not Minswap's)

/// Minswap's pool authentication token name ("MSP").
pub const pool_auth_name: ByteArray = #"4d5350"

/// Minswap's fee denominator (`default_fee_denominator`).
pub const fee_denominator: Int = 10000

pub const max_pools: Int = 8

pub const max_orders: Int = 3

/// 20%: the most slippage owners may allow.
pub const max_slippage: Int = 2000

/// Which pools the agent may trade in, as the owners chose.
pub type Pools {
  /// Only these, by LP asset name (the LP policy is the deployment's).
  OnlyPools(List<AssetName>)
  /// Any genuine Minswap pool. The price floor then reads a pool anyone can
  /// create, so a hijacked agent could lose its budget to a rigged one.
  AnyPool
}

/// The vault's rules for Minswap (`AppConfig.settings`), set by the owners.
pub type MinswapSettings {
  pools: Pools,
  max_slippage_bps: Int,
  max_batcher_fee: Int,
  max_order_ttl_ms: Int,
  max_cancel_tip: Int,
}

/// The Minswap deployment the adapter is compiled for.
pub type Deployment {
  /// Minswap's authen policy: it mints both the pool auth token and LP tokens.
  lp_policy: PolicyId,
  pool_script: ScriptHash,
  order_script: ScriptHash,
}

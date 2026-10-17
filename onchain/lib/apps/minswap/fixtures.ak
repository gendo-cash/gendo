//// Test-only: a valid Minswap placement as the SDK would build it. Each
//// adversarial test changes one aspect of it.

use aiken/collection/list
use aiken/interval.{Finite, Interval, IntervalBound}
use apps/minswap/math
use apps/minswap/types.{
  Asset, Deployment, EODNoDatum, MinswapSettings, OAMWithdrawScript,
  OrderDatum, PoolDatum, SAOSpecificAmount, SwapExactIn, pool_auth_name,
} as ms
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{Input, Output, Transaction, placeholder}
use vault/allowance_fixtures as afx
use vault/config.{canonical_address}
use vault/fixtures.{
  ada, cfg_2_of_3, config_input, out_ref, output, vault,
}
use vault/types.{AllowanceDatum, AppConfig, ConfigDatum}

pub const adapter: ByteArray = afx.adapter

pub const lp_policy: ByteArray =
  #"d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6d6"

pub const pool_script: ByteArray =
  #"2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e"

pub const token_policy: ByteArray =
  #"7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c"

/// The pool's real LP name: Minswap's `compute_lp_asset_name` of ADA and TOKEN.
pub const lp_name: ByteArray =
  #"885203bb4bf4466e72cb2e57d7f64b620e199d4e4c3dc0edebe4201936305605"

pub const other_lp: ByteArray = #"4c51"

pub const swap_amount: Int = 5_000_000

pub const batcher_fee: Int = 1_000_000

pub const reserve_a: Int = 1_000_000_000_000

pub const reserve_b: Int = 2_000_000_000_000

pub fn dep() -> Deployment {
  Deployment { lp_policy, pool_script, order_script: afx.order_script }
}

pub fn settings() -> MinswapSettings {
  MinswapSettings {
    pools: [other_lp, lp_name],
    max_slippage_bps: 300,
    max_batcher_fee: 2_000_000,
    max_order_ttl_ms: afx.hour,
    max_cancel_tip: 500_000,
  }
}

pub fn app(s: Data) -> AppConfig {
  AppConfig { name: "minswap", adapter, order_script: afx.order_script, settings: s }
}

pub fn upper() -> Int {
  afx.t0 + afx.hour + 10 * 60_000
}

pub fn fair(amount: Int, a_to_b: Bool) -> Int {
  if a_to_b {
    math.calculate_amount_out(reserve_a, reserve_b, amount, 30)
  } else {
    math.calculate_amount_out(reserve_b, reserve_a, amount, 30)
  }
}

/// The smallest minimum the floor accepts at 3% (ceiling division).
pub fn floor_min(amount: Int, a_to_b: Bool) -> Int {
  ( fair(amount, a_to_b) * 9700 + 9999 ) / 10000
}

pub fn order_datum() -> OrderDatum {
  OrderDatum {
    canceller: OAMWithdrawScript(adapter),
    refund_receiver: canonical_address(vault),
    refund_receiver_datum: EODNoDatum,
    success_receiver: canonical_address(vault),
    success_receiver_datum: EODNoDatum,
    lp_asset: Asset { policy_id: lp_policy, asset_name: lp_name },
    step: SwapExactIn {
      a_to_b_direction: True,
      swap_amount_option: SAOSpecificAmount(swap_amount),
      minimum_receive: floor_min(swap_amount, True),
      killable: True,
    },
    max_batcher_fee: batcher_fee,
    expiry_setting_opt: Some((upper() + afx.hour, 0)),
  }
}

pub fn order_value() -> assets.Assets {
  assets.from_lovelace(swap_amount + batcher_fee + 2_000_000)
}

pub fn order(d: OrderDatum) -> Output {
  output(afx.order_address(), order_value(), d)
}

pub fn pool_datum() -> PoolDatum {
  PoolDatum {
    pool_batching_stake_credential: Inline(Script(#"fbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfb")),
    asset_a: Asset { policy_id: #"", asset_name: #"" },
    asset_b: Asset { policy_id: token_policy, asset_name: "TOKEN" },
    total_liquidity: 1_000_000_000,
    reserve_a,
    reserve_b,
    base_fee_a_numerator: 30,
    base_fee_b_numerator: 30,
    fee_sharing_numerator_opt: None,
    allow_dynamic_fee: False,
  }
}

pub fn pool_address() -> Address {
  Address {
    payment_credential: Script(pool_script),
    stake_credential: Some(Inline(VerificationKey(afx.stake_y))),
  }
}

pub fn pool_value(lp: ByteArray) -> assets.Assets {
  ada(2)
    |> assets.merge(assets.from_asset(lp_policy, pool_auth_name, 1))
    |> assets.merge(assets.from_asset(lp_policy, lp, 9_000_000_000_000))
    |> assets.merge(assets.from_lovelace(reserve_a))
    |> assets.merge(assets.from_asset(token_policy, "TOKEN", reserve_b))
}

pub fn pool_input(lp: ByteArray, d: PoolDatum) -> Input {
  Input { output_reference: out_ref(500), output: output(pool_address(), pool_value(lp), d) }
}

pub type Case {
  settings: Data,
  /// Apps granted in the allowance datum.
  granted: List<ByteArray>,
  /// Apps enabled in the config.
  apps: List<AppConfig>,
  orders: List<Output>,
  pools: List<Input>,
  /// Extra inputs besides the allowance.
  extra_inputs: List<Input>,
  upper: Int,
}

pub fn case() -> Case {
  let s: Data = settings()
  Case {
    settings: s,
    granted: ["minswap"],
    apps: [app(s)],
    orders: [order(order_datum())],
    pools: [pool_input(lp_name, pool_datum())],
    extra_inputs: [],
    upper: upper(),
  }
}

pub fn with_order(f: fn(OrderDatum) -> OrderDatum) -> Case {
  Case { ..case(), orders: [order(f(order_datum()))] }
}

pub fn with_settings(s: MinswapSettings) -> Case {
  let d: Data = s
  Case { ..case(), settings: d, apps: [app(d)] }
}

pub fn allowance_input(granted: List<ByteArray>) -> Input {
  let d = AllowanceDatum { ..afx.base_datum(), apps: granted }
  afx.allowance_input(afx.Scenario { ..afx.default(), input_datum: d, typed: Some(d) })
}

pub fn build(c: Case) -> Transaction {
  Transaction {
    ..placeholder,
    inputs: list.concat(c.extra_inputs, [allowance_input(c.granted)]),
    reference_inputs: [config_input(ConfigDatum { ..cfg_2_of_3(), apps: c.apps }), ..c.pools],
    outputs: c.orders,
    withdrawals: [Pair(Script(adapter), 0)],
    validity_range: Interval {
      lower_bound: IntervalBound { bound_type: Finite(afx.t0 + afx.hour), is_inclusive: True },
      upper_bound: IntervalBound { bound_type: Finite(c.upper), is_inclusive: False },
    },
    extra_signatories: [fixtures.agent_key],
    fee: 300_000,
  }
}

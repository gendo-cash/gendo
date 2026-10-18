//// The Minswap adapter's check. It runs once per agent trade (a withdraw-
//// zero next to the vault's AgentTrade) and validates every order output
//// against the vault's settings for Minswap and the live pool.

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{ScriptHash}
use aiken/primitive/bytearray
use apps/minswap/math
use apps/minswap/types.{
  AnyPool, Deployment, EODNoDatum, MinswapSettings, OAMWithdrawScript,
  OnlyPools, OrderDatum, PoolDatum, SAOSpecificAmount, SwapExactIn,
  fee_denominator, max_orders, max_pools, max_slippage, pool_auth_name,
} as ms
use cardano/address.{Address, Script}
use cardano/assets.{AssetName}
use cardano/transaction.{InlineDatum, Input, Output, Transaction}
use aiken/interval.{Finite}
use vault/config.{canonical_address, find_config}
use vault/types.{AllowanceDatum}

pub fn place(own: ScriptHash, dep: Deployment, tx: Transaction) -> Bool {
  // The allowance: the tx's only input, at a vault address, holding exactly
  // one allowance token of that vault.
  expect [input] = tx.inputs
  expect Script(vault) = input.output.address.payment_credential
  // (The config UTxO holds one vault token too, but its datum never decodes
  // as an allowance: configs are validated whenever they're written.)
  expect [Pair(_token, 1)] =
    dict.to_pairs(assets.tokens(input.output.value, vault))
  expect InlineDatum(raw) = input.output.datum
  expect allowance: AllowanceDatum = raw
  // The vault's rules for this adapter, granted to this agent.
  let cfg = find_config(tx, vault)
  expect Some(app) = list.find(cfg.apps, fn(a) { a.adapter == own })
  expect list.has(allowance.apps, app.name)
  expect app.order_script == dep.order_script
  expect s: MinswapSettings = app.settings
  expect valid_settings(s)
  expect Finite(upper) = tx.validity_range.upper_bound.bound_type
  let home = canonical_address(vault)
  let order_address =
    Address { payment_credential: Script(dep.order_script), stake_credential: None }
  let orders =
    list.filter(
      tx.outputs,
      fn(o) { o.address.payment_credential == Script(dep.order_script) },
    )
  let n = list.length(orders)
  expect n >= 1 && n <= max_orders
  list.all(
    orders,
    fn(o) {
      o.address == order_address && valid_order(
        o,
        own,
        home,
        s,
        dep,
        upper,
        tx.reference_inputs,
      )
    },
  )
}

/// The two bounds owners can't set past: the pool list's length (it bounds
/// the cost of every check) and the slippage (past 100% the floor would be
/// no floor). Zero or negative values elsewhere only make every order fail
/// the per-order checks below.
fn valid_settings(s: MinswapSettings) -> Bool {
  and {
    when s.pools is {
      OnlyPools(lps) -> list.length(lps) <= max_pools
      AnyPool -> True
    },
    s.max_slippage_bps <= max_slippage,
  }
}

/// Whether the owners allow this pool. Either way, `genuine_pool` below
/// requires it to be a real Minswap pool.
fn allowed(pools: ms.Pools, lp: AssetName) -> Bool {
  when pools is {
    OnlyPools(lps) -> list.has(lps, lp)
    AnyPool -> True
  }
}

fn valid_order(
  o: Output,
  own: ScriptHash,
  home: Address,
  s: MinswapSettings,
  dep: Deployment,
  upper: Int,
  refs: List<Input>,
) -> Bool {
  expect o.reference_script == None
  expect InlineDatum(raw) = o.datum
  expect od: OrderDatum = raw
  // Only this adapter can cancel it, and everything comes back to the vault.
  expect od.canceller == OAMWithdrawScript(own)
  expect od.success_receiver == home
  expect od.refund_receiver == home
  expect od.success_receiver_datum == EODNoDatum
  expect od.refund_receiver_datum == EODNoDatum
  // A plain swap of a stated amount that cancels itself if the price misses.
  expect SwapExactIn {
    a_to_b_direction,
    swap_amount_option,
    minimum_receive,
    killable,
  } = od.step
  expect SAOSpecificAmount { swap_amount: amount } = swap_amount_option
  expect killable
  expect amount > 0
  // An allowed pool, a bounded batcher fee, a bounded lifetime and tip.
  expect od.lp_asset.policy_id == dep.lp_policy
  expect allowed(s.pools, od.lp_asset.asset_name)
  expect od.max_batcher_fee >= 0
  expect od.max_batcher_fee <= s.max_batcher_fee
  expect Some((expiry, tip)) = od.expiry_setting_opt
  expect expiry <= upper + s.max_order_ttl_ms
  expect tip >= 0
  expect tip <= s.max_cancel_tip
  let pool = genuine_pool(refs, dep, od.lp_asset.asset_name)
  let (asset_in, reserve_in, reserve_out, fee) =
    if a_to_b_direction {
      (pool.asset_a, pool.reserve_a, pool.reserve_b, pool.base_fee_a_numerator)
    } else {
      (pool.asset_b, pool.reserve_b, pool.reserve_a, pool.base_fee_b_numerator)
    }
  // Only lovelace and the swap's input asset ride along.
  let extra = assets.without_lovelace(o.value)
  expect
    if asset_in.policy_id == #"" {
      assets.is_zero(extra)
    } else {
      extra == assets.from_asset(
        asset_in.policy_id,
        asset_in.asset_name,
        assets.quantity_of(o.value, asset_in.policy_id, asset_in.asset_name),
      )
    }
  // The price floor: no worse than the pool's current price minus the
  // owners' slippage.
  let fair = math.calculate_amount_out(reserve_in, reserve_out, amount, fee)
  minimum_receive * fee_denominator >= fair * (
    fee_denominator - s.max_slippage_bps
  )
}

/// The order's pool: a reference input at Minswap's pool script holding the
/// pool auth token (only Minswap mints it) and the order's LP asset, whose
/// datum's two assets derive that LP name (Minswap's `compute_lp_asset_name`).
/// The last check matters: anyone can create a pool that holds another
/// pool's LP token as a reserve, and that pool's reserves say nothing about
/// the order's pool.
fn genuine_pool(refs: List<Input>, dep: Deployment, lp: AssetName) -> PoolDatum {
  expect Some(p) =
    list.find_map(
      refs,
      fn(i) {
        if and {
          i.output.address.payment_credential == Script(dep.pool_script),
          assets.quantity_of(i.output.value, dep.lp_policy, pool_auth_name) == 1,
          assets.quantity_of(i.output.value, dep.lp_policy, lp) > 0,
        } {
          expect InlineDatum(raw) = i.output.datum
          expect p: PoolDatum = raw
          if lp_name_of(p) == lp {
            Some(p)
          } else {
            None
          }
        } else {
          None
        }
      },
    )
  p
}

/// Minswap's `compute_lp_asset_name` (minswap-dex-v2@c3293ad utils.ak).
pub fn lp_name_of(p: PoolDatum) -> AssetName {
  let a = crypto.sha3_256(bytearray.concat(p.asset_a.policy_id, p.asset_a.asset_name))
  let b = crypto.sha3_256(bytearray.concat(p.asset_b.policy_id, p.asset_b.asset_name))
  crypto.sha3_256(bytearray.concat(a, b))
}

use apps/minswap/fixtures.{
  Case, adapter, case, dep, floor_min, lp_name, lp_policy, order, order_datum,
  order_value, pool_datum, pool_input, settings, swap_amount, token_policy,
  upper, with_order, with_settings,
} as mfx
use apps/minswap/place.{place}
use apps/minswap/place
use apps/minswap/types.{
  Asset, DAOSpecificAmount, Deposit, Donation, EODDatumHash, EODInlineDatum,
  MinswapSettings, OAMSignature, OAMSpendScript, OAMWithdrawScript, OrderDatum,
  PartialSwap, SAOAll, SAOSpecificAmount, StopLoss, SwapExactIn,
  SwapMultiRouting, pool_auth_name,
} as ms
use cardano/address.{Address, Inline, Script, VerificationKey}
use cardano/assets
use cardano/transaction.{DatumHash, Input, Output, Transaction}
use vault/allowance_fixtures as afx
use vault/types.{AppConfig}
use vault/fixtures.{ada, other_script, output, stranger, treasury_input, vault, wallet}

fn run(c: Case) -> Bool {
  place(adapter, dep(), mfx.build(c))
}

fn step(minimum: Int) -> ms.OrderStep {
  SwapExactIn {
    a_to_b_direction: True,
    swap_amount_option: SAOSpecificAmount(swap_amount),
    minimum_receive: minimum,
    killable: True,
  }
}

// ---------------------------------------------------------------------------
// Honest orders

test place_ok() {
  run(case())
}

test place_ok_two_orders() {
  run(Case { ..case(), orders: [order(order_datum()), order(order_datum())] })
}

test place_ok_three_orders() {
  let o = order(order_datum())
  run(Case { ..case(), orders: [o, o, o] })
}

test place_ok_b_to_a() {
  let amount = 4_000_000
  let d =
    OrderDatum {
      ..order_datum(),
      step: SwapExactIn {
        a_to_b_direction: False,
        swap_amount_option: SAOSpecificAmount(amount),
        minimum_receive: floor_min(amount, False),
        killable: True,
      },
    }
  let value = ada(3) |> assets.merge(assets.from_asset(token_policy, "TOKEN", amount))
  run(Case { ..case(), orders: [output(afx.order_address(), value, d)] })
}

test place_ok_above_floor() {
  run(with_order(fn(d) { OrderDatum { ..d, step: step(floor_min(swap_amount, True) + 1000) } }))
}

test place_ok_tip_at_max() {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: Some((upper() + afx.hour, 500_000)) } }))
}

// ---------------------------------------------------------------------------
// The price floor

test floor_one_below() {
  !run(with_order(fn(d) { OrderDatum { ..d, step: step(floor_min(swap_amount, True) - 1) } }))
}

test floor_minimum_one() {
  !run(with_order(fn(d) { OrderDatum { ..d, step: step(1) } }))
}

test floor_uses_the_pool_fee() {
  // A pool charging 1% instead of 0.3%: the honest minimum for 0.3% is now
  // above what the floor demands, so it still passes; a 3%-below-fair
  // minimum computed for a 0.3% pool passes too. A pool with 0 fee raises
  // the fair price: the 0.3%-floor minimum is then too low.
  let free = ms.PoolDatum { ..pool_datum(), base_fee_a_numerator: 0 }
  !run(Case { ..case(), pools: [pool_input(lp_name, free)] })
}

test floor_reserves_from_the_datum() {
  // Twice the output reserve: fair doubles, the old minimum is far below the floor.
  let rich = ms.PoolDatum { ..pool_datum(), reserve_b: 4_000_000_000_000 }
  !run(Case { ..case(), pools: [pool_input(lp_name, rich)] })
}

// ---------------------------------------------------------------------------
// Settings (owners' rules)

test settings_slippage_zero() fail {
  run(with_settings(MinswapSettings { ..settings(), max_slippage_bps: 0 }))
}

test settings_slippage_over_max() fail {
  run(with_settings(MinswapSettings { ..settings(), max_slippage_bps: 2001 }))
}

test settings_slippage_at_max_ok() {
  run(with_settings(MinswapSettings { ..settings(), max_slippage_bps: 2000 }))
}

test settings_no_pools() fail {
  run(with_settings(MinswapSettings { ..settings(), pools: [] }))
}

test settings_too_many_pools() fail {
  run(with_settings(MinswapSettings { ..settings(), pools: [#"01", #"02", #"03", #"04", #"05", #"06", #"07", #"08", lp_name] }))
}

test settings_fee_zero() fail {
  run(with_settings(MinswapSettings { ..settings(), max_batcher_fee: 0 }))
}

test settings_ttl_zero() fail {
  run(with_settings(MinswapSettings { ..settings(), max_order_ttl_ms: 0 }))
}

test settings_tip_negative() fail {
  run(with_settings(MinswapSettings { ..settings(), max_cancel_tip: -1 }))
}

test settings_garbage() fail {
  let junk: Data = "garbage"
  run(Case { ..case(), settings: junk, apps: [mfx.app(junk)] })
}

// ---------------------------------------------------------------------------
// Who can cancel, who receives

test canceller_signature() fail {
  run(with_order(fn(d) { OrderDatum { ..d, canceller: OAMSignature(stranger) } }))
}

test canceller_spend_script_vault() fail {
  run(with_order(fn(d) { OrderDatum { ..d, canceller: OAMSpendScript(vault) } }))
}

test canceller_other_withdraw() fail {
  run(with_order(fn(d) { OrderDatum { ..d, canceller: OAMWithdrawScript(other_script) } }))
}

test success_receiver_attacker() fail {
  run(with_order(fn(d) { OrderDatum { ..d, success_receiver: wallet(stranger) } }))
}

test refund_receiver_attacker() fail {
  run(with_order(fn(d) { OrderDatum { ..d, refund_receiver: wallet(stranger) } }))
}

test receiver_vault_with_stake_part() fail {
  run(with_order(fn(d) { OrderDatum { ..d, success_receiver: fixtures.script_address_with_stake(stranger) } }))
}

test success_receiver_datum() fail {
  run(with_order(fn(d) { OrderDatum { ..d, success_receiver_datum: EODInlineDatum(#"00") } }))
}

test refund_receiver_datum() fail {
  run(with_order(fn(d) { OrderDatum { ..d, refund_receiver_datum: EODDatumHash(#"00") } }))
}

// ---------------------------------------------------------------------------
// Steps

test step_stop_loss() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: StopLoss { a_to_b_direction: True, swap_amount_option: SAOSpecificAmount(swap_amount), stop_loss_receive: 1 } } }))
}

test step_donation() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: Donation } }))
}

test step_partial_swap() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: PartialSwap { a_to_b_direction: True, total_swap_amount: swap_amount, io_ratio_numerator: 1, io_ratio_denominator: 1, hops: 3, minimum_swap_amount_required: 1, max_batcher_fee_each_time: 1 } } }))
}

test step_multi_routing() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: SwapMultiRouting { routings: [], swap_amount_option: SAOSpecificAmount(swap_amount), minimum_receive: floor_min(swap_amount, True) } } }))
}

test step_deposit() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: Deposit { deposit_amount_option: DAOSpecificAmount(1, 1), minimum_lp: 1, killable: True } } }))
}

test step_sao_all() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: SwapExactIn { a_to_b_direction: True, swap_amount_option: SAOAll(0), minimum_receive: floor_min(swap_amount, True), killable: True } } }))
}

test step_not_killable() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: SwapExactIn { a_to_b_direction: True, swap_amount_option: SAOSpecificAmount(swap_amount), minimum_receive: floor_min(swap_amount, True), killable: False } } }))
}

test step_zero_amount() fail {
  run(with_order(fn(d) { OrderDatum { ..d, step: SwapExactIn { a_to_b_direction: True, swap_amount_option: SAOSpecificAmount(0), minimum_receive: 0, killable: True } } }))
}

// ---------------------------------------------------------------------------
// Pool, fee, expiry

test pool_not_listed() fail {
  let d = OrderDatum { ..order_datum(), lp_asset: Asset { policy_id: lp_policy, asset_name: #"4c59" } }
  run(Case { ..case(), orders: [order(d)], pools: [pool_input(#"4c59", pool_datum())] })
}

test lp_other_policy() fail {
  run(with_order(fn(d) { OrderDatum { ..d, lp_asset: Asset { policy_id: token_policy, asset_name: lp_name } } }))
}

test batcher_fee_over() fail {
  run(with_order(fn(d) { OrderDatum { ..d, max_batcher_fee: 2_000_001 } }))
}

test batcher_fee_negative() fail {
  run(with_order(fn(d) { OrderDatum { ..d, max_batcher_fee: -1 } }))
}

test no_expiry() fail {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: None } }))
}

test expiry_too_late() fail {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: Some((upper() + afx.hour + 1, 0)) } }))
}

test expiry_at_limit_ok() {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: Some((upper() + afx.hour, 0)) } }))
}

test tip_over() fail {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: Some((upper() + afx.hour, 500_001)) } }))
}

test tip_negative() fail {
  run(with_order(fn(d) { OrderDatum { ..d, expiry_setting_opt: Some((upper() + afx.hour, -1)) } }))
}

// ---------------------------------------------------------------------------
// The order output itself

test order_extra_token() fail {
  let value = order_value() |> assets.merge(assets.from_asset(token_policy, "JUNK", 1))
  run(Case { ..case(), orders: [output(afx.order_address(), value, order_datum())] })
}

test order_ref_script() fail {
  let o = order(order_datum())
  run(Case { ..case(), orders: [Output { ..o, reference_script: Some(other_script) }] })
}

test order_datum_hash() fail {
  let o = order(order_datum())
  run(Case { ..case(), orders: [Output { ..o, datum: DatumHash(#"00") }] })
}

test order_garbage_datum() fail {
  run(Case { ..case(), orders: [output(afx.order_address(), order_value(), "garbage")] })
}

test order_stake_part() {
  let o = order(order_datum())
  let staked = Address { payment_credential: Script(afx.order_script), stake_credential: Some(Inline(VerificationKey(stranger))) }
  !run(Case { ..case(), orders: [Output { ..o, address: staked }] })
}

test no_orders() fail {
  run(Case { ..case(), orders: [] })
}

test four_orders() fail {
  let o = order(order_datum())
  run(Case { ..case(), orders: [o, o, o, o] })
}

// ---------------------------------------------------------------------------
// The pool reference

test fake_pool_no_auth() fail {
  let i = pool_input(lp_name, pool_datum())
  let v = assets.merge(i.output.value, assets.from_asset(lp_policy, pool_auth_name, -1))
  run(Case { ..case(), pools: [Input { ..i, output: Output { ..i.output, value: v } }] })
}

test fake_pool_wrong_lp() fail {
  run(Case { ..case(), pools: [pool_input(#"4c51", pool_datum())] })
}

test fake_pool_wrong_address() fail {
  let i = pool_input(lp_name, pool_datum())
  let a = Address { payment_credential: Script(other_script), stake_credential: None }
  run(Case { ..case(), pools: [Input { ..i, output: Output { ..i.output, address: a } }] })
}

test fake_pool_first_genuine_second() {
  // A look-alike without the auth token is ignored; the genuine pool is used.
  let fake = pool_input(lp_name, ms.PoolDatum { ..pool_datum(), reserve_b: 1 })
  let v = assets.merge(fake.output.value, assets.from_asset(lp_policy, pool_auth_name, -1))
  run(Case { ..case(), pools: [Input { ..fake, output: Output { ..fake.output, value: v } }, pool_input(lp_name, pool_datum())] })
}

test no_pool_ref() fail {
  run(Case { ..case(), pools: [] })
}

// ---------------------------------------------------------------------------
// The allowance and the vault's app config

test two_inputs() fail {
  run(Case { ..case(), extra_inputs: [treasury_input(3, 10)] })
}

test input_not_allowance() fail {
  let c = case()
  let t = mfx.build(c)
  place(adapter, dep(), Transaction { ..t, inputs: [treasury_input(3, 10)] })
}

test app_not_granted() fail {
  run(Case { ..case(), granted: [] })
}

test app_not_in_config() fail {
  run(Case { ..case(), apps: [] })
}

test config_order_script_mismatch() fail {
  let s: Data = settings()
  run(Case { ..case(), apps: [types_app_other_order(s)] })
}

fn types_app_other_order(s: Data) -> AppConfig {
  AppConfig { name: "minswap", adapter, order_script: other_script, settings: s }
}

test other_adapter_in_config() fail {
  let s: Data = settings()
  run(Case { ..case(), apps: [AppConfig { ..mfx.app(s), adapter: other_script }] })
}

test two_inputs_allowance_first() fail {
  let c = case()
  let t = mfx.build(c)
  place(adapter, dep(), Transaction { ..t, inputs: [mfx.allowance_input(["minswap"]), treasury_input(3, 10)] })
}

test fake_pool_holding_the_order_lp_as_a_reserve() fail {
  // A real Minswap pool Y = ADA / LP_X holds the pool token and LP_X (as a
  // reserve), but its reserves say nothing about pool X: here they make the
  // fair price about zero, so a minimum of 1 would pass a floor read from Y.
  let lp_y = #"bd40e5238c6d2482ff52bb3f9c1a90d3524785484a1f4cdae0680f6ba453b9ee"
  let y =
    ms.PoolDatum {
      ..pool_datum(),
      asset_b: Asset { policy_id: lp_policy, asset_name: lp_name },
      reserve_a: 1_000_000_000_000_000,
      reserve_b: 1,
    }
  let value =
    ada(2)
      |> assets.merge(assets.from_asset(lp_policy, pool_auth_name, 1))
      |> assets.merge(assets.from_asset(lp_policy, lp_y, 1_000_000))
      |> assets.merge(assets.from_asset(lp_policy, lp_name, 1))
  let pool_y = Input { output_reference: fixtures.out_ref(501), output: output(mfx.pool_address(), value, y) }
  run(Case { ..with_order(fn(d) { OrderDatum { ..d, step: step(1) } }), pools: [pool_y] })
}

test genuine_pool_found_after_a_look_alike() {
  let lp_y = #"bd40e5238c6d2482ff52bb3f9c1a90d3524785484a1f4cdae0680f6ba453b9ee"
  let y = ms.PoolDatum { ..pool_datum(), asset_b: Asset { policy_id: lp_policy, asset_name: lp_name }, reserve_a: 1_000_000_000_000_000, reserve_b: 1 }
  let value =
    ada(2)
      |> assets.merge(assets.from_asset(lp_policy, pool_auth_name, 1))
      |> assets.merge(assets.from_asset(lp_policy, lp_y, 1_000_000))
      |> assets.merge(assets.from_asset(lp_policy, lp_name, 1))
  let pool_y = Input { output_reference: fixtures.out_ref(501), output: output(mfx.pool_address(), value, y) }
  run(Case { ..case(), pools: [pool_y, pool_input(lp_name, pool_datum())] })
}

test lp_name_matches_minswaps_vector() {
  // minswap-dex-v2@c3293ad utils.ak test_compute_lp_asset_name
  let p =
    ms.PoolDatum {
      ..pool_datum(),
      asset_a: Asset { policy_id: #"", asset_name: #"" },
      asset_b: Asset { policy_id: #"29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6", asset_name: #"4d494e" },
    }
  place.lp_name_of(p) == #"82e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75"
}

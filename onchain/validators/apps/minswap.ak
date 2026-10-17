use aiken/crypto.{ScriptHash}
use apps/minswap/fixtures as mfx
use apps/minswap/place
use apps/minswap/types.{Deployment, MinswapSettings}
use vault/fixtures
use vault/types.{AppConfig} as vt
use cardano/address.{Credential, Script}
use cardano/assets.{PolicyId}
use cardano/certificate.{
  AlwaysAbstain, Certificate, DelegateCredential, DelegateVote, RegisterCredential,
  UnregisterCredential,
}
use cardano/transaction.{Transaction, placeholder}

/// The Minswap adapter, one per network, parameterized by Minswap's
/// deployment. Vaults opt in by listing its hash in their config.
validator minswap(
  lp_policy: PolicyId,
  pool_script: ScriptHash,
  order_script: ScriptHash,
) {
  withdraw(_redeemer: Data, account: Credential, tx: Transaction) {
    expect Script(own) = account
    place.place(own, Deployment { lp_policy, pool_script, order_script }, tx)
  }

  /// Registration only, so withdraw-zero works. Nobody can unregister or
  /// delegate it, so nobody can switch trading off for every vault.
  publish(_redeemer: Data, certificate: Certificate, _tx: Transaction) {
    when certificate is {
      RegisterCredential { .. } -> True
      _ -> False
    }
  }

  else(_) {
    fail
  }
}

// ---------------------------------------------------------------------------
// Wiring through the compiled entry points.

test wiring_withdraw_ok() {
  let d = mfx.dep()
  minswap.withdraw(d.lp_policy, d.pool_script, d.order_script, Void, Script(mfx.adapter), mfx.build(mfx.case()))
}

test wiring_withdraw_other_deployment() fail {
  let d = mfx.dep()
  minswap.withdraw(d.lp_policy, d.pool_script, mfx.pool_script, Void, Script(mfx.adapter), mfx.build(mfx.case()))
}

test publish_register_ok() {
  let d = mfx.dep()
  minswap.publish(d.lp_policy, d.pool_script, d.order_script, Void, RegisterCredential { credential: Script(mfx.adapter), deposit: Never }, placeholder)
}

test publish_unregister_refused() {
  let d = mfx.dep()
  !minswap.publish(d.lp_policy, d.pool_script, d.order_script, Void, UnregisterCredential { credential: Script(mfx.adapter), refund: Never }, placeholder)
}

test publish_delegate_refused() {
  let d = mfx.dep()
  !minswap.publish(d.lp_policy, d.pool_script, d.order_script, Void, DelegateCredential { credential: Script(mfx.adapter), delegate: DelegateVote(AlwaysAbstain) }, placeholder)
}

// ---------------------------------------------------------------------------
// Budget at maximum sizes: 3 orders, 8 allowed pools with the traded one
// last, the config with 4 apps. scripts/budget.sh adds this to
// bench_agent_trade_max_sizes: both run in the same tx.

test bench_minswap_place_3_orders() {
  let d = mfx.dep()
  let s: Data =
    MinswapSettings {
      ..mfx.settings(),
      pools: [#"01", #"02", #"03", #"04", #"05", #"06", #"07", mfx.lp_name],
    }
  let other = fn(n: ByteArray, i: Int) { AppConfig { name: n, adapter: fixtures.key(140 + i), order_script: fixtures.key(150 + i), settings: Void } }
  let o = mfx.order(mfx.order_datum())
  let c =
    mfx.Case {
      ..mfx.case(),
      settings: s,
      granted: ["a", "b", "c", "minswap"],
      apps: [other("a", 0), other("b", 1), other("c", 2), mfx.app(s)],
      orders: [o, o, o],
    }
  minswap.withdraw(d.lp_policy, d.pool_script, d.order_script, Void, Script(mfx.adapter), mfx.build(c))
}

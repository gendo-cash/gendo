//// Golden CBOR for the SDK's encoders (sdk/test/unit/apps-data.test.ts).
//// Run `aiken check -m golden` and copy the traced hex.

use aiken/cbor
use aiken/primitive/bytearray
use apps/minswap/fixtures as mfx
use apps/minswap/types.{AnyPool, MinswapSettings} as mst
use vault/allowance_fixtures as afx
use vault/fixtures.{cfg_2_of_3}
use vault/types.{AgentTrade, AllowanceDatum, ConfigDatum, SpendRedeemer}

fn hex(label: String, d: Data) -> Bool {
  trace label: bytearray.to_hex(cbor.serialise(d))
  True
}

test golden_order() {
  hex(@"order", mfx.order_datum())
}

test golden_settings() {
  hex(@"settings", mfx.settings())
}

test golden_settings_any() {
  hex(@"settings_any", MinswapSettings { ..mfx.settings(), pools: AnyPool })
}

test golden_pool() {
  hex(@"pool", mfx.pool_datum())
}

test golden_config() {
  let s: Data = mfx.settings()
  hex(@"config", ConfigDatum { ..cfg_2_of_3(), apps: [mfx.app(s)] })
}

test golden_allowance() {
  hex(@"allowance", AllowanceDatum { ..afx.base_datum(), apps: ["minswap"] })
}

test golden_redeemer() {
  let r: SpendRedeemer = AgentTrade { intent_hash: afx.intent }
  hex(@"redeemer", r)
}

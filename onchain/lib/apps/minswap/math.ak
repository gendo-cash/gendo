//// Vendored from minswap/minswap-dex-v2 at commit c3293ad
//// (lib/amm_dex_v2/math.ak): the amount a swap-exact-in receives.

use apps/minswap/types.{fee_denominator}

/// Refer to Minswap's "formula.md", section "1. Swap Exact In".
pub fn calculate_amount_out(
  reserve_in: Int,
  reserve_out: Int,
  amount_in: Int,
  trading_fee_numerator: Int,
) -> Int {
  let diff = fee_denominator - trading_fee_numerator
  let in_with_fee = diff * amount_in
  let numerator = in_with_fee * reserve_out
  let denominator = fee_denominator * reserve_in + in_with_fee
  numerator / denominator
}

test test_calculate_amount_out() {
  let out =
    calculate_amount_out(
      reserve_in: 25434557769208,
      reserve_out: 413300185707175,
      amount_in: 1000000000,
      trading_fee_numerator: 30,
    )
  out == 16200168971
}

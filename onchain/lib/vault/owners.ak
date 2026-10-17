use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use vault/multisig.{AtLeast, Signature}
use vault/types.{AppConfig, ConfigDatum, max_apps, max_owners}

/// Owner-set invariants (edge D5). Checked on-chain whenever a config datum
/// is written (init and every config update), so a config read from the
/// config NFT's UTxO is always valid.
pub fn is_valid_config(cfg: ConfigDatum) -> Bool {
  let n = list.length(cfg.owners)
  let app_names = list.map(cfg.apps, fn(a) { a.name })
  // `n >= 1` is implied by `1 <= threshold <= n`.
  and {
    n <= max_owners,
    cfg.threshold >= 1,
    cfg.threshold <= n,
    list.all(cfg.owners, fn(k) { bytearray.length(k) == 28 }),
    list.unique(cfg.owners) == cfg.owners,
    cfg.max_tx_validity_ms > 0,
    list.length(cfg.apps) <= max_apps,
    list.all(cfg.apps, is_valid_app),
    list.unique(app_names) == app_names,
  }
}

/// An app entry's shape. Its `settings` are checked by its adapter, which
/// refuses every order while they're malformed.
fn is_valid_app(a: AppConfig) -> Bool {
  let len = bytearray.length(a.name)
  and {
    len >= 1,
    len <= 32,
    bytearray.length(a.adapter) == 28,
    bytearray.length(a.order_script) == 28,
  }
}

/// True when at least `threshold` distinct owners signed the tx.
pub fn threshold_met(
  cfg: ConfigDatum,
  signatories: List<VerificationKeyHash>,
) -> Bool {
  multisig.satisfied(
    AtLeast {
      required: cfg.threshold,
      scripts: list.map(cfg.owners, fn(k) { Signature(k) }),
    },
    signatories,
  )
}

use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

/// Upper bounds on every list the validator walks. They keep the worst-case
/// execution budget of every path far below the per-tx limit (edge D3).
pub const max_owners: Int = 10

pub const max_destinations: Int = 10

pub const max_assets: Int = 5

pub const max_apps: Int = 4

/// Token name of the vault's one-shot config NFT. Allowance token names are
/// 28-byte hashes, so they can never collide with it.
pub const config_token_name: ByteArray = "config"

/// The owner set and global switches. Lives in the single UTxO holding the
/// config NFT at the vault's canonical address, and is read as a reference
/// input by every non-config path.
pub type ConfigDatum {
  owners: List<VerificationKeyHash>,
  threshold: Int,
  paused: Bool,
  /// Upper bound on a tx validity interval for any agent path. Limits how
  /// long a signed-but-unsubmitted tx stays valid (edge O3).
  max_tx_validity_ms: Int,
  /// The DeFi apps this vault has enabled, each with its own rules.
  apps: List<AppConfig>,
}

/// One DeFi app a vault has enabled. `settings` is app-specific and decoded
/// only by that app's adapter; the core never reads it.
pub type AppConfig {
  /// Catalogue id, e.g. "minswap". Unique within `ConfigDatum.apps`.
  name: ByteArray,
  /// The adapter whose withdraw-zero must be in every trade using this app.
  adapter: ScriptHash,
  /// The protocol script orders are paid to, at its enterprise address.
  order_script: ScriptHash,
  settings: Data,
}

/// Per-asset limits. Lovelace is (#"", #"").
pub type AssetCap {
  policy: PolicyId,
  name: AssetName,
  window_cap: Int,
  tx_cap: Int,
}

/// State of one agent's allowance. Lives next to exactly one allowance
/// token at the vault's canonical address.
pub type AllowanceDatum {
  agent: VerificationKeyHash,
  /// Exact full addresses (payment and stake part).
  destinations: List<Address>,
  caps: List<AssetCap>,
  /// Amount spent in the current window, parallel to `caps`.
  spent: List<Int>,
  window_start: Int,
  period_ms: Int,
  expires_at: Int,
  max_fee: Int,
  /// Names of apps in `ConfigDatum.apps` this agent may trade with. A name
  /// the config lacks grants nothing.
  apps: List<ByteArray>,
}

pub type SpendRedeemer {
  /// Agent alone, within limits.
  AgentSpend { intent_hash: ByteArray }
  /// Agent plus owner threshold in the same tx, beyond limits.
  CoSignedSpend { intent_hash: ByteArray }
  /// Owner threshold alone: treasury moves, config updates, allowance
  /// edits and reclaims. Never decodes an allowance datum.
  OwnerManage
}

pub type MintRedeemer {
  InitConfig
  ManageAllowances
}

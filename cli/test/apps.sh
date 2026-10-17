#!/usr/bin/env bash
# CLI apps on the local devnet: owners enable Minswap and grant it; the agent swaps; refusals.
# Requires: scripts/devnet.sh up (runs scripts/devnet-apps.sh itself).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export VAULT_NETWORK=Custom
export VAULT_HOME="$(mktemp -d)"
V="$ROOT/cli/vault"
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
STORE=http://localhost:8080/api/v1
ORDER=addr_test1wrdf2f2x8pq3wwk3yv936ksmt59rz94mm66yzge8zj9pk7s0kjph3
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
j() { jq -r "$1"; }
addr() { $V keys show "$1" | j .address; }
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do n=$(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0'); [[ "$n" -gt 0 ]] && return 0; sleep 1; done
}
first_json() { local x; x=$(cat); echo "$x" | head -n "$(echo "$x" | grep -n '^}' | head -1 | cut -d: -f1)"; }

"$ROOT/scripts/devnet-apps.sh" >/dev/null && ok "devnet Minswap stand-in ready"
for k in a b c agent payee; do $V keys gen $k >/dev/null; done
topup "$(addr a)" 1000; topup "$(addr b)" 50; topup "$(addr agent)" 10
$V vault create --owners a,b,c --threshold 2 --max-validity 2m --payer a >/dev/null
$V treasury fund --ada 200 --payer a >/dev/null
ok "vault 2-of-3, treasury 200 ADA"

$V app enable minswap --pools 4c50 --slippage 3 --fee 2 --order-ttl 1h --tip 0.5 --propose a --sign a,b >/dev/null
[[ $($V app list | j '.[0].name') == "minswap" && $($V app list | j '.[0].settings.maxSlippageBps') == "300" ]] && ok "owners enabled Minswap (3% slippage)" || fail "app enable"
if $V app enable minswap --pools 4c50 --slippage 3 --fee 2 --order-ttl 1h --propose a --sign a,b >/dev/null 2>&1; then fail "enable without --tip should refuse (no defaults)"; else ok "every app flag is required: no defaults"; fi

grant=$($V allowance grant --agent agent --dest "$(addr payee)" --cap lovelace:40:20 --fund 50 --from-treasury --apps minswap --propose a --sign a,b)
UNIT=$(echo "$grant" | first_json | j .allowance)
[[ -n "$UNIT" && "$UNIT" != null ]] && ok "granted the agent Minswap" || fail "grant: $grant"

r=$($V agent swap "$UNIT" --pool 4c50 --ada 3 --intent-id S-1 --purpose "test swap" --agent agent)
[[ $(echo "$r" | j .submitted) =~ ^[0-9a-f]{64}$ ]] && ok "agent placed a 3 ADA swap" || fail "swap: $r"
for _ in $(seq 1 30); do n=$(curl -s "$STORE/addresses/$ORDER/utxos" | jq 'length? // 0'); [[ "$n" -gt 0 ]] && break; sleep 1; done
[[ "$n" -gt 0 ]] && ok "the order sits at Minswap's order address" || fail "no order on chain"

r=$($V agent swap "$UNIT" --pool 4c51 --ada 1 --intent-id S-2 --purpose x --agent agent || true)
[[ $(echo "$r" | j .blocked) == "APP" ]] && ok "a pool the vault doesn't allow is blocked" || fail "unlisted pool: $r"

$V app disable minswap --propose a --sign a,b >/dev/null
r=$($V agent swap "$UNIT" --pool 4c50 --ada 1 --intent-id S-3 --purpose x --agent agent || true)
[[ $(echo "$r" | j .blocked) == "APP" ]] && ok "after the owners disable Minswap, swaps are blocked" || fail "disabled: $r"
echo "PASS"

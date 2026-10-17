#!/usr/bin/env bash
# app/test/owner-e2e.sh: the owner app on the devnet, two owners in two headless browsers.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/cli/vault"
export VAULT_NETWORK=Custom
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
STORE=${BLOCKFROST_URL:-http://localhost:8080/api/v1}
T="$(mktemp -d)"; export VAULT_HOME=$T/owners
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do [[ $(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0') -gt 0 ]] && return 0; sleep 1; done
}
for _ in $(seq 1 120); do [[ $(curl -s "$STORE/blocks/latest" | jq '.slot // 0') -ge 90 ]] && break; sleep 1; done
for k in a b agent payee; do $V keys gen $k >/dev/null; done
for k in a b; do topup "$($V keys show $k | jq -r .address)" 500; done
$V vault create --owners a,b --threshold 2 --max-validity 2m --payer a >/dev/null
$V treasury fund --ada 100 --payer a >/dev/null
UNIT=$($V allowance grant --agent agent --dest "$($V keys show payee | jq -r .address)" --cap lovelace:25:10 --fund 40 --from-treasury --propose a --sign a,b | jq -rs '.[0].allowance')
POLICY=$($V vault info | jq -r .policy); VAULT_ID=$($V vault info | jq -r .id)
echo "  ok  devnet vault ${POLICY:0:16}… (2 of 2), one agent"
# A test build (with the test wallet) goes to its own folder: never into app/dist.
(cd "$ROOT/app" && VITE_NETWORK=Custom VITE_TEST_WALLETS=1 npx vite build --outDir "$T/dist" --emptyOutDir >/dev/null)
BLOCKFROST_URL=$STORE BLOCKFROST_PROJECT_ID=devnet VAULT_NETWORK=Custom DB=$T/db.sqlite STATIC_DIR="$T/dist" PORT=8796 "$ROOT/server/gendo-server" 2>"$T/server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:8796/ && break; sleep 1; done
APP=http://localhost:8796 ADDR_B=$($V keys show b | jq -r .address) VAULT_ID=$VAULT_ID POLICY=$POLICY UNIT=$UNIT KEY_A=$(cat "$VAULT_HOME/keys/a.sk") KEY_B=$(cat "$VAULT_HOME/keys/b.sk") \
  node "$ROOT/app/test/owner-e2e.mjs"
# Connect an agent with no terminal: pairing code, gendo-agent over stdio, confirm words, budget, first payment,
# then a Minswap swap (devnet stand-in: fixture pool, adapter registered).
"$ROOT/scripts/devnet-apps.sh" >/dev/null
"$ROOT/gendo-agent/build.sh"
APP=http://localhost:8796 POLICY=$POLICY KEY_A=$(cat "$VAULT_HOME/keys/a.sk") KEY_B=$(cat "$VAULT_HOME/keys/b.sk") \
  PAYEE=$($V keys show payee | jq -r .address) AGENT_MAIN="$ROOT/gendo-agent/dist/main.mjs" \
  node "$ROOT/app/test/agent-e2e.mjs"

#!/usr/bin/env bash
# MCP server end to end on the devnet. Owners, signer and agent each get their
# own VAULT_HOME, as in the skill. An MCP client drives the agent's tools,
# then the owners sign the approval file the agent produced.
# Requires: scripts/devnet.sh up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
V="$ROOT/cli/vault"
export VAULT_NETWORK=Custom
ADMIN=${YACI_ADMIN:-http://localhost:10000/local-cluster/api}
STORE=${BLOCKFROST_URL:-http://localhost:8080/api/v1}
T="$(mktemp -d)"; OWN=$T/owners; SIG=$T/signer; AG=$T/agent
as() { local h=$1; shift; VAULT_HOME=$h "$V" "$@"; }
ok() { echo "  ok  $*"; }
fail() { echo "  FAIL $*"; exit 1; }
topup() {
  for _ in $(seq 1 30); do curl -sf -X POST "$ADMIN/addresses/topup" -H 'content-type: application/json' -d "{\"address\":\"$1\",\"adaAmount\":$2}" >/dev/null && break; sleep 2; done
  for _ in $(seq 1 60); do [[ $(curl -s "$STORE/addresses/$1/utxos" | jq 'length? // 0') -gt 0 ]] && return 0; sleep 1; done
}
received() { curl -s "$STORE/addresses/$1/utxos?count=100" | jq "[.[]? | select(.amount[]? | .unit == \"lovelace\" and .quantity == \"$2\")] | length"; }

echo "== setup (owners a,b 2-of-2 in one home for brevity; signer and agent apart)"
AGENT=$(as $SIG keys gen agent)
for k in a b payee stranger; do as $OWN keys gen $k >/dev/null; done
topup "$(jq -r .address <<<"$AGENT")" 10; topup "$(as $OWN keys show a | jq -r .address)" 1000
as $OWN vault create --owners a,b --threshold 2 --max-validity 2m --payer a >/dev/null  # devnet horizon is minutes
as $OWN treasury fund --ada 200 --payer a >/dev/null
PAYEE=$(as $OWN keys show payee | jq -r .address); STRANGER=$(as $OWN keys show stranger | jq -r .address)
UNIT=$(as $OWN allowance grant --agent "$(jq -r .pkh <<<"$AGENT")" --dest "$PAYEE" --cap lovelace:20:10 --fund 60 \
  --from-treasury --propose a --sign a,b | jq -rs '.[0].allowance')
ID=$(as $OWN vault info | jq -r .id)
as $SIG vault join "$ID" >/dev/null; as $AG vault join "$ID" >/dev/null
SOCK=$SIG/signer.sock
VAULT_HOME=$SIG "$V" signer start --key agent --allowance "$UNIT" --dest "$PAYEE" --socket $SOCK 2>$SIG/signer.log &
SPID=$!; trap 'kill $SPID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do [[ -S $SOCK ]] && break; sleep 1; done
[[ ! -d $AG/keys ]] || fail "agent home has keys"
ok "vault, allowance and signer ready; the agent's home has no keys"

echo "== the agent, through MCP"
OUT=$(VAULT_HOME=$AG "$ROOT/sdk/node_modules/.bin/tsx" "$ROOT/mcp/test/client.ts" "$UNIT" "$SOCK" "$PAYEE" "$STRANGER" 2>$T/mcp.log) \
  || { echo "$OUT"; tail -20 $T/mcp.log; fail "MCP client"; }
grep -v '^FILE ' <<<"$OUT"
grep -q FAIL <<<"$OUT" && exit 1
F=$(grep '^FILE ' <<<"$OUT" | cut -d' ' -f2-)

echo "== owners approve the agent's request"
as $SIG tx witness "$F" --key agent --out $T/agent.wit >/dev/null
as $OWN tx witness "$F" --key a --out $T/a.wit >/dev/null
as $OWN tx witness "$F" --key b --out $T/b.wit >/dev/null
as $OWN tx assemble "$F" $T/agent.wit $T/a.wit $T/b.wit >/dev/null
[[ $(received "$PAYEE" 12000000) == 1 ]] && ok "owners signed the approval file; payee got 12 ADA" || fail "approved payment missing"
echo PASS

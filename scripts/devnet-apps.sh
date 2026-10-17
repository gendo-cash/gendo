#!/usr/bin/env bash
# Devnet stand-in for Minswap: fixture pool, adapter and expired-cancel stake registrations. Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/sdk" && VAULT_NETWORK=Custom npx tsx scripts/devnet-apps.ts

#!/usr/bin/env bash
# Fails when the Drizzle schema has changes that no migration records. It
# generates against a copy of the migrations, so nothing is written here.
set -euo pipefail
cd "$(dirname "$0")/../apps/server"
copy=$(mktemp -d)
trap 'rm -rf "$copy"' EXIT
cp -R drizzle/migrations/. "$copy"
output=$(pnpm exec drizzle-kit generate --dialect postgresql --schema src/db/schema/index.ts --out "$copy" 2>&1)
if ! grep -q "No schema changes" <<<"$output"; then
  echo "$output" >&2
  echo "The schema has changes without a migration: run \`mise run db:generate\`." >&2
  exit 1
fi

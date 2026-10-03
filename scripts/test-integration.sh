#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
container=$(docker run --rm -d -e POSTGRES_USER=heveta -e POSTGRES_PASSWORD=heveta-test -e POSTGRES_DB=heveta -p 127.0.0.1::5432 postgres:18-alpine)
trap 'docker rm -f "$container" >/dev/null' EXIT
# Over TCP: while the image initializes the database, a temporary server
# answers on the Unix socket only, then restarts.
ready=false
for attempt in {1..30}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U heveta >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then echo "PostgreSQL did not start" >&2; exit 1; fi
port=$(docker port "$container" 5432/tcp | cut -d: -f2)
export TEST_DATABASE_URL="postgresql://heveta:heveta-test@127.0.0.1:$port/heveta"
pnpm --filter @heveta/server exec vitest run test/integration.test.ts

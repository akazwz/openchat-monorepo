import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// node-postgres, the driver Hyperdrive recommends. It sends a query with its
// parameters in one round trip (Parse, Bind, Execute together); Postgres.js
// first asks for the parameter types of every statement new to its
// connection, and each request's connection is new, so each query took two.
// Up to five connections, the Workers limit Hyperdrive's guide works within;
// a transaction holds one of them.
export function createDatabase() {
	const pool = new Pool({
		connectionString: env.HYPERDRIVE.connectionString,
		max: 5,
	});
	return {
		db: drizzle({ client: pool }),
		close: () => pool.end(),
	};
}

export type Database = Omit<ReturnType<typeof createDatabase>["db"], "$client">;

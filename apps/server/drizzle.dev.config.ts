import { defineConfig } from "drizzle-kit";

export const localDatabaseUrl =
	"postgresql://heveta:password_123456@127.0.0.1:55437/heveta";

export default defineConfig({
	dialect: "postgresql",
	schema: "src/db/schema/index.ts",
	out: "drizzle/migrations",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? localDatabaseUrl,
	},
});

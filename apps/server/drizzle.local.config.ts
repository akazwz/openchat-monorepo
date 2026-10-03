import config, { localDatabaseUrl } from "./drizzle.dev.config";

// Automatic development setup only migrates the repository's local database.
// DATABASE_URL remains available to the explicit db:migrate task.
export default {
	...config,
	dbCredentials: { url: localDatabaseUrl },
};

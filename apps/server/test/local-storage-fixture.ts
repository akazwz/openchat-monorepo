import { DatabaseSync } from "node:sqlite";

// Real SQLite statements/transactions; only Cloudflare's durability and alarm
// wrappers are replaced. The same fixture can outlive an actor instance.
export function localStorageFixture() {
	const sqlite = new DatabaseSync(":memory:");
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const metrics = {
		contentBytes: 0,
		syncs: 0,
		statements: 0,
		maxBlockBytes: 0,
	};
	const storage = {
		sql: {
			exec(query: string, ...bindings: (string | number | null)[]) {
				metrics.statements++;
				if (/INSERT INTO (part_chunks|native_chunks)/.test(query)) {
					const size = Buffer.byteLength(String(bindings.at(-1)));
					metrics.contentBytes += size;
					metrics.maxBlockBytes = Math.max(metrics.maxBlockBytes, size);
				}
				const statement = sqlite.prepare(query);
				return statement.columns().length
					? statement.all(...bindings)
					: (statement.run(...bindings), []);
			},
		},
		transactionSync<T>(fn: () => T): T {
			sqlite.exec("BEGIN");
			try {
				const result = fn();
				sqlite.exec("COMMIT");
				return result;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
		async sync() {
			metrics.syncs++;
		},
		async get(key: string) {
			return values.get(key);
		},
		async put(key: string, value: unknown) {
			values.set(key, value);
		},
		async getAlarm() {
			return alarm;
		},
		async setAlarm(at: number) {
			alarm = at;
		},
		async deleteAlarm() {
			alarm = null;
		},
		async deleteAll() {
			values.clear();
			for (const row of sqlite
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all())
				sqlite.exec(`DROP TABLE "${row.name}"`);
		},
		async transaction<T>(fn: (value: unknown) => Promise<T>) {
			return fn(storage);
		},
	};
	return {
		storage: storage as unknown as DurableObjectStorage,
		sqlite,
		metrics,
		alarm: () => alarm,
		close: () => sqlite.close(),
	};
}

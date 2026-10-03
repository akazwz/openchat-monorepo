// Temporary authenticated Worker: prepares existing computers before the
// native-only deployment, then moves their snapshot handles from R2 to DO
// storage. It never deletes archives. See docs/sandbox.md for the sequence.
import { inArray } from "drizzle-orm";

import { createDatabase } from "../src/db/client";
import { runs } from "../src/db/schema/runs";
import { users } from "../src/db/schema/users";
import { RunStatus } from "../src/modules/runs/types";
import type { Computer } from "../src/modules/sandbox/computer-object";
import type { Filesystem } from "../src/modules/sandbox/filesystem";

interface MigrationEnv {
	MIGRATION_TOKEN: string;
	BACKUP_BUCKET: R2Bucket;
	COMPUTER: DurableObjectNamespace<Computer>;
	HYPERDRIVE: Hyperdrive;
}

export default {
	async fetch(request, env) {
		if (
			!env.MIGRATION_TOKEN ||
			request.headers.get("Authorization") !== `Bearer ${env.MIGRATION_TOKEN}`
		)
			return new Response("Forbidden", { status: 403 });
		const action = new URL(request.url).pathname;
		if (
			request.method !== "POST" ||
			(action !== "/prepare" && action !== "/migrate")
		)
			return new Response("Not found", { status: 404 });
		const database = createDatabase();
		try {
			const active = await database.db
				.select({ id: runs.id })
				.from(runs)
				.where(inArray(runs.status, [RunStatus.QUEUED, RunStatus.RUNNING]));
			if (active.length)
				return Response.json({ active: active.length }, { status: 409 });
			const accounts = await database.db.select({ id: users.id }).from(users);
			let migrated = 0;
			let omitted = 0;
			for (const account of accounts) {
				const computer = env.COMPUTER.getByName(`user-${account.id}`);
				if (action === "/prepare") {
					const generation = await computer.ready();
					if (
						(await computer.save(generation)) !== "saved" ||
						(await computer.restart(false)) !== "done"
					)
						throw new Error("Cannot checkpoint and stop an existing computer");
					continue;
				}
				const pending = await computer.migrateSnapshots();
				const records: Record<string, Filesystem | null> = {};
				for (const id of pending.ids) {
					const meta = await env.BACKUP_BUCKET.get(`backups/${id}.json`);
					if (!meta) throw new Error(`Missing legacy checkpoint ${id}`);
					const record = await meta.json<{ filesystem?: Filesystem }>();
					records[id] = record.filesystem ?? null;
					if (record.filesystem) migrated++;
					else omitted++;
				}
				await computer.migrateSnapshots(records);
				if ((await computer.migrateSnapshots()).ids.length)
					throw new Error("Snapshot migration did not finish");
			}
			return Response.json({ users: accounts.length, migrated, omitted });
		} finally {
			await database.close();
		}
	},
} satisfies ExportedHandler<MigrationEnv>;

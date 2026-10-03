import { mkdtemp, rm } from "node:fs/promises";
// Workerd smoke test for native DO SQLite durability and bounded body rows.
// PostgreSQL controls are local stand-ins; the integration suite exercises PG.
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const taskRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverRequire = createRequire(join(taskRoot, "apps/server/package.json"));
const wranglerRequire = createRequire(
	serverRequire.resolve("wrangler/package.json"),
);
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const directory = await mkdtemp(join(tmpdir(), "openchat-native-sqlite-"));
const bundle = await build({
	stdin: {
		contents: `
import { DurableObject } from 'cloudflare:workers';
import { LocalRunStorage } from '${taskRoot}/apps/server/src/modules/runs/local-storage.ts';
import { sliceText } from '${taskRoot}/apps/server/src/modules/threads/text-source.ts';
export class Probe extends DurableObject {
 get local() { return this._local ??= new LocalRunStorage(this.ctx.storage); }
 async fetch(request) {
  const op = new URL(request.url).pathname;
  if (op === '/init') {
   const at = new Date('2026-09-01T00:00:00Z');
   const run = { id:'run',threadId:'thread',turnId:'turn',userId:'owner',requestId:'request',requestHash:'hash',attempt:1,model:'model',reasoningEffort:null,revision:1,status:2,error:'',cancelRequested:false,createdAt:at,startedAt:at,finishedAt:null };
   const message = (role) => ({ id:role,threadId:'thread',turnId:'turn',runId:role==='user'?null:'run',role,parts:[],createdAt:at,updatedAt:at });
   await this.local.initialize(run,message('user'),message('assistant'));
   await this.local.save({}, { id:crypto.randomUUID(),run,changes:[{type:'part',part:{id:'text',content:{case:'text',value:''}}}],checkpoint:{version:4,phase:'ready',messages:[{role:'user',content:'go'}],lastStepIndex:0},final:false });
  }
  if (op === '/append') {
   for (let i=0;i<100;i++) await this.local.save({}, {id:crypto.randomUUID(),run:this.local.state().run,changes:[{type:'textDelta',partId:'text',text:'中😀'.repeat(4000)}],final:false});
   const checkpoint = this.local.checkpoint();
   await this.local.save({}, {id:crypto.randomUUID(),run:this.local.state().run,changes:[],checkpoint:{...checkpoint,messages:[...checkpoint.messages,{type:'reasoning',id:'opaque',summary:[],encrypted_content:'opaque'.repeat(100000)}]},final:false});
  }
  const state = this.local.state();
  if (!state) return Response.json({error:"no state",op});
  const metric = this.ctx.storage.sql.exec('SELECT count(*) AS chunks,sum(length(cast(data AS BLOB))) AS bytes,max(length(cast(data AS BLOB))) AS maxBlock FROM part_chunks').one();
  return Response.json({revision:state.run.revision,commitSeq:state.commitSeq,context:this.local.checkpoint().messages.map(item=>({type:item.type,content:item.content,encryptedLength:item.encrypted_content?.length})),head:this.local.partsPage(state.commitSeq)[0],old:this.local.bodyPage(this.local.partsPage(1)[0]).length,window:sliceText(this.local.textChunks(),16001,4000),metric});
 }
}
export default { async fetch(request,env) { return env.PROBES.getByName('same-run').fetch(request); } };
`,
		resolveDir: join(taskRoot, "apps/server"),
		loader: "ts",
	},
	bundle: true,
	write: false,
	format: "esm",
	platform: "browser",
	target: "es2022",
	alias: { "@": join(taskRoot, "apps/server/src") },
	external: ["cloudflare:workers"],
	plugins: [
		{
			name: "pg-test-controls",
			setup(build) {
				build.onResolve({ filter: /queries|archive|lifecycle/ }, (args) => {
					if (
						(args.path === "./queries" &&
							args.resolveDir.endsWith("/modules/runs")) ||
						args.path === "@/modules/runs/queries"
					)
						return { path: "controls", namespace: "test-pg" };
					if (
						args.path === "./archive" &&
						args.resolveDir.endsWith("/modules/runs")
					)
						return { path: "archive", namespace: "test-pg" };
					if (args.path === "@/modules/files/lifecycle")
						return { path: "files", namespace: "test-pg" };
				});
				build.onLoad({ filter: /.*/, namespace: "test-pg" }, (args) => ({
					contents:
						args.path === "controls"
							? `export async function getRunById(){return {id:'run',userId:'owner',status:2,cancelRequested:false}}`
							: args.path === "files"
								? `export async function claimFiles(){};export async function referenceFiles(){};export function partFileIds(){return []}`
								: `export async function importArchivePage(){};export async function finalizeArchive(){throw Error('not used')}`,
				}));
			},
		},
	],
});
const options = {
	workers: [
		{
			name: "probe",
			modules: true,
			script: bundle.outputFiles[0].text,
			compatibilityDate: "2026-09-01",
			durableObjects: { PROBES: { className: "Probe", useSQLite: true } },
		},
	],
};
let mf = new Miniflare({
	...convertV4MiniflareOptions(options),
	resourcePersistencePath: directory,
});
try {
	await (await mf.dispatchFetch("https://probe/init")).json();
	const result = await (await mf.dispatchFetch("https://probe/append")).json();
	if (
		result.metric.bytes !== 2_800_000 ||
		result.metric.maxBlock > 49152 ||
		result.window.length !== 1_200_000 ||
		result.old !== 0
	)
		throw new Error(JSON.stringify(result.metric));
	await mf.dispose();
	mf = new Miniflare({
		...convertV4MiniflareOptions(options),
		resourcePersistencePath: directory,
	});
	const resumed = await (await mf.dispatchFetch("https://probe/info")).json();
	if (
		resumed.revision !== result.revision ||
		resumed.window.text !== result.window.text ||
		resumed.context[0].content !== "go" ||
		resumed.context[1].encryptedLength !== 600000
	)
		throw new Error("native restart lost state");
	console.log(
		JSON.stringify({
			nativeSQLite: true,
			restartPreserved: true,
			revision: resumed.revision,
			bytes: resumed.metric.bytes,
			chunks: resumed.metric.chunks,
			maxBlock: resumed.metric.maxBlock,
			immutableSnapshot: true,
		}),
	);
} finally {
	await mf.dispose();
	await rm(directory, { recursive: true, force: true });
}

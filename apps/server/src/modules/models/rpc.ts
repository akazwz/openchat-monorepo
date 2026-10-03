import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";

import { modelCatalog } from "@/config";
import { FileKind, ModelSchema, ModelService } from "@/gen/heveta/v1/model_pb";
import { requestLocale } from "@/lib/locale";
import type { FileKind as ModelFileKind } from "@/modules/files/types";

import { effortToProto } from "./reasoning-effort";

const fileKindToProto: Record<ModelFileKind, FileKind> = {
	image: FileKind.IMAGE,
	pdf: FileKind.PDF,
};

export function registerModels(router: ConnectRouter) {
	router.service(ModelService, {
		async listModels(_req, ctx) {
			const locale = requestLocale(ctx.requestHeader);
			return {
				models: modelCatalog.models.map((model) =>
					create(ModelSchema, {
						id: model.id,
						displayName: model.displayName,
						description: model.description[locale],
						reads: model.reads.map((kind) => fileKindToProto[kind]),
						reasoningEfforts: model.reasoningEfforts.map(effortToProto),
						defaultReasoningEffort: effortToProto(model.defaultReasoningEffort),
					}),
				),
				defaultModelId: modelCatalog.defaultModelId,
			};
		},
	});
}

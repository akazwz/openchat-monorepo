import { queryOptions, useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
	FileKind,
	type Model,
	ReasoningEffort,
} from "~/gen/heveta/v1/model_pb";
import type { AppLocale } from "~/i18n/catalog";
import { useLanguage } from "~/i18n/language";
import { modelClient } from "~/lib/rpc-client";

// The server owns the catalog; it changes with a backend deploy, so a page
// left open picks up the new list within minutes (and at once when a send is
// refused for an unknown model). Its descriptions are in the language the
// request asks for (rpc-client.ts), so each language has its own copy.
export const modelsKey = ["models"] as const;
export const modelsQuery = (locale: AppLocale) =>
	queryOptions({
		queryKey: [...modelsKey, locale],
		queryFn: ({ signal }) => modelClient.listModels({}, { signal }),
		staleTime: 10 * 60_000,
	});

// Whether a model reads attached images; assumed while the catalog loads.
export const readsImages = (model: Model | undefined) =>
	!model || model.reads.includes(FileKind.IMAGE);

// The last model a viewer picked, and the reasoning effort picked for each
// model (their efforts differ), kept on this device like mainstream apps do.
const useModelPreference = create<{
	modelId: string;
	efforts: Record<string, ReasoningEffort>;
	setModelId: (modelId: string) => void;
	setEffort: (modelId: string, effort: ReasoningEffort) => void;
}>()(
	persist(
		(set) => ({
			modelId: "",
			efforts: {},
			setModelId: (modelId) => set({ modelId }),
			setEffort: (modelId, effort) =>
				set((state) => ({ efforts: { ...state.efforts, [modelId]: effort } })),
		}),
		{
			name: "heveta-model",
		},
	),
);

export function useModelChoice() {
	const locale = useLanguage((state) => state.locale);
	const { data, isError, isFetching, refetch } = useQuery(modelsQuery(locale));
	const preferred = useModelPreference((state) => state.modelId);
	const efforts = useModelPreference((state) => state.efforts);
	const setModelId = useModelPreference((state) => state.setModelId);
	const setEffort = useModelPreference((state) => state.setEffort);
	const models = data?.models ?? [];
	// A preference the catalog no longer offers falls back to the default.
	const model =
		models.find((item) => item.id === preferred) ??
		models.find((item) => item.id === data?.defaultModelId);
	// The effort last picked for a model, while the model still offers it.
	const effortFor = (item: Model) => {
		const chosen = efforts[item.id];
		return chosen !== undefined && item.reasoningEfforts.includes(chosen)
			? chosen
			: item.defaultReasoningEffort;
	};
	return {
		models,
		model,
		effort: model && effortFor(model),
		effortFor,
		// What a message asks for. Without the catalog (not read yet, or its
		// read failed) it is still the choice this device remembers, never a
		// silent switch to the default; a model the server no longer has is
		// refused, and the message comes back with the reason.
		requested: model
			? { modelId: model.id, effort: effortFor(model) }
			: {
					modelId: preferred,
					effort: efforts[preferred] ?? ReasoningEffort.UNSPECIFIED,
				},
		catalogFailed: isError && !data,
		catalogRetrying: isFetching,
		retryCatalog: () => void refetch(),
		// Remembers the model, and the effort only when it differs from the
		// one the model would get anyway.
		choose: (modelId: string, effort: ReasoningEffort) => {
			const item = models.find((candidate) => candidate.id === modelId);
			if (!item) return;
			setModelId(modelId);
			if (effort !== effortFor(item)) setEffort(modelId, effort);
		},
	};
}

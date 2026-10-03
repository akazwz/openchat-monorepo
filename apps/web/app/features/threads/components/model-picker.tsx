import { ComplexSelector } from "@astryxdesign/core/ComplexSelector";
import { Field } from "@astryxdesign/core/Field";
import { useListFocus } from "@astryxdesign/core/hooks";
import { useIndicator } from "@astryxdesign/core/Indicator";
import { Item } from "@astryxdesign/core/Item";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { useId } from "react";

import { type Model, ReasoningEffort } from "~/gen/heveta/v1/model_pb";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";

// How long the model thinks before answering, from none to the most.
const effortLabels: Record<ReasoningEffort, MessageKey> = {
	[ReasoningEffort.UNSPECIFIED]: "threads.effortDefault",
	[ReasoningEffort.NONE]: "threads.effortNone",
	[ReasoningEffort.LOW]: "threads.effortLow",
	[ReasoningEffort.MEDIUM]: "threads.effortMedium",
	[ReasoningEffort.HIGH]: "threads.effortHigh",
	[ReasoningEffort.XHIGH]: "threads.effortXHigh",
	[ReasoningEffort.MAX]: "threads.effortMax",
};

// The models, as rows with the chosen one checked at the end, as in the
// ChatGPT and Claude model menus and Astryx's own Selector: a listbox of
// option Items (Item in its parent-role mode: the list owns the keyboard).
function ChoiceList({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: { value: string; label: string; description?: string }[];
	value: string;
	onChange: (value: string) => void;
}) {
	const listId = useId();
	const labelId = useId();
	const Check = useIndicator("check");
	const { listRef, handleKeyDown, handleFocus } = useListFocus({
		itemSelector: '[role="option"]',
		hasRovingTabIndex: true,
	});
	return (
		<Field label={label} isGroupLabel inputID={listId} labelID={labelId}>
			<VStack
				ref={listRef}
				id={listId}
				role="listbox"
				aria-labelledby={labelId}
				onFocus={handleFocus}
				onKeyDown={(event) => {
					handleKeyDown(event);
					const option = event.target as HTMLElement;
					if (
						(event.key === "Enter" || event.key === " ") &&
						option.getAttribute("role") === "option"
					) {
						event.preventDefault();
						option.click();
					}
				}}
			>
				{options.map((item) => (
					<Item
						key={item.value}
						// Item sets aria-selected itself, from isSelected.
						// oxlint-disable-next-line jsx-a11y/role-has-required-aria-props
						role="option"
						density="compact"
						isSelected={item.value === value}
						onClick={() => onChange(item.value)}
						label={item.label}
						description={item.description}
						endContent={
							<Check
								state={item.value === value ? "checked" : "unchecked"}
								size="sm"
							/>
						}
					/>
				))}
			</VStack>
		</Field>
	);
}

interface Choice {
	modelId: string;
	effort: ReasoningEffort;
}

// One control for how a message is answered, as in ChatGPT and Claude: pick
// the model, then how hard it thinks. The efforts are the chosen model's own
// (four for one, six for another), so they change with it; they are one row
// under the models, a setting of the chosen one, not a second list as long
// as the first. Picking a model keeps the surface open for that second step,
// picking an effort finishes it. The server owns both lists; a single choice
// of each needs no picker.
export function ModelPicker({
	models,
	model,
	effort,
	effortFor,
	onChoose,
	isDisabled,
}: {
	models: Model[];
	model: Model;
	effort: ReasoningEffort;
	effortFor: (model: Model) => ReasoningEffort;
	onChoose: (modelId: string, effort: ReasoningEffort) => void;
	isDisabled: boolean;
}) {
	const t = useT();
	if (models.length < 2 && model.reasoningEfforts.length < 2) return null;
	return (
		<ComplexSelector<Choice>
			label={t("threads.modelAndEffort")}
			isLabelHidden
			variant="ghost"
			size="sm"
			// The composer is docked at the bottom and the control sits by the
			// send button, so the surface opens upward, toward the start.
			placement="above"
			alignment="end"
			value={{ modelId: model.id, effort }}
			onChange={(choice) => onChoose(choice.modelId, choice.effort)}
			// A setting beside the send button, not an action: secondary text
			// at body size (the trigger's own is the input's, 16px on phones).
			triggerLabel={
				<Text color="secondary">
					{model.reasoningEfforts.length > 1
						? `${model.displayName} · ${t(effortLabels[effort])}`
						: model.displayName}
				</Text>
			}
			isDisabled={isDisabled}
		>
			{(choice, change, close) => {
				const chosen =
					models.find((item) => item.id === choice.modelId) ?? model;
				return (
					// A fixed width, as menus have: switching models changes the
					// efforts below, never the surface's size.
					<VStack gap={4} width={280}>
						{models.length > 1 && (
							<ChoiceList
								label={t("threads.model")}
								options={models.map((item) => ({
									value: item.id,
									label: item.displayName,
									description: item.description,
								}))}
								value={chosen.id}
								onChange={(modelId) => {
									const next = models.find((item) => item.id === modelId);
									if (next) change({ modelId, effort: effortFor(next) });
								}}
							/>
						)}
						{chosen.reasoningEfforts.length > 1 && (
							<HStack justify="between" vAlign="center" gap={2}>
								<Text type="supporting" color="secondary">
									{t("threads.reasoningEffort")}
								</Text>
								<Selector
									label={t("threads.reasoningEffort")}
									isLabelHidden
									size="sm"
									options={chosen.reasoningEfforts.map((item) => ({
										value: String(item),
										label: t(effortLabels[item]),
									}))}
									value={String(choice.effort)}
									onChange={(value) => {
										change({ modelId: chosen.id, effort: Number(value) });
										close();
									}}
								/>
							</HStack>
						)}
					</VStack>
				);
			}}
		</ComplexSelector>
	);
}

import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef } from "react";
import {
	type Control,
	type FieldPath,
	type FieldValues,
	useController,
} from "react-hook-form";

import { isMessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";

export interface FormInputProps<T extends FieldValues> {
	control: Control<T>;
	name: FieldPath<T>;
	label: string;
	// Only where the heading above already says what the field is for.
	isLabelHidden?: boolean;
	size?: "md" | "lg";
	type?: "text" | "email";
	placeholder?: string;
	autoComplete?: string;
	inputMode?: "numeric" | "email";
	maxLength?: number;
	isDisabled?: boolean;
	autoFocus?: boolean;
}

export function FormInput<T extends FieldValues>({
	control,
	name,
	label,
	isLabelHidden,
	size,
	type = "text",
	placeholder,
	autoComplete,
	inputMode,
	maxLength,
	isDisabled,
	autoFocus,
}: FormInputProps<T>) {
	const input = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (!autoFocus) return;
		let mounted = true;
		queueMicrotask(() => {
			const element = input.current;
			const dialog = element?.closest("dialog");
			if (mounted && dialog?.open) element?.focus();
		});
		return () => {
			mounted = false;
		};
	}, [autoFocus]);
	const t = useT();
	const { field, fieldState } = useController({ control, name });
	// The form's schema gives each error as a message key (auth/validation.ts).
	const error = fieldState.error?.message;
	// TextInput forwards native attributes to its input; its public props omit these hints.
	const nativeInputProps = {
		inputMode,
		maxLength,
		autoCapitalize: "none",
		spellCheck: false,
	};
	return (
		<TextInput
			{...nativeInputProps}
			label={label}
			isLabelHidden={isLabelHidden}
			size={size}
			type={type}
			value={String(field.value ?? "")}
			onChange={field.onChange}
			onBlur={field.onBlur}
			htmlName={field.name}
			ref={(element) => {
				input.current = element;
				field.ref(element);
			}}
			placeholder={placeholder}
			autoComplete={autoComplete}
			hasAutoFocus={autoFocus}
			isDisabled={isDisabled}
			status={
				error
					? { type: "error", message: isMessageKey(error) ? t(error) : error }
					: undefined
			}
		/>
	);
}

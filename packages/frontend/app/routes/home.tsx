import { useRef, useState } from "react";
import {
	Box,
	EmptyState,
	Avatar,
	Heading,
	HStack,
	Icon,
	IconButton,
	Spacer,
	Spinner,
	Text,
	Textarea,
	VStack,
	Float,
} from "@chakra-ui/react";
import {
	MenuCheckboxItem,
	MenuContent,
	MenuRoot,
	MenuTrigger,
} from "~/components/ui/menu";
import {
	RiArrowUpLine,
	RiAttachmentLine,
	RiChatNewLine,
	RiGlobalLine,
	RiImageAiFill,
	RiLink,
	RiStopCircleLine,
	RiToolsLine,
	RiCloseLine,
} from "react-icons/ri";
import {
	useNavigate,
	useParams,
	type ClientLoaderFunctionArgs,
} from "react-router";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AssistantBubble, ChatBubbleMemoized } from "~/components/chat-bubble";
import { chatClient, fileClient } from "~/client";
import { DEFAULT_CONVERSATION_ID, useChatStore } from "~/stores/chat";
import { useMessagesStore } from "~/stores/messages";
import { useConversationsStore } from "~/stores/conversations";
import { MobileDrawer } from "~/routes/layout";
import type { Message, SearchResult, ChatFile } from "~/types";
import { Feature } from "~/gen/chat/v1/chat_pb";
import { toaster } from "~/components/ui/toaster";

export async function clientLoader({ params }: ClientLoaderFunctionArgs) {
	const conversationId = params.id || DEFAULT_CONVERSATION_ID;
	useChatStore.getState().setActiveConversationId(conversationId);
	if (conversationId === DEFAULT_CONVERSATION_ID) {
		useMessagesStore.getState().setMessages(conversationId, []);
	}
	return null;
}

export default function Chat() {
	const params = useParams();
	const [output, setOutput] = useState<Message | null>(null);
	const fallbackUrls = useRef<Record<string, string>>({});
	const isWaitingForResponse = useRef<boolean>(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const runningFeature = useRef<Feature>(Feature.UNSPECIFIED);
	const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
	const initialConversationId = params.id || DEFAULT_CONVERSATION_ID;
	const { activeConversationId, setActiveConversationId } = useChatStore();

	const { addConversation } = useConversationsStore();
	const { messagesMap, addMessage, setMessages } = useMessagesStore();
	const messages = messagesMap[initialConversationId] || [];

	const [isComposing, setIsComposing] = useState(false);

	function addUploadingFile(file: string) {
		setUploadingFiles((prev: string[]) => [...prev, file]);
	}

	function removeUploadingFile(file: string) {
		setUploadingFiles((prev: string[]) =>
			prev.filter((f: string) => f !== file),
		);
	}

	function handleAddMessage(message: Message) {
		addMessage(initialConversationId, message);
	}

	const { isLoading } = useQuery({
		queryKey: ["conversation", initialConversationId],
		queryFn: async () => {
			const resp = await chatClient.listMessages({
				conversationId: initialConversationId,
			});
			setMessages(initialConversationId, resp.messages);
			return resp.messages;
		},
		enabled: initialConversationId !== DEFAULT_CONVERSATION_ID,
	});

	const abort = new AbortController();

	const formSchema = z.object({
		message: z.string().min(1),
		files: z.array(
			z.object({
				url: z.string(),
				mimeType: z.string(),
				fileName: z.string(),
			}),
		),
		features: z.array(z.nativeEnum(Feature)),
	});

	type FormData = z.infer<typeof formSchema>;

	const { register, handleSubmit, reset, watch, setValue, getValues } = useForm<
		z.infer<typeof formSchema>
	>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			message: "",
			features: [
				Feature.SEARCH_WEB,
				Feature.GENERATE_IMAGE,
				Feature.BROWSER_URL,
			],
			files: [],
		},
	});

	const features = watch("features");
	const files = watch("files");
	const message = watch("message");
	const isSubmitDisabled = !message || uploadingFiles.length > 0;

	function addFile(file: ChatFile) {
		const currentFiles = files || [];
		setValue("files", [...currentFiles, file]);
	}

	async function handleFileUpload(file: File) {
		// Create temporary preview
		const previewFile: ChatFile = {
			url: URL.createObjectURL(file),
			mimeType: file.type,
			fileName: file.name,
		};

		// Add file to form for preview
		addFile(previewFile);

		try {
			// Start upload and show loading
			addUploadingFile(file.name);
			const response = await fileClient.uploadFile({
				fileName: file.name,
				mimeType: file.type,
				content: new Uint8Array(await file.arrayBuffer()),
			});
			// Update file URL with server URL
			const uploadedFile = response.file;
			if (uploadedFile?.url) {
				const img = new Image();
				img.src = uploadedFile.url;
				fallbackUrls.current[uploadedFile.url] = previewFile.url;
				const currentFiles = getValues("files");
				// Update the file URL while preserving other files
				const updatedFiles = currentFiles.map((f: ChatFile) => {
					if (f.url === previewFile.url) {
						// Update the matching file with server response
						return uploadedFile;
					}
					return f;
				});
				setValue("files", updatedFiles);
				console.log("fallbackUrls: ", fallbackUrls.current[uploadedFile.url]);
			}
		} catch (error) {
			console.error("Failed to upload file:", error);
			// Remove preview on error
			removeFile(previewFile);
			toaster.error({
				title: "上传失败",
				description: "请重试",
			});
		} finally {
			removeUploadingFile(file.name);
		}
	}

	function removeFile(file: ChatFile) {
		setValue(
			"files",
			files.filter((f) => f.url !== file.url),
		);
		// revoke object url
		URL.revokeObjectURL(file.url);
	}

	function toggleFeature(feature: Feature) {
		setValue(
			"features",
			features.includes(feature)
				? features.filter((f) => f !== feature)
				: [...features, feature],
		);
	}

	const mutation = useMutation({
		mutationFn: async (data: FormData) => {
			const userMessage = {
				id: crypto.randomUUID(),
				userId: "1",
				conversationId: activeConversationId,
				role: "user",
				message: data.message,
				searchResults: [],
				generatedImageUrls: [],
				files: data.files,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			handleAddMessage(userMessage);
			isWaitingForResponse.current = true;
			if (activeConversationId === DEFAULT_CONVERSATION_ID) {
				const { conversation } = await chatClient.createConversation({
					initialMessage: data.message,
				});
				if (!conversation) {
					throw new Error("Failed to create conversation");
				}
				addConversation(conversation);
				setActiveConversationId(conversation.id);
				history.pushState({}, "", `/chat/${conversation.id}`);
				return streamChatResponse(
					data.message,
					data.features,
					data.files,
					conversation.id,
				);
			}
			return streamChatResponse(
				data.message,
				data.features,
				data.files,
				activeConversationId,
			);
		},
		onSettled: handleChatResponse,
	});

	async function streamChatResponse(
		message: string,
		features: Feature[],
		files: ChatFile[],
		conversationId: string,
	) {
		const resp = chatClient.streamChatCompletion(
			{
				conversationId,
				message,
				features,
				files,
			},
			{
				signal: abort.signal,
			},
		);
		let responseMessage = "";
		const searchResults: SearchResult[] = [];
		const generatedImageUrls: string[] = [];
		for await (const chunk of resp) {
			if (chunk.runningFeature) {
				runningFeature.current = chunk.runningFeature;
			} else {
				runningFeature.current = Feature.UNSPECIFIED;
			}
			if (chunk.message) {
				responseMessage += chunk.message;
				setOutput({
					id: crypto.randomUUID(),
					userId: "1",
					conversationId: conversationId,
					role: "assistant",
					message: responseMessage,
					files: [],
					generatedImageUrls,
					searchResults,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				});
			}
			if (chunk.searchResults) {
				searchResults.push(...chunk.searchResults);
				setOutput({
					id: crypto.randomUUID(),
					userId: "1",
					conversationId: conversationId,
					role: "assistant",
					message: responseMessage,
					files: [],
					generatedImageUrls,
					searchResults,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				});
			}
			if (chunk.generatedImageUrls) {
				generatedImageUrls.push(...chunk.generatedImageUrls);
				setOutput({
					id: crypto.randomUUID(),
					userId: "1",
					conversationId: conversationId,
					role: "assistant",
					message: responseMessage,
					files: [],
					generatedImageUrls,
					searchResults,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				});
			}
			if (isWaitingForResponse.current) {
				isWaitingForResponse.current = false;
			}
		}
		return {
			message: responseMessage,
			searchResults,
			generatedImageUrls,
		};
	}

	function handleChatResponse(data: any, error: any) {
		isWaitingForResponse.current = false;
		runningFeature.current = Feature.UNSPECIFIED;
		setOutput(null);
		if (error) {
			console.error("Error streaming chat", error);
		}
		if (data) {
			handleAddMessage({
				id: crypto.randomUUID(),
				userId: "1",
				conversationId: activeConversationId,
				role: "assistant",
				message: data.message,
				files: [],
				generatedImageUrls: data.generatedImageUrls,
				searchResults: data.searchResults,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		}
	}

	async function onSubmit(data: FormData) {
		mutation.mutate(data);
		reset({
			message: "",
			features: data.features,
			files: [],
		});
	}

	const navigate = useNavigate();

	return (
		<VStack h="dvh" w="full">
			<HStack w="full" p={1}>
				<Box display={{ base: "block", md: "none" }}>
					<MobileDrawer />
				</Box>
				<Spacer />
				<IconButton
					variant="ghost"
					rounded="full"
					onClick={() => {
						setActiveConversationId(DEFAULT_CONVERSATION_ID);
						navigate("/", {
							viewTransition: true,
						});
					}}
				>
					<Icon as={RiChatNewLine} />
				</IconButton>
			</HStack>
			<VStack
				flex={1}
				w="full"
				px={4}
				overflowY="auto"
				flexDir="column-reverse"
			>
				<Spacer />
				<VStack w="full" flex={1} maxW="4xl" mx="auto" px={2}>
					{isLoading && (
						<EmptyState.Root>
							<EmptyState.Content>
								<EmptyState.Indicator>
									<Spinner />
								</EmptyState.Indicator>
								<VStack textAlign="center">
									<EmptyState.Title>加载中...</EmptyState.Title>
									<EmptyState.Description>请稍后...</EmptyState.Description>
								</VStack>
							</EmptyState.Content>
						</EmptyState.Root>
					)}
					{messages?.length > 0 &&
						messages
							.slice()
							.map((message, index) => (
								<ChatBubbleMemoized
									key={message.id}
									message={message}
									showOptions={index === messages.length - 1}
								/>
							))}

					{isWaitingForResponse.current && (
						<AssistantBubble
							message={{
								id: crypto.randomUUID(),
								userId: "1",
								conversationId: activeConversationId,
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
								role: "assistant",
								message: "Thinking...",
								files: [],
								generatedImageUrls: [],
								searchResults: [],
							}}
							pending
						/>
					)}
					{output && (
						<ChatBubbleMemoized
							message={output}
							showOptions
							runningFeature={runningFeature.current}
						/>
					)}
				</VStack>
			</VStack>
			<VStack
				w="full"
				h={{ base: "full", md: "fit" }}
				justify="center"
				align="center"
				p={4}
				hidden={
					initialConversationId !== DEFAULT_CONVERSATION_ID ||
					messages?.length > 0
				}
			>
				<Heading size="2xl">有什么可以帮你的吗?</Heading>
				<Heading size="sm" color="fg.muted">
					我可以帮你写作,回答, 生成图片,总结网页内容
				</Heading>
			</VStack>
			<VStack w="full" p={2} maxW="4xl" mx="auto">
				<HStack w="full" px={4}>
					{files?.map((file) => (
						<Avatar.Root
							key={file.url}
							size="2xl"
							rounded="sm"
							bg="transparent"
						>
							<Avatar.Image
								src={fallbackUrls.current[file.url] || file.url}
								rounded="sm"
							/>
							<Float placement="top-end" offset={-1}>
								<IconButton
									variant="ghost"
									rounded="full"
									onClick={() => removeFile(file)}
								>
									<Icon as={RiCloseLine} />
								</IconButton>
							</Float>
							<Float
								placement="middle-center"
								hidden={!uploadingFiles.includes(file.fileName)}
							>
								<IconButton variant="plain" rounded="full">
									<Spinner size="lg" />
								</IconButton>
							</Float>
						</Avatar.Root>
					))}
				</HStack>
				<VStack
					w="full"
					bg="bg.muted"
					borderWidth={1}
					rounded="3xl"
					p={1}
					px={2}
					asChild
				>
					<form onSubmit={handleSubmit(onSubmit)}>
						<HStack w="full">
							<Textarea
								spellCheck="false"
								{...register("message")}
								autoFocus
								placeholder="有什么可以帮你的吗?"
								resize="none"
								border="none"
								focusRingWidth={0}
								onCompositionStart={() => setIsComposing(true)}
								onCompositionEnd={() => setIsComposing(false)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey && !isComposing) {
										e.preventDefault();
										if (!isSubmitDisabled) {
											onSubmit({
												message: e.currentTarget.value,
												features,
												files,
											});
										}
									}
								}}
							/>
						</HStack>
						<HStack w="full">
							<input
								hidden
								ref={fileInputRef}
								type="file"
								accept="image/png, image/jpeg, image/jpg, image/webp"
								onChange={async (e) => {
									const file = e.target.files?.[0];
									if (file) {
										handleFileUpload(file);
									}
								}}
							/>
							<IconButton
								variant="ghost"
								rounded="full"
								onClick={() => {
									fileInputRef.current?.click();
								}}
							>
								<Icon as={RiAttachmentLine} />
							</IconButton>
							<Spacer />
							<ModelFeatureMenu
								features={features}
								toggleFeature={toggleFeature}
							/>
							<IconButton
								type="submit"
								size="sm"
								rounded="full"
								disabled={isSubmitDisabled}
								onClick={() => {
									if (isWaitingForResponse.current) {
										console.log("aborting");
										abort.abort();
									}
								}}
							>
								<Icon
									as={
										isWaitingForResponse.current
											? RiStopCircleLine
											: RiArrowUpLine
									}
								/>
							</IconButton>
						</HStack>
					</form>
				</VStack>
			</VStack>
			<Spacer
				hideBelow="md"
				hidden={
					initialConversationId !== DEFAULT_CONVERSATION_ID ||
					messages?.length > 0
				}
			/>
		</VStack>
	);
}

function ModelFeatureMenu({
	features,
	toggleFeature,
}: {
	features: Feature[];
	toggleFeature: (feature: Feature) => void;
}) {
	return (
		<MenuRoot closeOnSelect={false}>
			<MenuTrigger asChild>
				<IconButton rounded="full" variant="subtle">
					<Icon as={RiToolsLine} />
				</IconButton>
			</MenuTrigger>
			<MenuContent w={52} rounded="2xl" zIndex={10000}>
				<MenuCheckboxItem
					value={Feature.SEARCH_WEB.toString()}
					checked={features.includes(Feature.SEARCH_WEB)}
					onCheckedChange={(e) => {
						toggleFeature(Feature.SEARCH_WEB);
					}}
				>
					<Icon as={RiGlobalLine} />
					<Text>联网搜索</Text>
				</MenuCheckboxItem>
				<MenuCheckboxItem
					value={Feature.GENERATE_IMAGE.toString()}
					rounded="xl"
					checked={features.includes(Feature.GENERATE_IMAGE)}
					onCheckedChange={(e) => {
						toggleFeature(Feature.GENERATE_IMAGE);
					}}
				>
					<Icon as={RiImageAiFill} />
					<Text>生成图片</Text>
				</MenuCheckboxItem>
				<MenuCheckboxItem
					value={Feature.BROWSER_URL.toString()}
					rounded="xl"
					checked={features.includes(Feature.BROWSER_URL)}
					onCheckedChange={(e) => {
						toggleFeature(Feature.BROWSER_URL);
					}}
				>
					<Icon as={RiLink} />
					<Text>浏览网页</Text>
				</MenuCheckboxItem>
			</MenuContent>
		</MenuRoot>
	);
}

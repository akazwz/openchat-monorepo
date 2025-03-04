// @generated by protoc-gen-es v2.2.3 with parameter "target=ts"
// @generated from file chat/v1/chat.proto (package chat.v1, syntax proto3)
/* eslint-disable */

import type { GenEnum, GenFile, GenMessage, GenService } from "@bufbuild/protobuf/codegenv1";
import { enumDesc, fileDesc, messageDesc, serviceDesc } from "@bufbuild/protobuf/codegenv1";
import type { Message as Message$1 } from "@bufbuild/protobuf";

/**
 * Describes the file chat/v1/chat.proto.
 */
export const file_chat_v1_chat: GenFile = /*@__PURE__*/
  fileDesc("ChJjaGF0L3YxL2NoYXQucHJvdG8SB2NoYXQudjEicwoMQ29udmVyc2F0aW9uEgoKAmlkGAEgASgJEg8KB3VzZXJfaWQYAiABKAkSDQoFdGl0bGUYAyABKAkSDwoHc3RhcnJlZBgEIAEoCBISCgpjcmVhdGVkX2F0GAUgASgJEhIKCnVwZGF0ZWRfYXQYBiABKAkiNAoZQ3JlYXRlQ29udmVyc2F0aW9uUmVxdWVzdBIXCg9pbml0aWFsX21lc3NhZ2UYASABKAkiSQoaQ3JlYXRlQ29udmVyc2F0aW9uUmVzcG9uc2USKwoMY29udmVyc2F0aW9uGAEgASgLMhUuY2hhdC52MS5Db252ZXJzYXRpb24imAEKG1N0cmVhbUNoYXRDb21wbGV0aW9uUmVxdWVzdBIXCg9jb252ZXJzYXRpb25faWQYASABKAkSDQoFbW9kZWwYAiABKAkSDwoHbWVzc2FnZRgDIAEoCRIiCghmZWF0dXJlcxgEIAMoDjIQLmNoYXQudjEuRmVhdHVyZRIcCgVmaWxlcxgFIAMoCzINLmNoYXQudjEuRmlsZSKnAQocU3RyZWFtQ2hhdENvbXBsZXRpb25SZXNwb25zZRIPCgdtZXNzYWdlGAEgASgJEi0KDnNlYXJjaF9yZXN1bHRzGAIgAygLMhUuY2hhdC52MS5TZWFyY2hSZXN1bHQSHAoUZ2VuZXJhdGVkX2ltYWdlX3VybHMYAyADKAkSKQoPcnVubmluZ19mZWF0dXJlGAQgASgOMhAuY2hhdC52MS5GZWF0dXJlIloKB01ldGFVcmwSDgoGc2NoZW1lGAEgASgJEg4KBm5ldGxvYxgCIAEoCRIQCghob3N0bmFtZRgDIAEoCRIMCgRwYXRoGAQgASgJEg8KB2Zhdmljb24YBSABKAkiYwoMU2VhcmNoUmVzdWx0EgsKA3VybBgBIAEoCRINCgV0aXRsZRgCIAEoCRITCgtkZXNjcmlwdGlvbhgDIAEoCRIiCghtZXRhX3VybBgEIAEoCzIQLmNoYXQudjEuTWV0YVVybCI5CgRGaWxlEgsKA3VybBgBIAEoCRIRCgltaW1lX3R5cGUYAiABKAkSEQoJZmlsZV9uYW1lGAMgASgJIvEBCgdNZXNzYWdlEgoKAmlkGAEgASgJEg8KB3VzZXJfaWQYAiABKAkSFwoPY29udmVyc2F0aW9uX2lkGAMgASgJEgwKBHJvbGUYBCABKAkSDwoHbWVzc2FnZRgFIAEoCRIcCgVmaWxlcxgGIAMoCzINLmNoYXQudjEuRmlsZRIcChRnZW5lcmF0ZWRfaW1hZ2VfdXJscxgHIAMoCRItCg5zZWFyY2hfcmVzdWx0cxgIIAMoCzIVLmNoYXQudjEuU2VhcmNoUmVzdWx0EhIKCmNyZWF0ZWRfYXQYCSABKAkSEgoKdXBkYXRlZF9hdBgKIAEoCSIaChhMaXN0Q29udmVyc2F0aW9uc1JlcXVlc3QiSQoZTGlzdENvbnZlcnNhdGlvbnNSZXNwb25zZRIsCg1jb252ZXJzYXRpb25zGAEgAygLMhUuY2hhdC52MS5Db252ZXJzYXRpb24iMQoWR2V0Q29udmVyc2F0aW9uUmVxdWVzdBIXCg9jb252ZXJzYXRpb25faWQYASABKAkiRgoXR2V0Q29udmVyc2F0aW9uUmVzcG9uc2USKwoMY29udmVyc2F0aW9uGAEgASgLMhUuY2hhdC52MS5Db252ZXJzYXRpb24iLgoTTGlzdE1lc3NhZ2VzUmVxdWVzdBIXCg9jb252ZXJzYXRpb25faWQYASABKAkiOgoUTGlzdE1lc3NhZ2VzUmVzcG9uc2USIgoIbWVzc2FnZXMYASADKAsyEC5jaGF0LnYxLk1lc3NhZ2UiNAoZRGVsZXRlQ29udmVyc2F0aW9uUmVxdWVzdBIXCg9jb252ZXJzYXRpb25faWQYASABKAkiHAoaRGVsZXRlQ29udmVyc2F0aW9uUmVzcG9uc2UiYQoZVXBkYXRlQ29udmVyc2F0aW9uUmVxdWVzdBIXCg9jb252ZXJzYXRpb25faWQYASABKAkSKwoMY29udmVyc2F0aW9uGAIgASgLMhUuY2hhdC52MS5Db252ZXJzYXRpb24iSQoaVXBkYXRlQ29udmVyc2F0aW9uUmVzcG9uc2USKwoMY29udmVyc2F0aW9uGAEgASgLMhUuY2hhdC52MS5Db252ZXJzYXRpb24qbwoHRmVhdHVyZRIXChNGRUFUVVJFX1VOU1BFQ0lGSUVEEAASFgoSRkVBVFVSRV9TRUFSQ0hfV0VCEAESGgoWRkVBVFVSRV9HRU5FUkFURV9JTUFHRRACEhcKE0ZFQVRVUkVfQlJPV1NFUl9VUkwQAzKQBQoLQ2hhdFNlcnZpY2USXQoSQ3JlYXRlQ29udmVyc2F0aW9uEiIuY2hhdC52MS5DcmVhdGVDb252ZXJzYXRpb25SZXF1ZXN0GiMuY2hhdC52MS5DcmVhdGVDb252ZXJzYXRpb25SZXNwb25zZRJlChRTdHJlYW1DaGF0Q29tcGxldGlvbhIkLmNoYXQudjEuU3RyZWFtQ2hhdENvbXBsZXRpb25SZXF1ZXN0GiUuY2hhdC52MS5TdHJlYW1DaGF0Q29tcGxldGlvblJlc3BvbnNlMAESWgoRTGlzdENvbnZlcnNhdGlvbnMSIS5jaGF0LnYxLkxpc3RDb252ZXJzYXRpb25zUmVxdWVzdBoiLmNoYXQudjEuTGlzdENvbnZlcnNhdGlvbnNSZXNwb25zZRJUCg9HZXRDb252ZXJzYXRpb24SHy5jaGF0LnYxLkdldENvbnZlcnNhdGlvblJlcXVlc3QaIC5jaGF0LnYxLkdldENvbnZlcnNhdGlvblJlc3BvbnNlEksKDExpc3RNZXNzYWdlcxIcLmNoYXQudjEuTGlzdE1lc3NhZ2VzUmVxdWVzdBodLmNoYXQudjEuTGlzdE1lc3NhZ2VzUmVzcG9uc2USXQoSRGVsZXRlQ29udmVyc2F0aW9uEiIuY2hhdC52MS5EZWxldGVDb252ZXJzYXRpb25SZXF1ZXN0GiMuY2hhdC52MS5EZWxldGVDb252ZXJzYXRpb25SZXNwb25zZRJdChJVcGRhdGVDb252ZXJzYXRpb24SIi5jaGF0LnYxLlVwZGF0ZUNvbnZlcnNhdGlvblJlcXVlc3QaIy5jaGF0LnYxLlVwZGF0ZUNvbnZlcnNhdGlvblJlc3BvbnNlYgZwcm90bzM");

/**
 * @generated from message chat.v1.Conversation
 */
export type Conversation = Message$1<"chat.v1.Conversation"> & {
  /**
   * @generated from field: string id = 1;
   */
  id: string;

  /**
   * @generated from field: string user_id = 2;
   */
  userId: string;

  /**
   * @generated from field: string title = 3;
   */
  title: string;

  /**
   * @generated from field: bool starred = 4;
   */
  starred: boolean;

  /**
   * @generated from field: string created_at = 5;
   */
  createdAt: string;

  /**
   * @generated from field: string updated_at = 6;
   */
  updatedAt: string;
};

/**
 * Describes the message chat.v1.Conversation.
 * Use `create(ConversationSchema)` to create a new message.
 */
export const ConversationSchema: GenMessage<Conversation> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 0);

/**
 * @generated from message chat.v1.CreateConversationRequest
 */
export type CreateConversationRequest = Message$1<"chat.v1.CreateConversationRequest"> & {
  /**
   * @generated from field: string initial_message = 1;
   */
  initialMessage: string;
};

/**
 * Describes the message chat.v1.CreateConversationRequest.
 * Use `create(CreateConversationRequestSchema)` to create a new message.
 */
export const CreateConversationRequestSchema: GenMessage<CreateConversationRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 1);

/**
 * @generated from message chat.v1.CreateConversationResponse
 */
export type CreateConversationResponse = Message$1<"chat.v1.CreateConversationResponse"> & {
  /**
   * @generated from field: chat.v1.Conversation conversation = 1;
   */
  conversation?: Conversation;
};

/**
 * Describes the message chat.v1.CreateConversationResponse.
 * Use `create(CreateConversationResponseSchema)` to create a new message.
 */
export const CreateConversationResponseSchema: GenMessage<CreateConversationResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 2);

/**
 * @generated from message chat.v1.StreamChatCompletionRequest
 */
export type StreamChatCompletionRequest = Message$1<"chat.v1.StreamChatCompletionRequest"> & {
  /**
   * 对话 ID，用于上下文
   *
   * @generated from field: string conversation_id = 1;
   */
  conversationId: string;

  /**
   * 要使用的 AI 模型，如果是重新生成且不指定，则使用原模型
   *
   * @generated from field: string model = 2;
   */
  model: string;

  /**
   * 用户输入的消息，重新生成时可为空
   *
   * @generated from field: string message = 3;
   */
  message: string;

  /**
   * 启用的功能列表，空列表或 FEATURE_UNSPECIFIED 表示仅文本对话
   *
   * @generated from field: repeated chat.v1.Feature features = 4;
   */
  features: Feature[];

  /**
   * 上传的文件
   *
   * @generated from field: repeated chat.v1.File files = 5;
   */
  files: File[];
};

/**
 * Describes the message chat.v1.StreamChatCompletionRequest.
 * Use `create(StreamChatCompletionRequestSchema)` to create a new message.
 */
export const StreamChatCompletionRequestSchema: GenMessage<StreamChatCompletionRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 3);

/**
 * @generated from message chat.v1.StreamChatCompletionResponse
 */
export type StreamChatCompletionResponse = Message$1<"chat.v1.StreamChatCompletionResponse"> & {
  /**
   * @generated from field: string message = 1;
   */
  message: string;

  /**
   * @generated from field: repeated chat.v1.SearchResult search_results = 2;
   */
  searchResults: SearchResult[];

  /**
   * @generated from field: repeated string generated_image_urls = 3;
   */
  generatedImageUrls: string[];

  /**
   * 当前正在执行的功能
   *
   * @generated from field: chat.v1.Feature running_feature = 4;
   */
  runningFeature: Feature;
};

/**
 * Describes the message chat.v1.StreamChatCompletionResponse.
 * Use `create(StreamChatCompletionResponseSchema)` to create a new message.
 */
export const StreamChatCompletionResponseSchema: GenMessage<StreamChatCompletionResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 4);

/**
 * @generated from message chat.v1.MetaUrl
 */
export type MetaUrl = Message$1<"chat.v1.MetaUrl"> & {
  /**
   * @generated from field: string scheme = 1;
   */
  scheme: string;

  /**
   * @generated from field: string netloc = 2;
   */
  netloc: string;

  /**
   * @generated from field: string hostname = 3;
   */
  hostname: string;

  /**
   * @generated from field: string path = 4;
   */
  path: string;

  /**
   * @generated from field: string favicon = 5;
   */
  favicon: string;
};

/**
 * Describes the message chat.v1.MetaUrl.
 * Use `create(MetaUrlSchema)` to create a new message.
 */
export const MetaUrlSchema: GenMessage<MetaUrl> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 5);

/**
 * @generated from message chat.v1.SearchResult
 */
export type SearchResult = Message$1<"chat.v1.SearchResult"> & {
  /**
   * @generated from field: string url = 1;
   */
  url: string;

  /**
   * @generated from field: string title = 2;
   */
  title: string;

  /**
   * @generated from field: string description = 3;
   */
  description: string;

  /**
   * @generated from field: chat.v1.MetaUrl meta_url = 4;
   */
  metaUrl?: MetaUrl;
};

/**
 * Describes the message chat.v1.SearchResult.
 * Use `create(SearchResultSchema)` to create a new message.
 */
export const SearchResultSchema: GenMessage<SearchResult> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 6);

/**
 * @generated from message chat.v1.File
 */
export type File = Message$1<"chat.v1.File"> & {
  /**
   * @generated from field: string url = 1;
   */
  url: string;

  /**
   * @generated from field: string mime_type = 2;
   */
  mimeType: string;

  /**
   * @generated from field: string file_name = 3;
   */
  fileName: string;
};

/**
 * Describes the message chat.v1.File.
 * Use `create(FileSchema)` to create a new message.
 */
export const FileSchema: GenMessage<File> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 7);

/**
 * @generated from message chat.v1.Message
 */
export type Message = Message$1<"chat.v1.Message"> & {
  /**
   * @generated from field: string id = 1;
   */
  id: string;

  /**
   * @generated from field: string user_id = 2;
   */
  userId: string;

  /**
   * @generated from field: string conversation_id = 3;
   */
  conversationId: string;

  /**
   * @generated from field: string role = 4;
   */
  role: string;

  /**
   * @generated from field: string message = 5;
   */
  message: string;

  /**
   * @generated from field: repeated chat.v1.File files = 6;
   */
  files: File[];

  /**
   * @generated from field: repeated string generated_image_urls = 7;
   */
  generatedImageUrls: string[];

  /**
   * @generated from field: repeated chat.v1.SearchResult search_results = 8;
   */
  searchResults: SearchResult[];

  /**
   * @generated from field: string created_at = 9;
   */
  createdAt: string;

  /**
   * @generated from field: string updated_at = 10;
   */
  updatedAt: string;
};

/**
 * Describes the message chat.v1.Message.
 * Use `create(MessageSchema)` to create a new message.
 */
export const MessageSchema: GenMessage<Message> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 8);

/**
 * 无需字段
 *
 * @generated from message chat.v1.ListConversationsRequest
 */
export type ListConversationsRequest = Message$1<"chat.v1.ListConversationsRequest"> & {
};

/**
 * Describes the message chat.v1.ListConversationsRequest.
 * Use `create(ListConversationsRequestSchema)` to create a new message.
 */
export const ListConversationsRequestSchema: GenMessage<ListConversationsRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 9);

/**
 * @generated from message chat.v1.ListConversationsResponse
 */
export type ListConversationsResponse = Message$1<"chat.v1.ListConversationsResponse"> & {
  /**
   * @generated from field: repeated chat.v1.Conversation conversations = 1;
   */
  conversations: Conversation[];
};

/**
 * Describes the message chat.v1.ListConversationsResponse.
 * Use `create(ListConversationsResponseSchema)` to create a new message.
 */
export const ListConversationsResponseSchema: GenMessage<ListConversationsResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 10);

/**
 * @generated from message chat.v1.GetConversationRequest
 */
export type GetConversationRequest = Message$1<"chat.v1.GetConversationRequest"> & {
  /**
   * @generated from field: string conversation_id = 1;
   */
  conversationId: string;
};

/**
 * Describes the message chat.v1.GetConversationRequest.
 * Use `create(GetConversationRequestSchema)` to create a new message.
 */
export const GetConversationRequestSchema: GenMessage<GetConversationRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 11);

/**
 * @generated from message chat.v1.GetConversationResponse
 */
export type GetConversationResponse = Message$1<"chat.v1.GetConversationResponse"> & {
  /**
   * @generated from field: chat.v1.Conversation conversation = 1;
   */
  conversation?: Conversation;
};

/**
 * Describes the message chat.v1.GetConversationResponse.
 * Use `create(GetConversationResponseSchema)` to create a new message.
 */
export const GetConversationResponseSchema: GenMessage<GetConversationResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 12);

/**
 * @generated from message chat.v1.ListMessagesRequest
 */
export type ListMessagesRequest = Message$1<"chat.v1.ListMessagesRequest"> & {
  /**
   * @generated from field: string conversation_id = 1;
   */
  conversationId: string;
};

/**
 * Describes the message chat.v1.ListMessagesRequest.
 * Use `create(ListMessagesRequestSchema)` to create a new message.
 */
export const ListMessagesRequestSchema: GenMessage<ListMessagesRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 13);

/**
 * @generated from message chat.v1.ListMessagesResponse
 */
export type ListMessagesResponse = Message$1<"chat.v1.ListMessagesResponse"> & {
  /**
   * @generated from field: repeated chat.v1.Message messages = 1;
   */
  messages: Message[];
};

/**
 * Describes the message chat.v1.ListMessagesResponse.
 * Use `create(ListMessagesResponseSchema)` to create a new message.
 */
export const ListMessagesResponseSchema: GenMessage<ListMessagesResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 14);

/**
 * @generated from message chat.v1.DeleteConversationRequest
 */
export type DeleteConversationRequest = Message$1<"chat.v1.DeleteConversationRequest"> & {
  /**
   * @generated from field: string conversation_id = 1;
   */
  conversationId: string;
};

/**
 * Describes the message chat.v1.DeleteConversationRequest.
 * Use `create(DeleteConversationRequestSchema)` to create a new message.
 */
export const DeleteConversationRequestSchema: GenMessage<DeleteConversationRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 15);

/**
 * @generated from message chat.v1.DeleteConversationResponse
 */
export type DeleteConversationResponse = Message$1<"chat.v1.DeleteConversationResponse"> & {
};

/**
 * Describes the message chat.v1.DeleteConversationResponse.
 * Use `create(DeleteConversationResponseSchema)` to create a new message.
 */
export const DeleteConversationResponseSchema: GenMessage<DeleteConversationResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 16);

/**
 * @generated from message chat.v1.UpdateConversationRequest
 */
export type UpdateConversationRequest = Message$1<"chat.v1.UpdateConversationRequest"> & {
  /**
   * @generated from field: string conversation_id = 1;
   */
  conversationId: string;

  /**
   * @generated from field: chat.v1.Conversation conversation = 2;
   */
  conversation?: Conversation;
};

/**
 * Describes the message chat.v1.UpdateConversationRequest.
 * Use `create(UpdateConversationRequestSchema)` to create a new message.
 */
export const UpdateConversationRequestSchema: GenMessage<UpdateConversationRequest> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 17);

/**
 * @generated from message chat.v1.UpdateConversationResponse
 */
export type UpdateConversationResponse = Message$1<"chat.v1.UpdateConversationResponse"> & {
  /**
   * @generated from field: chat.v1.Conversation conversation = 1;
   */
  conversation?: Conversation;
};

/**
 * Describes the message chat.v1.UpdateConversationResponse.
 * Use `create(UpdateConversationResponseSchema)` to create a new message.
 */
export const UpdateConversationResponseSchema: GenMessage<UpdateConversationResponse> = /*@__PURE__*/
  messageDesc(file_chat_v1_chat, 18);

/**
 * @generated from enum chat.v1.Feature
 */
export enum Feature {
  /**
   * @generated from enum value: FEATURE_UNSPECIFIED = 0;
   */
  UNSPECIFIED = 0,

  /**
   * 网页搜索
   *
   * @generated from enum value: FEATURE_SEARCH_WEB = 1;
   */
  SEARCH_WEB = 1,

  /**
   * 图片生成
   *
   * @generated from enum value: FEATURE_GENERATE_IMAGE = 2;
   */
  GENERATE_IMAGE = 2,

  /**
   * 浏览
   *
   * @generated from enum value: FEATURE_BROWSER_URL = 3;
   */
  BROWSER_URL = 3,
}

/**
 * Describes the enum chat.v1.Feature.
 */
export const FeatureSchema: GenEnum<Feature> = /*@__PURE__*/
  enumDesc(file_chat_v1_chat, 0);

/**
 * @generated from service chat.v1.ChatService
 */
export const ChatService: GenService<{
  /**
   * rpc 创建对话
   *
   * @generated from rpc chat.v1.ChatService.CreateConversation
   */
  createConversation: {
    methodKind: "unary";
    input: typeof CreateConversationRequestSchema;
    output: typeof CreateConversationResponseSchema;
  },
  /**
   * 流式对话补全，支持新消息对话和重新生成
   *
   * @generated from rpc chat.v1.ChatService.StreamChatCompletion
   */
  streamChatCompletion: {
    methodKind: "server_streaming";
    input: typeof StreamChatCompletionRequestSchema;
    output: typeof StreamChatCompletionResponseSchema;
  },
  /**
   * 获取对话列表
   *
   * @generated from rpc chat.v1.ChatService.ListConversations
   */
  listConversations: {
    methodKind: "unary";
    input: typeof ListConversationsRequestSchema;
    output: typeof ListConversationsResponseSchema;
  },
  /**
   * 获取对话详情
   *
   * @generated from rpc chat.v1.ChatService.GetConversation
   */
  getConversation: {
    methodKind: "unary";
    input: typeof GetConversationRequestSchema;
    output: typeof GetConversationResponseSchema;
  },
  /**
   * 获取对话消息历史
   *
   * @generated from rpc chat.v1.ChatService.ListMessages
   */
  listMessages: {
    methodKind: "unary";
    input: typeof ListMessagesRequestSchema;
    output: typeof ListMessagesResponseSchema;
  },
  /**
   * 删除对话
   *
   * @generated from rpc chat.v1.ChatService.DeleteConversation
   */
  deleteConversation: {
    methodKind: "unary";
    input: typeof DeleteConversationRequestSchema;
    output: typeof DeleteConversationResponseSchema;
  },
  /**
   * 修改对话
   *
   * @generated from rpc chat.v1.ChatService.UpdateConversation
   */
  updateConversation: {
    methodKind: "unary";
    input: typeof UpdateConversationRequestSchema;
    output: typeof UpdateConversationResponseSchema;
  },
}> = /*@__PURE__*/
  serviceDesc(file_chat_v1_chat, 0);


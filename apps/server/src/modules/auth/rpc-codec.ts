import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import type { User } from "@/db/schema/users";
import { UserSchema } from "@/gen/heveta/v1/auth_pb";

import { avatarUrl } from "./avatar";

export const userResource = (row: User) =>
	create(UserSchema, {
		id: row.id,
		username: row.username,
		revision: row.revision,
		email: row.email,
		createTime: timestampFromDate(row.createdAt),
		updateTime: timestampFromDate(row.updatedAt),
		avatarUrl: avatarUrl(row.id, row.avatarVersion),
	});

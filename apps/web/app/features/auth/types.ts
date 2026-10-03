export interface User {
	id: string;
	username: string;
	email: string;
	// Empty when there is no profile photo (modules/auth/avatar.ts).
	avatarUrl: string;
	revision: number;
}

export interface SessionOwner {
	userId: string;
	sessionVersion: number;
}

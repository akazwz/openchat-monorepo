// Cloudflare renews this lifetime on each restore; every save creates a new
// immutable snapshot. The handle, not the filesystem bytes, lives in the DO.
export const filesystemTtlMs = 30 * 24 * 60 * 60 * 1000;

export interface Filesystem {
	snapshot: ContainerSnapshot;
	image: string;
	expiresAt: number;
}

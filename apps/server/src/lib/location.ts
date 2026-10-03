// Where the Durable Objects are created: in western North America, next to
// the database (PlanetScale, AWS us-west-2 in Oregon), which each of them
// queries at every step of its work. Without a hint an object is created near
// the request that first reaches it, and stays there for good. The Worker
// itself runs in that region too (`placement` in cloudflare.config.ts).
export const objectLocation = { locationHint: "wnam" } as const;

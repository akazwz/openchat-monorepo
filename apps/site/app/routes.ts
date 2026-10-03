import { index, type RouteConfig, route } from "@react-router/dev/routes";

// One page in each language (copy.ts).
export default [
	index("routes/home.tsx", { id: "home-en" }),
	route("zh", "routes/home.tsx", { id: "home-zh" }),
] satisfies RouteConfig;

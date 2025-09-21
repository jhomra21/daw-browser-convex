import { createAuthClient } from "better-auth/solid";

// Configure the base URL of your auth server (Cloudflare Worker).
// In dev, set VITE_AUTH_BASE_URL to your worker URL, e.g. http://localhost:8787
const baseURL = (import.meta as any).env?.VITE_AUTH_BASE_URL || window.location.origin;

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    // Ensure cookies are sent across origins (dev server <-> worker)
    credentials: "include",
  },
});

export type AuthClient = typeof authClient;

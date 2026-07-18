import { createAuthClient } from "better-auth/solid";

// Configure the base URL of your auth server (Cloudflare Worker).
// In dev, set VITE_AUTH_BASE_URL to your worker URL, e.g. http://localhost:8787
const configuredBaseURL = (import.meta as any).env?.VITE_AUTH_BASE_URL;
const baseURL = configuredBaseURL || (window.location.protocol === "daw:" ? "http://localhost:3000" : window.location.origin);

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    // Ensure cookies are sent across origins (dev server <-> worker)
    credentials: "include",
  },
});

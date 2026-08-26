import { createFileRoute } from "@tanstack/solid-router";
import { For, Show, createMemo, createSignal } from "solid-js";
import { isJsonObject, isJsonString, type JsonValue } from "@daw-browser/shared";

const Consent = () => {
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const params = createMemo(() => new URLSearchParams(window.location.search));
  const requestedScopes = createMemo(() => (params().get("scope") ?? "").split(" ").filter(Boolean));
  const resource = createMemo(() => params().get("resource") ?? "");
  const clientId = createMemo(() => params().get("client_id") ?? "");

  const submit = async (accept: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accept,
          oauth_query: (() => {
            const query = new URLSearchParams(window.location.search);
            query.delete("resource");
            return query.toString();
          })(),
        }),
      });
      const body: JsonValue = await response.json();
      if (
        !response.ok
        || !isJsonObject(body)
        || !isJsonString(body.redirect_uri)
      ) {
        throw new Error("Unable to complete consent.");
      }
      window.location.assign(body.redirect_uri);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to complete consent.");
      setSubmitting(false);
    }
  };

  return (
    <main class="min-h-svh bg-neutral-950 p-6 text-neutral-100">
      <section class="mx-auto max-w-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <h1 class="text-2xl font-semibold">Authorize control access</h1>
        <p class="mt-3 text-sm text-neutral-300">
          <strong>{clientId() || "Unknown client"}</strong> requests access to your DAW controls.
        </p>
        <dl class="mt-6 space-y-4 text-sm">
          <div>
            <dt class="font-medium text-neutral-200">Resource</dt>
            <dd class="mt-1 break-all text-neutral-400">{resource()}</dd>
          </div>
          <div>
            <dt class="font-medium text-neutral-200">Requested permissions</dt>
            <dd class="mt-1">
              <ul class="list-inside list-disc text-neutral-400">
                <For each={requestedScopes()}>{(scope) => <li>{scope}</li>}</For>
              </ul>
            </dd>
          </div>
        </dl>
        <Show when={error()}>
          {(message) => <p class="mt-5 text-sm text-red-300" role="alert">{message()}</p>}
        </Show>
        <div class="mt-8 flex gap-3">
          <button
            class="border border-neutral-600 px-4 py-2 text-sm font-medium hover:bg-neutral-800 disabled:opacity-50"
            disabled={submitting()}
            onClick={() => void submit(false)}
            type="button"
          >
            Deny
          </button>
          <button
            class="bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
            disabled={submitting()}
            onClick={() => void submit(true)}
            type="button"
          >
            Approve
          </button>
        </div>
      </section>
    </main>
  );
};

export const Route = createFileRoute("/oauth/consent")({
  component: Consent,
});

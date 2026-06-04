import { type Component, Show, createSignal } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { authClient } from '~/lib/auth-client';
import { normalizeAppRedirect, readAuthRedirectSearch } from '~/lib/auth-redirect';
import { LoginMethodButton } from '~/components/LoginMethodButton';
import { useSessionQuery } from '~/lib/session';
import { Button } from '~/components/ui/button';
import { queryClient } from '~/lib/query-client';
import Icon from '~/components/ui/Icon';

const Login: Component = () => {
  const session = useSessionQuery();
  const search = Route.useSearch();
  const [loadingGoogle, setLoadingGoogle] = createSignal(false);
  const [signInError, setSignInError] = createSignal<string | null>(null);
  const redirectTarget = () => normalizeAppRedirect(search().redirect);

  async function signInWithGoogle() {
    try {
      setLoadingGoogle(true);
      setSignInError(null);
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: redirectTarget(),
        // errorCallbackURL: '/login', // optional: land back here on error
      });
      // Note: The above triggers a redirect flow. No further action required here.
    } catch (err) {
      // Better Auth client usually surfaces errors via returned object or callbacks.
      // This is a safety net in case something throws.
      console.error('Google sign-in error:', err);
      setSignInError('Failed to start Google sign-in. Please try again.');
      setLoadingGoogle(false);
    }
  }

  async function signOut() {
    await authClient.signOut();
    // Immediately reflect logout in the cache to avoid stale session usage
    queryClient.setQueryData(['session'], null);
  }

  return (
    <div class="min-h-svh flex items-center justify-center bg-neutral-950 text-white p-6">
      <div class="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
        <Show when={!session.data} fallback={<div class="text-xl font-semibold italic">Welcome</div>}>
          <h1 class="text-2xl font-semibold mb-2">Sign in</h1>
          <p class="text-neutral-400 mb-6">Use your Google account to continue.</p>
          <Show when={signInError()}>
            {(message) => (
              <div class="mb-4 rounded-md border border-red-900/70 bg-red-950/40 p-3 text-sm text-red-200">
                {message()}
              </div>
            )}
          </Show>
        </Show>

        <Show
          when={session.data}
          fallback={
            <LoginMethodButton
              label="Continue with Google"
              onClick={signInWithGoogle}
              loading={loadingGoogle()}
              disabled={loadingGoogle()}
              icon={<Icon name="google" size={20} class="mr-2" ariaLabel="Google" />}
            />
          }
        >
          <div class="space-y-4">
            <div class="rounded-md border border-neutral-800 bg-neutral-950 p-3">
              <div class="text-sm text-neutral-400">Signed in as</div>
              <div class="font-medium">{session.data?.user?.email}</div>
            </div>
            <div class="flex gap-2">
              <Button
                class="inline-flex items-center justify-center rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700"
                onClick={() => {
                  window.location.assign(redirectTarget())
                }}
              >
                Go to app
              </Button>
              <Button onClick={signOut} class="inline-flex items-center justify-center rounded-md border border-neutral-700 px-4 py-2 hover:bg-neutral-800">
                Sign out
              </Button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

export const Route = createFileRoute('/Login')({
  validateSearch: readAuthRedirectSearch,
  component: Login,
});

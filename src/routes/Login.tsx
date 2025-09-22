import { type Component, Show, createSignal } from 'solid-js';
import { Link, createFileRoute } from '@tanstack/solid-router';
import { authClient } from '~/lib/auth-client';
import { LoginMethodButton } from '~/components/LoginMethodButton';
import { useSessionQuery } from '~/lib/session';
import { Button } from '~/components/ui/button';
import { queryClient } from '~/lib/query-client';

const Login: Component = () => {
  const session = useSessionQuery();
  const [loadingGoogle, setLoadingGoogle] = createSignal(false);

  async function signInWithGoogle() {
    try {
      setLoadingGoogle(true);
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: '/',
        // errorCallbackURL: '/login', // optional: land back here on error
      });
      // Note: The above triggers a redirect flow. No further action required here.
    } catch (err) {
      // Better Auth client usually surfaces errors via returned object or callbacks.
      // This is a safety net in case something throws.
      console.error('Google sign-in error:', err);
      alert('Failed to start Google sign-in. Please try again.');
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
        <Show when={!session()?.data} fallback={<div class="text-xl font-semibold italic">Welcome</div>}>
          <h1 class="text-2xl font-semibold mb-2">Sign in</h1>
          <p class="text-neutral-400 mb-6">Use your Google account to continue.</p>
        </Show>

        <Show
          when={session()?.data}
          fallback={
            <LoginMethodButton
              label="Continue with Google"
              onClick={signInWithGoogle}
              loading={loadingGoogle()}
              disabled={loadingGoogle()}
              icon={
                <svg aria-hidden="true" viewBox="0 0 24 24" class="h-5 w-5">
                  <path fill="#EA4335" d="M12 11h11c.1.6.1 1.1.1 1.7 0 6-4 10.3-11.1 10.3A11.9 11.9 0 0 1 0 12 11.9 11.9 0 0 1 12 0a11.3 11.3 0 0 1 7.7 3l-3.2 3.1A6.7 6.7 0 0 0 12 3.6c-4.2 0-7.6 3.5-7.6 7.7s3.4 7.7 7.6 7.7c4 0 6.7-2.3 7.2-5.5H12V11Z" />
                </svg>
              }
            />
          }
        >
          <div class="space-y-4">
            <div class="rounded-md border border-neutral-800 bg-neutral-950 p-3">
              <div class="text-sm text-neutral-400">Signed in as</div>
              <div class="font-medium">{session()?.data?.user?.email}</div>
            </div>
            <div class="flex gap-2">
              <Button as={Link} to="/" class="inline-flex items-center justify-center rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700">
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
  component: Login,
});

import { type Component, Show, createSignal } from 'solid-js';
import { Link, createFileRoute } from '@tanstack/solid-router';
import { authClient } from '~/lib/auth-client';
import { LoginMethodButton } from '~/components/LoginMethodButton';
import { useSessionQuery } from '~/lib/session';
import { Button } from '~/components/ui/button';
import { queryClient } from '~/lib/query-client';
import Icon from '~/components/ui/Icon';

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
              icon={<Icon name="google" size={20} class="mr-2" ariaLabel="Google" />}
            />
          }
        >
          <div class="space-y-4">
            <div class="rounded-md border border-neutral-800 bg-neutral-950 p-3">
              <div class="text-sm text-neutral-400">Signed in as</div>
              <div class="font-medium">{session()?.data?.user?.email}</div>
            </div>
            <div class="flex gap-2">
              <Button class="inline-flex items-center justify-center rounded-md bg-neutral-800 px-4 py-2 hover:bg-neutral-700">
                <Link to="/">Go to app</Link>
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

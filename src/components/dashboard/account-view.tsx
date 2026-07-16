import { Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";

export function DashboardAccountView() {
  const session = useSessionQuery();
  const signOut = async () => {
    try {
      await authClient.signOut();
    } finally {
      queryClient.setQueryData(["session"], null);
    }
  };
  const user = () => session.data?.user;
  const loginUrl = () =>
    `/Login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`;

  return (
    <DashboardScrollView>
      <Show when={!session.isPending} fallback={<p class="px-1 text-sm text-muted-foreground">Loading account...</p>}>
        <Show
          when={user()}
          fallback={
            <>
              <div class="px-1">
                <h2 class="text-2xl font-semibold tracking-tight text-foreground">You’re not signed in</h2>
                <p class="mt-2 max-w-xl text-sm text-muted-foreground">
                  You can keep making music with local projects. Sign in or create an account to open cloud and shared projects.
                </p>
                <Button as="a" href={loginUrl()} class="mt-5">
                  Sign in or create account
                </Button>
              </div>

              <DashboardSection title="Working without an account">
                <DashboardRow
                  label="Local projects"
                  value="Available without signing in and stored on this device."
                />
                <DashboardRow
                  label="Cloud and shared projects"
                  value="Sign in is required to open projects stored in the cloud or shared with you."
                />
              </DashboardSection>
            </>
          }
          keyed
        >
          {(u) => (
            <DashboardSection title="Account" description="Current authenticated session.">
              <DashboardRow label="Name" value={u.name || "No name on session"} />
              <DashboardRow label="Email" value={u.email || "No email on session"} />
              <DashboardRow
                label="Session"
                value="Signed in"
                action={
                  <Button size="sm" variant="secondary" onClick={() => void signOut()}>
                    Sign out
                  </Button>
                }
              />
            </DashboardSection>
          )}
        </Show>
      </Show>
    </DashboardScrollView>
  );
}

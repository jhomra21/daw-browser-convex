import { Show } from "solid-js";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth-client";
import { queryClient } from "~/lib/query-client";
import { useSessionQuery } from "~/lib/session";
import { DashboardRow, DashboardScrollView, DashboardSection } from "./dashboard-shared";

export function DashboardAccountView() {
  const session = useSessionQuery();
  const signOut = async () => { await authClient.signOut(); queryClient.setQueryData(["session"], null); };
  const user = () => session.data?.user;
  return <DashboardScrollView><DashboardSection title="Account" description="Current authenticated session."><Show when={user()} fallback={<DashboardRow label="Not signed in" value="Local projects can be used without an account." />} keyed>{(u) => <><DashboardRow label="Name" value={u.name || "No name on session"} /><DashboardRow label="Email" value={u.email || "No email on session"} /><DashboardRow label="Session" value="Signed in" action={<Button size="sm" variant="secondary" onClick={() => void signOut()}>Sign out</Button>} /></>}</Show></DashboardSection></DashboardScrollView>;
}

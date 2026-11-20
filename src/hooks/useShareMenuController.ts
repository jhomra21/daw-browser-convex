import { type Accessor, createSignal } from "solid-js";
import { copyText } from "~/lib/clipboard";
import { listProjectMembers, revokeProjectMember } from "~/lib/cloud-projects-api";

type UseShareMenuControllerOptions = {
  onShare?: () => string | void | Promise<string | void>;
  projectId: Accessor<string>;
};

export function useShareMenuController(options: UseShareMenuControllerOptions) {
  const [shareUrl, setShareUrl] = createSignal("");
  const [shareError, setShareError] = createSignal("");
  const [members, setMembers] = createSignal<Awaited<ReturnType<typeof listProjectMembers>>>([]);
  const [membersLoading, setMembersLoading] = createSignal(false);
  const [membersError, setMembersError] = createSignal("");
  const [revokingMemberId, setRevokingMemberId] = createSignal("");

  const reset = () => {
    setShareUrl("");
    setShareError("");
    setMembers([]);
    setMembersLoading(false);
    setMembersError("");
    setRevokingMemberId("");
  };

  const createShareUrl = async () => {
    setShareError("");

    try {
      setShareUrl(await Promise.resolve(options.onShare?.()) ?? "");
    } catch {
      setShareUrl("");
      setShareError("Share invite could not be created.");
    }
  };

  const loadMembers = async () => {
    setMembersLoading(true);
    const projectId = options.projectId();
    setMembersError("");

    try {
      const nextMembers = await listProjectMembers(projectId);

      if (options.projectId() !== projectId) return;
      setMembers(nextMembers);
    } catch {
      if (options.projectId() !== projectId) return;
      setMembers([]);
      setMembersError("Members could not be loaded.");
    } finally {
      if (options.projectId() === projectId) {
        setMembersLoading(false);
      }
    }
  };

  const copy = async () => {
    const currentShareUrl = shareUrl();

    if (!currentShareUrl) return false;
    await copyText(currentShareUrl);

    return true;
  };

  const revokeMember = async (targetUserId: string) => {
    const projectId = options.projectId();

    if (!projectId || !targetUserId) return;
    const isCurrentProject = () => options.projectId() === projectId;
    setMembersError("");
    setRevokingMemberId(targetUserId);

    try {
      await revokeProjectMember(projectId, targetUserId);

      if (!isCurrentProject()) return;
      setMembers((current) => {
        if (!current.some((member) => member.userId === targetUserId)) return current;

        return current.filter((member) => member.userId !== targetUserId);
      });
    } catch {
      if (!isCurrentProject()) return;
      setMembersError("Member could not be removed.");
    } finally {
      if (isCurrentProject() && revokingMemberId() === targetUserId) {
        setRevokingMemberId("");
      }
    }
  };

  return {
    shareUrl,
    shareError,
    members,
    membersLoading,
    membersError,
    revokingMemberId,
    reset,
    createShareUrl,
    loadMembers,
    copy,
    revokeMember,
  };
}

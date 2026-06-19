import { type Accessor, createSignal } from "solid-js";
import { copyText } from "~/lib/clipboard";

type ProjectMember = {
  userId: string;
  role: "editor" | "viewer";
};

type UseShareMenuControllerOptions = {
  onShare?: () => string | void | Promise<string | void>;
  projectId: Accessor<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const readProjectMembers = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.members)) return null;
  return value.members.flatMap((member): ProjectMember[] => {
    if (!isRecord(member) || typeof member.userId !== "string") return [];
    if (member.role !== "editor" && member.role !== "viewer") return [];
    return [{ userId: member.userId, role: member.role }];
  });
};

export function useShareMenuController(options: UseShareMenuControllerOptions) {
  const [shareUrl, setShareUrl] = createSignal("");
  const [shareError, setShareError] = createSignal("");
  const [members, setMembers] = createSignal<ProjectMember[]>([]);
  const [membersLoading, setMembersLoading] = createSignal(false);
  const [membersError, setMembersError] = createSignal("");
  const [revokingMemberId, setRevokingMemberId] = createSignal("");

  const reset = () => {
    setShareUrl("");
    setShareError("");
    setMembers([]);
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
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/members`);
      const nextMembers = readProjectMembers(await response.json().catch(() => null));
      if (!response.ok || !nextMembers) throw new Error("Members could not be loaded.");
      if (options.projectId() !== projectId) return;
      setMembers(nextMembers);
    } catch {
      if (options.projectId() !== projectId) return;
      setMembers([]);
      setMembersError("Members could not be loaded.");
    } finally {
      if (options.projectId() !== projectId) return;
      setMembersLoading(false);
    }
  };

  const load = async () => {
    await Promise.all([createShareUrl(), loadMembers()]);
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
    setMembersError("");
    setRevokingMemberId(targetUserId);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(targetUserId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Member could not be removed.");
      setMembers((current) => current.filter((member) => member.userId !== targetUserId));
    } catch {
      setMembersError("Member could not be removed.");
    } finally {
      setRevokingMemberId("");
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
    load,
    loadMembers,
    copy,
    revokeMember,
  };
}

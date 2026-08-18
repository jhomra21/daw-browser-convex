import { type Accessor, createSignal } from "solid-js";
import { isJsonObject, isJsonString, parseJsonValue, type JsonValueInput } from "@daw-browser/shared";
import { copyText } from "~/lib/clipboard";

type ProjectMember = {
  userId: string;
  role: "editor" | "viewer";
};

type UseShareMenuControllerOptions = {
  onShare?: () => string | void | Promise<string | void>;
  projectId: Accessor<string>;
};

const readProjectMembers = (value: JsonValueInput) => {
  const parsed = parseJsonValue(value);
  if (!isJsonObject(parsed) || !Array.isArray(parsed.members)) return null;
  return parsed.members.flatMap((member): ProjectMember[] => {
    if (!isJsonObject(member) || !isJsonString(member.userId)) return [];
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
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(targetUserId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Member could not be removed.");
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

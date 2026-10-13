import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import { detectVcsBackend, resolveJjRepoIdentity } from "../utils/vcs-backend.js";
import {
  assertJjWorkspaceIncarnation,
  readJjWorkspaceIncarnation,
} from "../utils/worktree-metadata.js";
import { listJjWorkspaces } from "../utils/worktree-jj.js";
import { createRealpathAwarePathMatcher } from "../utils/path.js";
import { workspaceLifecycleKey } from "../utils/workspace-lifecycle.js";
import { isPaseoOwnedWorktreeCwd } from "../utils/worktree.js";

export type JjWorkspaceAuthority = "managed" | "external" | "unknown";

export function jjWorkspaceAuthority(workspace: PersistedWorkspaceRecord): JjWorkspaceAuthority {
  const evidence = Boolean(workspace.jjWorkspaceId || workspace.recoveryBookmark);
  if (workspace.jjWorkspaceManagement === "external" && evidence)
    throw new Error("External jj workspace contradicts retained managed incarnation authority");
  if (evidence || workspace.jjWorkspaceManagement === "managed") return "managed";
  return workspace.jjWorkspaceManagement ?? "unknown";
}

export function hasDurableJjAuthority(
  workspace: Partial<
    Pick<PersistedWorkspaceRecord, "jjWorkspaceManagement" | "jjWorkspaceId" | "recoveryBookmark">
  >,
): boolean {
  return Boolean(
    workspace.jjWorkspaceManagement || workspace.jjWorkspaceId || workspace.recoveryBookmark,
  );
}

export function jjWorkspaceBackingRoot(workspace: PersistedWorkspaceRecord): string {
  return (
    workspace.worktreeRoot ?? resolveJjRepoIdentity(workspace.cwd)?.workspaceRoot ?? workspace.cwd
  );
}

export function sameJjWorkspaceAuthority(
  left: PersistedWorkspaceRecord,
  right: PersistedWorkspaceRecord,
): boolean {
  return (
    left.jjWorkspaceManagement === right.jjWorkspaceManagement &&
    left.jjWorkspaceId === right.jjWorkspaceId &&
    left.recoveryBookmark === right.recoveryBookmark &&
    left.cwd === right.cwd &&
    left.worktreeRoot === right.worktreeRoot &&
    left.mainRepoRoot === right.mainRepoRoot &&
    left.projectId === right.projectId
  );
}

function hasJjManagementMarker(root: string): boolean {
  return (
    Boolean(readJjWorkspaceIncarnation(root)) ||
    existsSync(join(root, ".jj", "paseo", "worktree.json"))
  );
}

/** Present checkouts never acquire authority from their current pathname or topology. */
export async function validatePresentJjWorkspace(
  workspace: PersistedWorkspaceRecord,
): Promise<JjWorkspaceAuthority> {
  const authority = jjWorkspaceAuthority(workspace);
  const root = jjWorkspaceBackingRoot(workspace);
  const liveJj =
    detectVcsBackend(root) === "jj" ||
    detectVcsBackend(workspace.cwd) === "jj" ||
    Boolean(
      workspace.kind === "worktree" &&
      workspace.mainRepoRoot &&
      detectVcsBackend(workspace.mainRepoRoot) === "jj",
    );
  if (authority === "external") {
    if (hasJjManagementMarker(root))
      throw new Error(
        "External jj workspace now has contradictory managed metadata; refusing adoption",
      );
    if (!existsSync(workspace.cwd))
      throw new Error("The external jj workspace directory is missing and cannot be recreated");
    return authority;
  }
  if (authority === "unknown") {
    if (liveJj || hasJjManagementMarker(root)) assertJjWorkspaceIncarnation(root, undefined);
    return authority;
  }
  await validateManagedJjWorkspace(workspace, root);
  return authority;
}

async function validateManagedJjWorkspace(
  workspace: PersistedWorkspaceRecord,
  root: string,
): Promise<void> {
  const identity = resolveJjRepoIdentity(root);
  assertJjWorkspaceIncarnation(root, workspace.jjWorkspaceId ?? workspace.recoveryBookmark);
  const source = workspace.mainRepoRoot ?? identity?.primaryRoot;
  if (
    !identity ||
    !source ||
    detectVcsBackend(source) !== "jj" ||
    workspaceLifecycleKey(identity.workspaceRoot) !== workspaceLifecycleKey(root) ||
    workspaceLifecycleKey(identity.primaryRoot) !== workspaceLifecycleKey(source)
  )
    throw new Error(
      "Managed jj backing or source repository changed; retained authority was not changed",
    );
  const cwdIdentity = resolveJjRepoIdentity(workspace.cwd);
  if (
    !cwdIdentity ||
    cwdIdentity.sharedStorePath !== identity.sharedStorePath ||
    workspaceLifecycleKey(cwdIdentity.workspaceRoot) !== workspaceLifecycleKey(root)
  )
    throw new Error("Managed jj selected directory no longer belongs to its backing checkout");
  const matches = createRealpathAwarePathMatcher(root);
  if (!(await listJjWorkspaces(source)).some((entry) => matches(entry.root)))
    throw new Error(
      "The backing jj workspace is no longer registered; use workspace recovery before reopening it",
    );
}

export interface FreshJjAuthorityInput {
  workspace: PersistedWorkspaceRecord;
  siblings: PersistedWorkspaceRecord[];
  paseoHome?: string;
  worktreesRoot?: string;
  createdWorktree: boolean;
}

/** Fresh allocation is the only ordinary operation that establishes provenance. */
export async function establishFreshJjAuthority(
  input: FreshJjAuthorityInput,
): Promise<PersistedWorkspaceRecord> {
  const root = jjWorkspaceBackingRoot(input.workspace);
  if (detectVcsBackend(root) !== "jj") return input.workspace;
  const incarnation = readJjWorkspaceIncarnation(root);
  const ownership = await isPaseoOwnedWorktreeCwd(root, {
    paseoHome: input.paseoHome,
    worktreesRoot: input.worktreesRoot,
    knownGitCommonDir: null,
  });
  const managed = input.createdWorktree || ownership.allowed || hasJjManagementMarker(root);
  const matches = createRealpathAwarePathMatcher(root);
  const siblings = input.siblings.filter((record) => matches(jjWorkspaceBackingRoot(record)));
  if (!input.createdWorktree) {
    for (const sibling of siblings) {
      const authority = jjWorkspaceAuthority(sibling);
      if (authority === "unknown")
        throw new Error("Unknown legacy jj sibling authority; refusing fresh adoption");
      if (authority === "external" && managed)
        throw new Error("External jj sibling contradicts managed checkout evidence");
      if (authority === "managed" && !managed)
        throw new Error("Managed jj sibling authority cannot be downgraded");
      if (authority === "managed")
        assertJjWorkspaceIncarnation(root, sibling.jjWorkspaceId ?? sibling.recoveryBookmark);
    }
  }
  const workspace: PersistedWorkspaceRecord = {
    ...input.workspace,
    jjWorkspaceManagement: managed ? "managed" : "external",
    ...(managed && incarnation ? { jjWorkspaceId: incarnation } : {}),
  };
  await validatePresentJjWorkspace(workspace);
  return workspace;
}

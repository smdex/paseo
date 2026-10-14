import type { Logger } from "pino";
import { createNameId } from "mnemonic-id";

import type { ForgeService, ForgeRepositoryContext } from "../services/forge-service.js";
import {
  createWorktree,
  slugify,
  validateBranchSlug,
  type CreatedWorktree,
} from "../utils/worktree.js";
import { resolveJjRepoIdentity } from "../utils/vcs-backend.js";
import { getJjStatus } from "../utils/checkout-jj.js";
import { createJjWorktree, JjWorkspaceSourceError } from "../utils/worktree-jj.js";
import { resolveEffectiveBackend } from "../utils/checkout-dispatch.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@getpaseo/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import { runWithGitCommandPriority } from "../utils/run-git-command.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  paseoHome?: string;
  worktreesRoot?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  logger?: Pick<Logger, "warn">;
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  onJjWorktreeCreated?: (result: CreateWorktreeCoreResult) => Promise<void>;
}

export interface CreateWorktreeCoreResult {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  return runWithGitCommandPriority("high", () => createWorktreeCoreWithPriority(input, deps));
}

async function createWorktreeCoreWithPriority(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const backend = await resolveEffectiveBackend(input.cwd);
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const requestedBranchName = input.branchName?.trim();

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (input.checkoutSource !== undefined || input.githubPrNumber !== undefined) {
    intentInput = {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    const worktreeSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId());
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      branchName: requestedBranchName,
      worktreeSlug,
    };
  }

  const { intent, forgeRepository } = await resolveCreationSource(
    input,
    deps,
    intentInput,
    repoRoot,
    backend,
  );
  let normalizedSlug: string;

  switch (intent.kind) {
    case "branch-off": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-branch": {
      normalizedSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.branchName);
      break;
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      normalizedSlug =
        requestedWorktreeSlug ?? normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
      break;
    }
  }

  const onJjWorktreeCreated = deps.onJjWorktreeCreated;
  return {
    worktree: await createWorktreeForBackend({
      cwd: backend === "jj" ? input.cwd : repoRoot,
      worktreeSlug: normalizedSlug,
      source: intent,
      forgeRepository,
      runSetup: input.runSetup ?? true,
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
      logger: deps.logger,
      onCreated: onJjWorktreeCreated
        ? (worktree) => onJjWorktreeCreated({ worktree, intent, repoRoot, created: true })
        : undefined,
    }),
    intent,
    repoRoot,
    created: true,
  };
}

async function resolveCreationSource(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
  repoRoot: string,
  backend: Awaited<ReturnType<typeof resolveEffectiveBackend>>,
): Promise<{ intent: WorktreeCreationIntent; forgeRepository?: ForgeRepositoryContext }> {
  const nativePr =
    backend === "jj" && (input.checkoutSource !== undefined || input.githubPrNumber !== undefined);
  let forge: { forge: string; service: ForgeService; repository?: ForgeRepositoryContext };
  let intent: WorktreeCreationIntent;
  try {
    forge =
      backend === "jj" && !nativePr
        ? { forge: "github", service: deps.github }
        : await resolveForge(backend === "jj" ? input.cwd : repoRoot, deps, intentInput);
    if (nativePr && !forge.repository)
      throw new Error("Select an unambiguous jj forge repository before opening a pull request");
    intent = await resolveWorktreeCreationIntent(
      nativePr ? { ...intentInput, refName: undefined } : intentInput,
      repoRoot,
      {
        forge: forge.forge,
        forgeService: forge.service,
        repository: forge.repository,
        resolveDefaultBranch: (root) => resolveDefaultBranch(input, deps, root),
      },
    );
  } catch (error) {
    if (nativePr) throw new JjWorkspaceSourceError(error);
    throw error;
  }
  return { intent, forgeRepository: forge.repository };
}

/**
 * Backend routing for worktree creation: jj repositories get jj workspaces
 * with the same creation intent and registry lifecycle as Git worktrees.
 */
async function createWorktreeForBackend(input: {
  cwd: string;
  worktreeSlug: string;
  source: Parameters<typeof createWorktree>[0]["source"];
  forgeRepository?: ForgeRepositoryContext;
  runSetup: boolean;
  onCreated?: (worktree: CreatedWorktree) => Promise<void>;
  logger?: Pick<Logger, "warn">;
  paseoHome?: string;
  worktreesRoot?: string;
}): Promise<CreatedWorktree> {
  if ((await resolveEffectiveBackend(input.cwd)) === "jj") {
    const identity = resolveJjRepoIdentity(input.cwd);
    if (!identity) throw new Error("Unable to resolve jj repository identity");
    return createJjWorktree({ ...input, cwd: identity.workspaceRoot });
  }
  return createWorktree(input);
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService; repository?: ForgeRepositoryContext }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return {
    forge: resolution.forge,
    service: resolution.service,
    repository: resolution.repository,
  };
}

async function resolveDefaultBranch(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
  repoRoot: string,
): Promise<string> {
  if ((await resolveEffectiveBackend(input.cwd)) === "jj") {
    const status = await getJjStatus(input.cwd, {
      paseoHome: input.paseoHome,
      worktreesRoot: input.worktreesRoot,
    });
    if (!status.isGit || !status.defaultWorkspaceBase)
      throw new Error("Unable to resolve jj workspace base");
    return status.defaultWorkspaceBase.refName;
  }
  const baseBranchPromise = deps.resolveDefaultBranch
    ? deps.resolveDefaultBranch(repoRoot)
    : deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  const baseBranch = await baseBranchPromise?.catch(() => null);
  if (!baseBranch) throw new Error("Unable to resolve repository default branch");
  return baseBranch;
}

export async function resolveWorktreeRepoRoot(
  input: CreateWorktreeCoreInput,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  if ((await resolveEffectiveBackend(input.cwd)) === "jj") {
    const identity = resolveJjRepoIdentity(input.cwd);
    if (!identity) throw new Error("Unable to resolve jj repository identity");
    return identity.primaryRoot;
  }
  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}

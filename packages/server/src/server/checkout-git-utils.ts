import { ForgeCommandError } from "../services/forge-cli-command.js";
import type { CheckoutError } from "@getpaseo/protocol/messages";
import { JjRewriteApprovalRequiredError } from "../utils/jj-checkpoint.js";
import {
  MergeConflictError,
  MergeFromBaseConflictError,
  NotGitRepoError,
} from "../utils/checkout-git.js";
import { NotSupportedOnJjError } from "../utils/checkout-dispatch.js";
import { runGitCommand } from "../utils/run-git-command.js";

export const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

export async function resolveCheckoutGitDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGitCommand(["rev-parse", "--absolute-git-dir"], {
      cwd,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const gitDir = stdout.trim();
    return gitDir.length > 0 ? gitDir : null;
  } catch {
    return null;
  }
}

export function toCheckoutError(error: unknown): CheckoutError {
  if (error instanceof JjRewriteApprovalRequiredError) {
    return { code: "NOT_ALLOWED", message: error.message, reason: "rewrite_approval_required" };
  }
  if (error instanceof NotSupportedOnJjError) {
    return { code: "NOT_ALLOWED", message: error.message };
  }
  if (error instanceof NotGitRepoError) {
    return { code: "NOT_GIT_REPO", message: error.message };
  }
  if (error instanceof MergeConflictError) {
    return { code: "MERGE_CONFLICT", message: error.message };
  }
  if (error instanceof MergeFromBaseConflictError) {
    return { code: "MERGE_CONFLICT", message: error.message };
  }
  if (error instanceof ForgeCommandError) {
    const detail = error.stderr.trim();
    const message = detail ? `${error.message}\n${detail}` : error.message;
    return { code: "UNKNOWN", message };
  }
  if (error instanceof Error) {
    return { code: "UNKNOWN", message: error.message };
  }
  return { code: "UNKNOWN", message: String(error) };
}

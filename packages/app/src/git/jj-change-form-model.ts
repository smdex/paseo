import {
  CheckoutOperationError,
  type FetchRebaseResult,
  type IntegrateBaseResult,
} from "@getpaseo/client/internal/daemon-client";

export interface JjChangeFormSnapshot {
  serverId: string;
  cwd: string;
  changeId: string;
  description: string;
  mode: "describe" | "edit" | "new-on" | "new" | "fetch-rebase" | "integrate";
  baseRef?: string;
}
export interface JjChangeSelection {
  changeId: string;
  label: string;
  commitId?: string;
}
export interface JjChangeFormState extends JjChangeFormSnapshot {
  draft: string;
  targetChangeId: string | null;
  targetChangeLabel: string | null;
  targetCommitId: string | null;
  status: "idle" | "pending" | "success" | "error";
  error: string | null;
  canSubmit: boolean;
  needsRewriteApproval: boolean;
  outcome?: FetchRebaseResult["outcome"];
  integrationOutcome?: IntegrateBaseResult["outcome"];
  integrationCapture?: { commitId: string; baseCommitId: string };
}
export interface JjChangeFormPorts {
  describe(input: {
    cwd: string;
    message: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<void>;
  edit(input: {
    cwd: string;
    changeId: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<void>;
  newChange(input: {
    cwd: string;
    message: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<void>;
  newOn(input: {
    cwd: string;
    /** Exact commit the new change starts on (captured from history). */
    targetCommitId: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<void>;
  fetchAndRebase(input: {
    cwd: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<NonNullable<FetchRebaseResult["outcome"]>>;
  integrate(input: {
    cwd: string;
    baseRef: string;
    expectedChangeId: string;
    expectedCommitId?: string;
    expectedBaseCommitId?: string;
    acknowledgeRewrites: boolean;
  }): Promise<IntegrateBaseResult>;
  refresh(): Promise<void>;
}
export function openJjChangeForm(snapshot: JjChangeFormSnapshot, ports: JjChangeFormPorts) {
  let closed = false;
  let state: JjChangeFormState = {
    ...snapshot,
    draft: snapshot.description,
    targetChangeId: null,
    targetChangeLabel: null,
    targetCommitId: null,
    status: "idle",
    error: null,
    canSubmit: false,
    needsRewriteApproval: false,
  };
  const listeners = new Set<() => void>();
  function publish(next: JjChangeFormState) {
    if (closed) return;
    // Keep the native change identity and display label separate from New-on's
    // exact commit target so history refreshes cannot replace the user's choice.
    const valid =
      (next.mode === "integrate" && Boolean(next.baseRef)) ||
      next.mode === "fetch-rebase" ||
      (next.mode === "describe" || next.mode === "new"
        ? next.draft.trim().length > 0
        : next.targetChangeId !== null && (next.mode !== "new-on" || next.targetCommitId !== null));
    state = {
      ...next,
      canSubmit: valid && next.status !== "pending" && next.status !== "success",
    };
    for (const listener of listeners) listener();
  }
  publish(state);
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(draft: string) {
      if (state.status !== "pending")
        publish({ ...state, draft, status: "idle", error: null, needsRewriteApproval: false });
    },
    selectChange(selection: JjChangeSelection) {
      if (state.status !== "pending")
        publish({
          ...state,
          targetChangeId: selection.changeId,
          targetChangeLabel: selection.label,
          targetCommitId: selection.commitId ?? null,
          status: "idle",
          error: null,
          needsRewriteApproval: false,
        });
    },
    async submit() {
      if (closed || !state.canSubmit) return;
      const submitted = state;
      // Approval applies only to the visible known scope and this captured intent.
      const acknowledgeRewrites = submitted.needsRewriteApproval;
      publish({ ...state, status: "pending", error: null, needsRewriteApproval: false });
      try {
        let outcome: JjChangeFormState["outcome"];
        let integrationOutcome: JjChangeFormState["integrationOutcome"];
        if (submitted.mode === "integrate" && submitted.baseRef) {
          const result = await ports.integrate({
            cwd: submitted.cwd,
            baseRef: submitted.baseRef,
            expectedChangeId: submitted.changeId,
            ...(submitted.integrationCapture
              ? {
                  expectedCommitId: submitted.integrationCapture.commitId,
                  expectedBaseCommitId: submitted.integrationCapture.baseCommitId,
                }
              : {}),
            acknowledgeRewrites,
          });
          const capture = getJjIntegrationCapture(result, submitted.changeId);
          if (capture) publish({ ...state, integrationCapture: capture });
          integrationOutcome = getJjIntegrationOutcome(result);
        } else if (submitted.mode === "fetch-rebase") {
          outcome = await ports.fetchAndRebase({
            cwd: submitted.cwd,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        } else if (submitted.mode === "describe") {
          await ports.describe({
            cwd: submitted.cwd,
            message: submitted.draft,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        } else if (submitted.mode === "new") {
          await ports.newChange({
            cwd: submitted.cwd,
            message: submitted.draft,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        } else if (submitted.mode === "new-on" && submitted.targetCommitId) {
          await ports.newOn({
            cwd: submitted.cwd,
            targetCommitId: submitted.targetCommitId,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        } else if (submitted.targetChangeId) {
          await ports.edit({
            cwd: submitted.cwd,
            changeId: submitted.targetChangeId,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        }
        await ports.refresh();
        publish({
          ...state,
          status: "success",
          ...(outcome ? { outcome } : {}),
          ...(integrationOutcome ? { integrationOutcome } : {}),
        });
      } catch (error) {
        // A refusal may include native partial results; refresh without hiding the captured draft/error.
        await ports.refresh().catch(() => undefined);
        publish({
          ...state,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          needsRewriteApproval:
            error instanceof CheckoutOperationError &&
            error.checkoutError.reason === "rewrite_approval_required",
        });
      }
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

function getJjIntegrationCapture(
  result: IntegrateBaseResult,
  changeId: string,
): JjChangeFormState["integrationCapture"] {
  if (result.error?.reason !== "rewrite_approval_required") return undefined;
  if (result.changeId !== changeId || !result.commitId || !result.baseCommitId)
    throw new Error("The host did not capture both integration heads. Reopen integration.");
  return { commitId: result.commitId, baseCommitId: result.baseCommitId };
}
function getJjIntegrationOutcome(
  result: IntegrateBaseResult,
): NonNullable<IntegrateBaseResult["outcome"]> {
  if (result.error) throw new CheckoutOperationError(result.error);
  if (!result.success || !result.outcome || result.outcome === "conflicts")
    throw new Error("Integration did not complete. Inspect the retained heads on the host.");
  return result.outcome;
}

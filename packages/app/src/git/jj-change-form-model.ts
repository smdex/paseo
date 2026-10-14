import { CheckoutOperationError } from "@getpaseo/client/internal/daemon-client";

export interface JjChangeFormSnapshot {
  serverId: string;
  cwd: string;
  changeId: string;
  description: string;
  mode: "describe" | "edit" | "new-on";
}
export interface JjChangeFormState extends JjChangeFormSnapshot {
  draft: string;
  targetChangeId: string | null;
  status: "idle" | "pending" | "success" | "error";
  error: string | null;
  canSubmit: boolean;
  needsRewriteApproval: boolean;
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
  newOn(input: {
    cwd: string;
    /** Exact commit the new change starts on (captured from history). */
    targetCommitId: string;
    expectedChangeId: string;
    acknowledgeRewrites: boolean;
  }): Promise<void>;
  refresh(): Promise<void>;
}
export function openJjChangeForm(snapshot: JjChangeFormSnapshot, ports: JjChangeFormPorts) {
  let closed = false;
  let state: JjChangeFormState = {
    ...snapshot,
    draft: snapshot.description,
    targetChangeId: null,
    status: "idle",
    error: null,
    canSubmit: false,
    needsRewriteApproval: false,
  };
  const listeners = new Set<() => void>();
  function publish(next: JjChangeFormState) {
    if (closed) return;
    // `targetChangeId` holds the selected history change for edit and the
    // selected commit sha for new-on; both modes submit a target.
    const valid =
      next.mode === "describe" ? next.draft.trim().length > 0 : next.targetChangeId !== null;
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
    selectChange(targetChangeId: string) {
      if (state.status !== "pending")
        publish({
          ...state,
          targetChangeId,
          status: "idle",
          error: null,
          needsRewriteApproval: false,
        });
    },
    async submit() {
      if (!state.canSubmit) return;
      const submitted = state;
      // Approval applies only to the visible known scope and this captured intent.
      const acknowledgeRewrites = submitted.needsRewriteApproval;
      publish({ ...state, status: "pending", error: null, needsRewriteApproval: false });
      try {
        if (submitted.mode === "describe") {
          await ports.describe({
            cwd: submitted.cwd,
            message: submitted.draft,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites,
          });
        } else if (submitted.mode === "new-on" && submitted.targetChangeId) {
          await ports.newOn({
            cwd: submitted.cwd,
            targetCommitId: submitted.targetChangeId,
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
        publish({ ...state, status: "success" });
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

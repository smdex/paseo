export interface JjChangeFormSnapshot {
  serverId: string;
  cwd: string;
  changeId: string;
  description: string;
  mode: "describe" | "edit";
}
export interface JjChangeFormState extends JjChangeFormSnapshot {
  draft: string;
  targetChangeId: string | null;
  status: "idle" | "pending" | "success" | "error";
  error: string | null;
  canSubmit: boolean;
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
  };
  const listeners = new Set<() => void>();
  function publish(next: JjChangeFormState) {
    if (closed) return;
    const valid =
      next.mode === "describe" ? next.draft.trim().length > 0 : next.targetChangeId !== null;
    state = { ...next, canSubmit: valid && next.status !== "pending" && next.status !== "success" };
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
      if (state.status !== "pending") publish({ ...state, draft, status: "idle", error: null });
    },
    selectChange(targetChangeId: string) {
      if (state.status !== "pending")
        publish({ ...state, targetChangeId, status: "idle", error: null });
    },
    async submit() {
      if (!state.canSubmit) return;
      const submitted = state;
      publish({ ...state, status: "pending", error: null });
      try {
        if (submitted.mode === "describe") {
          await ports.describe({
            cwd: submitted.cwd,
            message: submitted.draft,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites: true,
          });
        } else if (submitted.targetChangeId) {
          await ports.edit({
            cwd: submitted.cwd,
            changeId: submitted.targetChangeId,
            expectedChangeId: submitted.changeId,
            acknowledgeRewrites: true,
          });
        }
        await ports.refresh();
        publish({ ...state, status: "success" });
      } catch (error) {
        publish({
          ...state,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

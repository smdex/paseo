import type { CheckoutPrIdentity, CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";

export type JjPrMutationIntent =
  | { kind: "merge"; method: CheckoutPrMergeMethod }
  | { kind: "enable-auto-merge"; method: CheckoutPrMergeMethod }
  | { kind: "disable-auto-merge" };
export interface JjPrMutationSnapshot {
  serverId: string;
  cwd: string;
  identity: CheckoutPrIdentity | null;
  intent: JjPrMutationIntent;
}
export interface JjPrMutationState extends JjPrMutationSnapshot {
  status: "idle" | "pending" | "error" | "success";
  error: string | null;
}
export function openJjPrMutationForm(
  snapshot: JjPrMutationSnapshot,
  ports: {
    mutate(input: JjPrMutationSnapshot): Promise<void>;
    refresh(): Promise<void>;
  },
) {
  let closed = false;
  let state: JjPrMutationState = { ...snapshot, status: "idle", error: null };
  const listeners = new Set<() => void>();
  function publish(next: JjPrMutationState) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit() {
      if (state.status === "pending" || state.status === "success") return;
      publish({ ...state, status: "pending", error: null });
      try {
        await ports.mutate(snapshot);
        publish({ ...state, status: "success", error: null });
        await ports.refresh().catch(() => undefined);
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

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutPrCreateResponse } from "@getpaseo/protocol/messages";

export interface JjPrCreateSnapshot {
  serverId: string;
  cwd: string;
  changeId: string;
  bookmark: string;
}

type CreatedPullRequest = {
  [Key in "url" | "number"]: NonNullable<CheckoutPrCreateResponse["payload"][Key]>;
};
export interface JjPrCreateState extends JjPrCreateSnapshot {
  title: string;
  body: string;
  baseRef: string;
  status: "idle" | "pending" | "error" | "success";
  error: string | null;
  result: CreatedPullRequest | null;
}
export interface JjPrCreatePorts {
  create(
    input: Parameters<DaemonClient["checkoutPrCreate"]>[1] & { cwd: string },
  ): Promise<CreatedPullRequest>;
  refresh(): Promise<void>;
}

export function openJjPrCreateForm(snapshot: JjPrCreateSnapshot, ports: JjPrCreatePorts) {
  let closed = false;
  let state: JjPrCreateState = {
    ...snapshot,
    title: "",
    body: "",
    baseRef: "",
    status: "idle",
    error: null,
    result: null,
  };
  const listeners = new Set<() => void>();
  function publish(next: JjPrCreateState) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function setField(key: "title" | "body" | "baseRef", value: string) {
    if (state.status !== "pending" && state.status !== "success")
      publish({ ...state, [key]: value, status: "idle", error: null });
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setTitle: (value: string) => setField("title", value),
    setBody: (value: string) => setField("body", value),
    setBaseRef: (value: string) => setField("baseRef", value),
    async submit() {
      if (state.status === "pending" || state.status === "success") return;
      const submitted = state;
      publish({ ...state, status: "pending", error: null });
      try {
        const result = await ports.create({
          cwd: submitted.cwd,
          expectedChangeId: submitted.changeId,
          title: submitted.title.trim() || undefined,
          body: submitted.body.trim() || undefined,
          baseRef: submitted.baseRef.trim() || undefined,
        });
        publish({ ...state, status: "success", result });
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

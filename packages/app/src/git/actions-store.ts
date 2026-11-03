import { CheckoutOperationError } from "@getpaseo/client/internal/daemon-client";
import type { CheckoutPrMergeMethod } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { i18n } from "@/i18n/i18next";

const SUCCESS_DISPLAY_MS = 1000;

export type CheckoutGitActionStatus = "idle" | "pending" | "success";

export type CheckoutGitAsyncActionId =
  | "commit"
  | "pull"
  | "push"
  | "pull-and-push"
  | "refresh"
  | "create-pr"
  | "merge-pr-squash"
  | "merge-pr-merge"
  | "merge-pr-rebase"
  | "enable-pr-auto-merge-squash"
  | "enable-pr-auto-merge-merge"
  | "enable-pr-auto-merge-rebase"
  | "disable-pr-auto-merge"
  | "merge-branch"
  | "merge-from-base"
  | "new-change"
  | "discard-changes";

type CheckoutKey = string;
type StatusMap = Partial<Record<CheckoutGitAsyncActionId, CheckoutGitActionStatus>>;

function checkoutKey(serverId: string, cwd: string): CheckoutKey {
  return `${serverId}::${cwd}`;
}

function resolveClient(serverId: string) {
  const session = useSessionStore.getState().sessions[serverId];
  const client = session?.client ?? null;
  if (!client) {
    throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
  }
  return client;
}

type AutoMergeActionsRpc = "forge" | "github";

function resolveAutoMergeActionsRpc(serverId: string): AutoMergeActionsRpc {
  const session = useSessionStore.getState().sessions[serverId];
  if (session?.serverInfo?.features?.checkoutForgeSetAutoMerge === true) {
    return "forge";
  }
  // COMPAT(githubAutoMergeRpc): use the legacy GitHub RPC with daemons that
  // predate checkout.forge.set_auto_merge.*. Remove after 2027-01-17 once the
  // supported daemon floor is >= v0.2.0.
  if (session?.serverInfo?.features?.checkoutGithubSetAutoMerge === true) {
    return "github";
  }
  throw new Error("Update the host to use auto-merge actions.");
}

function setStatus(
  key: CheckoutKey,
  actionId: CheckoutGitAsyncActionId,
  status: CheckoutGitActionStatus,
) {
  useCheckoutGitActionsStore.setState((state) => {
    const current = state.statusByCheckout[key]?.[actionId] ?? "idle";
    if (current === status) {
      return state;
    }
    return {
      ...state,
      statusByCheckout: {
        ...state.statusByCheckout,
        [key]: {
          ...state.statusByCheckout[key],
          [actionId]: status,
        },
      },
    };
  });
}

function invalidateCheckoutGitQueries(serverId: string, cwd: string) {
  return invalidateCheckoutGitQueriesForClient(appQueryClient, { serverId, cwd });
}

const successTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<unknown>>();

function inFlightKey(key: CheckoutKey, actionId: CheckoutGitAsyncActionId): string {
  return `${key}::${actionId}`;
}

interface CheckoutGitActionsStoreState {
  statusByCheckout: Record<CheckoutKey, StatusMap>;
  errorByCheckout: Record<CheckoutKey, string | null>;

  getStatus: (params: {
    serverId: string;
    cwd: string;
    actionId: CheckoutGitAsyncActionId;
  }) => CheckoutGitActionStatus;

  commit: (params: {
    serverId: string;
    cwd: string;
    expectedChangeId?: string;
    acknowledgeRewrites?: boolean;
  }) => Promise<void>;
  pull: (params: { serverId: string; cwd: string }) => Promise<void>;
  push: (params: { serverId: string; cwd: string }) => Promise<void>;
  pullAndPush: (params: { serverId: string; cwd: string }) => Promise<void>;
  refresh: (params: { serverId: string; cwd: string }) => Promise<void>;
  createPr: (params: { serverId: string; cwd: string }) => Promise<void>;
  mergePr: (params: {
    serverId: string;
    cwd: string;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  enablePrAutoMerge: (params: {
    serverId: string;
    cwd: string;
    method: CheckoutPrMergeMethod;
  }) => Promise<void>;
  disablePrAutoMerge: (params: { serverId: string; cwd: string }) => Promise<void>;
  mergeBranch: (params: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
  mergeFromBase: (params: { serverId: string; cwd: string; baseRef: string }) => Promise<void>;
  discardChanges: (params: { serverId: string; cwd: string; paths: string[] }) => Promise<void>;
  newChange: (params: {
    serverId: string;
    cwd: string;
    expectedChangeId?: string;
    acknowledgeRewrites?: boolean;
  }) => Promise<void>;
}

async function runCheckoutAction({
  serverId,
  cwd,
  actionId,
  run,
}: {
  serverId: string;
  cwd: string;
  actionId: CheckoutGitAsyncActionId;
  run: () => Promise<void>;
}): Promise<void> {
  const key = checkoutKey(serverId, cwd);
  const inflightId = inFlightKey(key, actionId);

  const existing = inFlight.get(inflightId);
  if (existing) {
    await existing;
    return;
  }

  const prevTimer = successTimers.get(inflightId);
  if (prevTimer) {
    clearTimeout(prevTimer);
    successTimers.delete(inflightId);
  }

  useCheckoutGitActionsStore.setState((state) => ({
    errorByCheckout: { ...state.errorByCheckout, [key]: null },
  }));
  setStatus(key, actionId, "pending");

  const promise = (async () => {
    try {
      await run();
      await invalidateCheckoutGitQueries(serverId, cwd);
      setStatus(key, actionId, "success");
      const timer = setTimeout(() => {
        setStatus(key, actionId, "idle");
        successTimers.delete(inflightId);
      }, SUCCESS_DISPLAY_MS);
      successTimers.set(inflightId, timer);
    } catch (error) {
      useCheckoutGitActionsStore.setState((state) => ({
        errorByCheckout: {
          ...state.errorByCheckout,
          [key]: error instanceof Error ? error.message : String(error),
        },
      }));
      setStatus(key, actionId, "idle");
      throw error;
    } finally {
      inFlight.delete(inflightId);
    }
  })();

  inFlight.set(inflightId, promise);
  await promise;
}

export const useCheckoutGitActionsStore = create<CheckoutGitActionsStoreState>()((set, get) => ({
  statusByCheckout: {},
  errorByCheckout: {},

  getStatus: ({ serverId, cwd, actionId }) => {
    const key = checkoutKey(serverId, cwd);
    return get().statusByCheckout[key]?.[actionId] ?? "idle";
  },

  commit: async ({ serverId, cwd, expectedChangeId, acknowledgeRewrites }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "commit",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutCommit(cwd, {
          addAll: true,
          expectedChangeId,
          acknowledgeRewrites,
        });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  pull: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "pull",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPull(cwd);
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  push: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "push",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPush(cwd);
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  refresh: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "refresh",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutRefresh(cwd);
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  pullAndPush: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "pull-and-push",
      run: async () => {
        const client = resolveClient(serverId);
        const pullPayload = await client.checkoutPull(cwd);
        if (pullPayload.error) {
          throw new CheckoutOperationError(pullPayload.error);
        }
        const pushPayload = await client.checkoutPush(cwd);
        if (pushPayload.error) {
          throw new CheckoutOperationError(pushPayload.error);
        }
      },
    });
  },

  createPr: async ({ serverId, cwd }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "create-pr",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPrCreate(cwd, {});
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  mergePr: async ({ serverId, cwd, method }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: `merge-pr-${method}`,
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutPrMerge(cwd, { method });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  enablePrAutoMerge: async ({ serverId, cwd, method }) => {
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: `enable-pr-auto-merge-${method}`,
      run: async () => {
        const client = resolveClient(serverId);
        // COMPAT(githubAutoMergeRpc): use the legacy GitHub RPC with daemons
        // that predate checkout.forge.set_auto_merge.*. Remove after 2027-01-17
        // once the supported daemon floor is >= v0.2.0.
        const payload =
          rpc === "forge"
            ? await client.checkoutForgeSetAutoMerge(cwd, { enabled: true, method })
            : await client.checkoutGithubSetAutoMerge(cwd, { enabled: true, method });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  disablePrAutoMerge: async ({ serverId, cwd }) => {
    const rpc = resolveAutoMergeActionsRpc(serverId);
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "disable-pr-auto-merge",
      run: async () => {
        const client = resolveClient(serverId);
        // COMPAT(githubAutoMergeRpc): use the legacy GitHub RPC with daemons
        // that predate checkout.forge.set_auto_merge.*. Remove after 2027-01-17
        // once the supported daemon floor is >= v0.2.0.
        const payload =
          rpc === "forge"
            ? await client.checkoutForgeSetAutoMerge(cwd, { enabled: false })
            : await client.checkoutGithubSetAutoMerge(cwd, { enabled: false });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  mergeBranch: async ({ serverId, cwd, baseRef }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "merge-branch",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutMerge(cwd, {
          baseRef,
          strategy: "merge",
          requireCleanTarget: true,
        });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  mergeFromBase: async ({ serverId, cwd, baseRef }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "merge-from-base",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutMergeFromBase(cwd, {
          baseRef,
          requireCleanTarget: true,
        });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },

  discardChanges: async ({ serverId, cwd, paths }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "discard-changes",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.checkoutDiscardChanges(cwd, { paths });
        if (!payload.success) {
          throw new Error(
            payload.error?.message ?? i18n.t("workspace.fileActions.confirmRevert.failed"),
          );
        }
      },
    });
  },
  newChange: async ({ serverId, cwd, expectedChangeId, acknowledgeRewrites }) => {
    await runCheckoutAction({
      serverId,
      cwd,
      actionId: "new-change",
      run: async () => {
        const client = resolveClient(serverId);
        const payload = await client.newChange({ cwd, expectedChangeId, acknowledgeRewrites });
        if (payload.error) {
          throw new CheckoutOperationError(payload.error);
        }
      },
    });
  },
}));

export function __resetCheckoutGitActionsStoreForTests() {
  for (const timer of successTimers.values()) {
    clearTimeout(timer);
  }
  successTimers.clear();
  inFlight.clear();
  useCheckoutGitActionsStore.setState({ statusByCheckout: {}, errorByCheckout: {} });
}

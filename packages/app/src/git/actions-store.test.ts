import { openJjChangeForm, type JjChangeFormPorts } from "./jj-change-form-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { queryClient as appQueryClient } from "@/data/query-client";
import { useSessionStore } from "@/stores/session-store";
import {
  __resetCheckoutGitActionsStoreForTests,
  useCheckoutGitActionsStore,
} from "@/git/actions-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("checkout-git-actions-store", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo/worktrees/feature";

  beforeEach(() => {
    vi.useFakeTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetCheckoutGitActionsStoreForTests();
    appQueryClient.clear();
    useSessionStore.setState((state) => ({ ...state, sessions: {} }));
  });

  it("shares pending state per checkout and de-dupes in-flight calls", async () => {
    const deferred = createDeferred<unknown>();
    const client = {
      checkoutCommit: vi.fn(() => deferred.promise),
    };

    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    const store = useCheckoutGitActionsStore.getState();

    const first = store.commit({ serverId, cwd });
    const second = store.commit({ serverId, cwd });

    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("pending");

    deferred.resolve({});
    await Promise.all([first, second]);

    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("success");

    vi.advanceTimersByTime(1000);
    expect(store.getStatus({ serverId, cwd, actionId: "commit" })).toBe("idle");
  });

  it("runs pull then push sequentially for pull-and-push", async () => {
    const order: string[] = [];
    const client = {
      checkoutPull: vi.fn(async () => {
        order.push("pull");
        return {};
      }),
      checkoutPush: vi.fn(async () => {
        order.push("push");
        return {};
      }),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd });

    expect(order).toEqual(["pull", "push"]);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("success");
  });

  it("does not push when pull fails for pull-and-push", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({ error: { message: "pull conflict" } })),
      checkoutPush: vi.fn(async () => ({})),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("pull conflict");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("surfaces push errors from pull-and-push after a successful pull", async () => {
    const client = {
      checkoutPull: vi.fn(async () => ({})),
      checkoutPush: vi.fn(async () => ({ error: { message: "push rejected" } })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(
      useCheckoutGitActionsStore.getState().pullAndPush({ serverId, cwd }),
    ).rejects.toThrow("push rejected");
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "pull-and-push" }),
    ).toBe("idle");
  });

  it("refreshes git and GitHub state and reports success", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ success: true, error: null })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore.getState().refresh({ serverId, cwd });

    expect(client.checkoutRefresh).toHaveBeenCalledWith(cwd);
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("success");
  });

  it("surfaces a refresh error and returns to idle", async () => {
    const client = {
      checkoutRefresh: vi.fn(async () => ({ error: { message: "not a git repository" } })),
    };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await expect(useCheckoutGitActionsStore.getState().refresh({ serverId, cwd })).rejects.toThrow(
      "not a git repository",
    );
    expect(
      useCheckoutGitActionsStore.getState().getStatus({ serverId, cwd, actionId: "refresh" }),
    ).toBe("idle");
  });

  it("discards selected paths through the shared checkout action workflow", async () => {
    const checkoutDiscardChanges = vi.fn(async () => ({ success: true, error: null }));
    const client = { checkoutDiscardChanges };
    useSessionStore.setState((state) => ({
      ...state,
      sessions: {
        ...state.sessions,
        [serverId]: { client } as unknown as (typeof state.sessions)[string],
      },
    }));

    await useCheckoutGitActionsStore
      .getState()
      .discardChanges({ serverId, cwd, paths: ["renamed.ts", "original.ts"] });

    expect(checkoutDiscardChanges).toHaveBeenCalledWith(cwd, {
      paths: ["renamed.ts", "original.ts"],
    });
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "discard-changes" }),
    ).toBe("success");
  });

  for (const rpc of [
    {
      label: "forge",
      method: "checkoutForgeSetAutoMerge",
      feature: "checkoutForgeSetAutoMerge",
    },
    {
      label: "legacy GitHub",
      method: "checkoutGithubSetAutoMerge",
      feature: "checkoutGithubSetAutoMerge",
    },
  ] as const) {
    it(`enables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore
        .getState()
        .enablePrAutoMerge({ serverId, cwd, method: "squash" });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, {
        enabled: true,
        method: "squash",
      });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-squash" }),
      ).toBe("success");
    });

    it(`disables PR auto-merge through the ${rpc.label} RPC`, async () => {
      const setAutoMerge = vi.fn(async () => ({
        enabled: false,
        success: true,
        error: null,
      }));
      const client = { [rpc.method]: setAutoMerge };
      useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
      useSessionStore.getState().updateSessionServerInfo(serverId, {
        serverId,
        hostname: null,
        version: null,
        features: { [rpc.feature]: true },
      });

      await useCheckoutGitActionsStore.getState().disablePrAutoMerge({ serverId, cwd });

      expect(setAutoMerge).toHaveBeenCalledWith(cwd, { enabled: false });
      expect(
        useCheckoutGitActionsStore
          .getState()
          .getStatus({ serverId, cwd, actionId: "disable-pr-auto-merge" }),
      ).toBe("success");
    });
  }

  it("does not call PR auto-merge RPCs when the daemon lacks the feature flag", async () => {
    const client = {
      checkoutForgeSetAutoMerge: vi.fn(async () => ({
        enabled: true,
        success: true,
        error: null,
      })),
    };
    useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: null,
      features: {},
    });

    await expect(
      useCheckoutGitActionsStore.getState().enablePrAutoMerge({ serverId, cwd, method: "merge" }),
    ).rejects.toThrow("Update the host to use auto-merge actions.");

    expect(client.checkoutForgeSetAutoMerge).not.toHaveBeenCalled();
    expect(
      useCheckoutGitActionsStore
        .getState()
        .getStatus({ serverId, cwd, actionId: "enable-pr-auto-merge-merge" }),
    ).toBe("idle");
  });
});

describe("native change form", () => {
  it("keeps draft and captured cwd/change on refusal, blocks duplicates and refreshes success", async () => {
    const input = {
      serverId: "host",
      cwd: "/native/sub",
      changeId: "captured",
      description: "Full\n\ndescription",
      mode: "describe" as const,
    };
    const pending = createDeferred<void>();
    const calls: Parameters<JjChangeFormPorts["describe"]>[0][] = [];
    let refreshed = 0;
    const model = openJjChangeForm(input, {
      describe: async (request) => {
        calls.push(request);
        await pending.promise;
      },
      edit: async () => {
        throw new Error("Unexpected Edit");
      },
      newOn: async () => {
        throw new Error("Unexpected New change");
      },
      refresh: async () => {
        refreshed++;
      },
    });
    model.setDraft("My draft");
    const submitting = model.submit();
    await model.submit();
    expect(model.getState().status).toBe("pending");
    expect(calls).toEqual([
      {
        cwd: "/native/sub",
        message: "My draft",
        expectedChangeId: "captured",
        acknowledgeRewrites: false,
      },
    ]);
    pending.reject(new Error("Current change moved; reopen"));
    await submitting;
    expect(model.getState()).toEqual({
      ...input,
      draft: "My draft",
      targetChangeId: null,
      status: "error",
      error: "Current change moved; reopen",
      canSubmit: true,
      needsRewriteApproval: false,
    });
    expect(refreshed).toBe(1);
    model.close();
  });

  it("requires an explicit stable history selection and reports success", async () => {
    const calls: Parameters<JjChangeFormPorts["edit"]>[0][] = [];
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "edit" },
      {
        describe: async () => {
          throw new Error("Unexpected Describe");
        },
        edit: async (request) => {
          calls.push(request);
        },
        newOn: async () => {
          throw new Error("Unexpected New change");
        },
        refresh: async () => {},
      },
    );
    expect(model.getState().canSubmit).toBe(false);
    model.selectChange("stable selected change");
    await model.submit();
    expect(calls).toEqual([
      {
        cwd: "/native",
        changeId: "stable selected change",
        expectedChangeId: "current",
        acknowledgeRewrites: false,
      },
    ]);
    expect(model.getState().status).toBe("success");
    expect(model.getState().canSubmit).toBe(false);
    model.close();
  });

  it("requires visible known-scope approval and binds it to the captured selection", async () => {
    const calls: Parameters<JjChangeFormPorts["edit"]>[0][] = [];
    const warning =
      "Native rewrite approval required: selected; 1 descendant; shared workspaces: true; published history: true.";
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "edit" },
      {
        describe: async () => {
          throw new Error("Unexpected Describe");
        },
        newOn: async () => {
          throw new Error("Unexpected New-on");
        },
        edit: async (input) => {
          calls.push(input);
          if (!input.acknowledgeRewrites) throw new Error(warning);
        },
        refresh: async () => {},
      },
    );
    model.selectChange("selected");
    await model.submit();
    expect(model.getState().error).toBe(warning);
    expect(model.getState().needsRewriteApproval).toBe(true);
    model.selectChange("another selection");
    expect(model.getState().needsRewriteApproval).toBe(false);
    await model.submit();
    await model.submit();
    expect(calls.map((call) => [call.changeId, call.acknowledgeRewrites])).toEqual([
      ["selected", false],
      ["another selection", false],
      ["another selection", true],
    ]);
    expect(model.getState().status).toBe("success");
    model.close();
  });

  it("new-on submits the captured history commit with the working-copy pin", async () => {
    const calls: Parameters<JjChangeFormPorts["newOn"]>[0][] = [];
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "new-on" },
      {
        describe: async () => {
          throw new Error("Unexpected Describe");
        },
        edit: async () => {
          throw new Error("Unexpected Edit");
        },
        newOn: async (request) => {
          calls.push(request);
        },
        refresh: async () => {},
      },
    );
    expect(model.getState().canSubmit).toBe(false);
    model.selectChange("captured commit sha");
    expect(model.getState().canSubmit).toBe(true);
    await model.submit();
    expect(calls).toEqual([
      {
        cwd: "/native",
        targetCommitId: "captured commit sha",
        expectedChangeId: "current",
        acknowledgeRewrites: false,
      },
    ]);
    expect(model.getState().status).toBe("success");
    model.close();
  });
});

import { openJjPrMutationForm, type JjPrMutationSnapshot } from "./jj-pr-mutation-form-model";
import { openJjPrCreateForm } from "./jj-pr-create-form-model";
import { openJjChangeForm, type JjChangeFormPorts } from "./jj-change-form-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutOperationError, type DaemonClient } from "@getpaseo/client/internal/daemon-client";
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
  it.each([
    "Current change moved; reopen",
    "Native rewrite approval required: remote rejected this literal description",
  ])("retains an ordinary refusal without offering rewrite approval: %s", async (message) => {
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
      newChange: async () => {
        throw new Error("Unexpected New change");
      },
      newOn: async () => {
        throw new Error("Unexpected New change");
      },
      fetchAndRebase: async () => "unchanged",
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
    pending.reject(new CheckoutOperationError({ code: "UNKNOWN", message }));
    await submitting;
    expect(model.getState()).toEqual({
      ...input,
      draft: "My draft",
      targetChangeId: null,
      targetChangeLabel: null,
      targetCommitId: null,
      status: "error",
      error: message,
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
        newChange: async () => {
          throw new Error("Unexpected New change");
        },
        newOn: async () => {
          throw new Error("Unexpected New change");
        },
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    expect(model.getState().canSubmit).toBe(false);
    model.selectChange({ changeId: "stable selected change", label: "Stable selected label" });
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

  it("keeps the selected change identity and label visible when an action fails", async () => {
    const calls: Parameters<JjChangeFormPorts["edit"]>[0][] = [];
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "edit" },
      {
        describe: async () => {},
        edit: async (input) => {
          calls.push(input);
          throw new Error("Change is no longer editable");
        },
        newChange: async () => {
          throw new Error("Unexpected New change");
        },
        newOn: async () => {},
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    model.selectChange({ changeId: "selected-change-id", label: "Captured human label" });
    await model.submit();
    expect(calls).toEqual([
      {
        cwd: "/native",
        changeId: "selected-change-id",
        expectedChangeId: "current",
        acknowledgeRewrites: false,
      },
    ]);
    expect(model.getState()).toMatchObject({
      targetChangeId: "selected-change-id",
      targetChangeLabel: "Captured human label",
      status: "error",
      error: "Change is no longer editable",
    });
    model.close();
  });

  it("requires visible known-scope approval and binds it to the captured selection", async () => {
    const calls: Parameters<JjChangeFormPorts["edit"]>[0][] = [];
    const warning =
      "Review selected; 1 descendant; shared workspaces: true; published history: true.";
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
          if (!input.acknowledgeRewrites)
            throw new CheckoutOperationError({
              code: "NOT_ALLOWED",
              reason: "rewrite_approval_required",
              message: warning,
            });
        },
        newChange: async () => {
          throw new Error("Unexpected New change");
        },
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    model.selectChange({ changeId: "selected", label: "Selected" });
    await model.submit();
    expect(model.getState().error).toBe(warning);
    expect(model.getState().needsRewriteApproval).toBe(true);
    model.selectChange({ changeId: "another selection", label: "Another selection" });
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
        newChange: async () => {
          throw new Error("Unexpected New change");
        },
        newOn: async (request) => {
          calls.push(request);
        },
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    expect(model.getState().canSubmit).toBe(false);
    model.selectChange({
      changeId: "native change id",
      label: "Captured commit",
      commitId: "captured commit sha",
    });
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

  it("starts a described new change once and keeps the draft through success", async () => {
    const calls: Parameters<JjChangeFormPorts["newChange"]>[0][] = [];
    const pending = createDeferred<void>();
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "new" },
      {
        describe: async () => {},
        edit: async () => {},
        newChange: async (input) => {
          calls.push(input);
          await pending.promise;
        },
        newOn: async () => {},
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    expect(model.getState().canSubmit).toBe(false);
    model.setDraft(" \n\t ");
    expect(model.getState().canSubmit).toBe(false);
    model.setDraft("  A new change description  \nsecond line");
    const submitting = model.submit();
    await model.submit();
    expect(model.getState().status).toBe("pending");
    expect(calls).toEqual([
      {
        cwd: "/native",
        message: "  A new change description  \nsecond line",
        expectedChangeId: "current",
        acknowledgeRewrites: false,
      },
    ]);
    pending.resolve();
    await submitting;
    expect(model.getState()).toMatchObject({
      draft: "  A new change description  \nsecond line",
      status: "success",
      canSubmit: false,
    });
    model.close();
  });

  it("keeps a described new-change draft after a failure for retry", async () => {
    const calls: Parameters<JjChangeFormPorts["newChange"]>[0][] = [];
    let shouldFail = true;
    const model = openJjChangeForm(
      { serverId: "host", cwd: "/native", changeId: "current", description: "", mode: "new" },
      {
        describe: async () => {},
        edit: async () => {},
        newChange: async (input) => {
          calls.push(input);
          if (shouldFail) throw new Error("Host disconnected");
        },
        newOn: async () => {},
        fetchAndRebase: async () => "unchanged",
        refresh: async () => {},
      },
    );
    model.setDraft("Keep this description for retry");
    await model.submit();
    expect(model.getState()).toMatchObject({
      draft: "Keep this description for retry",
      status: "error",
      error: "Host disconnected",
      canSubmit: true,
    });
    shouldFail = false;
    await model.submit();
    expect(calls.map((call) => call.message)).toEqual([
      "Keep this description for retry",
      "Keep this description for retry",
    ]);
    expect(model.getState()).toMatchObject({
      draft: "Keep this description for retry",
      status: "success",
      canSubmit: false,
    });
    model.close();
  });
});

describe("native pull request form", () => {
  it("keeps title, body, base and change on failure, blocks duplicates and exposes the created PR", async () => {
    const snapshot = {
      serverId: "host",
      cwd: "/native",
      changeId: "captured",
      bookmark: "feature",
    };
    const pending = createDeferred<{ url: string; number: number }>();
    const requests: unknown[] = [];
    let attempts = 0;
    const model = openJjPrCreateForm(snapshot, {
      create: async (input) => {
        requests.push(input);
        attempts++;
        if (attempts === 1) return pending.promise;
        return { url: "https://github.com/acme/native/pull/12", number: 12 };
      },
      refresh: async () => {},
    });
    model.setTitle("Kept title");
    model.setBody("Kept body");
    model.setBaseRef("main");
    const submitting = model.submit();
    await model.submit();
    expect(model.getState().status).toBe("pending");
    expect(requests).toEqual([
      {
        cwd: "/native",
        title: "Kept title",
        body: "Kept body",
        baseRef: "main",
        expectedChangeId: "captured",
      },
    ]);
    pending.reject(new Error("Describe the unpublished change before pushing."));
    await submitting;
    expect(model.getState()).toMatchObject({
      ...snapshot,
      title: "Kept title",
      body: "Kept body",
      baseRef: "main",
      status: "error",
      error: "Describe the unpublished change before pushing.",
      result: null,
    });
    await model.submit();
    expect(model.getState()).toMatchObject({
      title: "Kept title",
      body: "Kept body",
      baseRef: "main",
      status: "success",
      error: null,
      result: { url: "https://github.com/acme/native/pull/12", number: 12 },
    });
    await model.submit();
    expect(requests).toHaveLength(2);
    model.close();
  });
});

describe("jj fetch-and-rebase form", () => {
  it("keeps a failed captured request available for retry and prevents duplicate submissions", async () => {
    const pending = createDeferred<"rebased" | "unchanged" | "conflicts">();
    const calls: Array<{ cwd: string; expectedChangeId: string; acknowledgeRewrites: boolean }> =
      [];
    const model = openJjChangeForm(
      {
        serverId: "host",
        cwd: "/native",
        changeId: "captured",
        description: "Selected native work",
        mode: "fetch-rebase",
      },
      {
        describe: async () => {},
        edit: async () => {},
        newChange: async () => {},
        newOn: async () => {},
        fetchAndRebase: async (input) => {
          calls.push(input);
          if (calls.length === 1) return pending.promise;
          return "rebased";
        },
        refresh: async () => {},
      },
    );
    const submitting = model.submit();
    await model.submit();
    expect(model.getState().status).toBe("pending");
    expect(model.getState().canSubmit).toBe(false);
    expect(calls).toEqual([
      { cwd: "/native", expectedChangeId: "captured", acknowledgeRewrites: false },
    ]);
    pending.reject(new Error("upstream is unavailable; repair its URL and retry"));
    await submitting;
    expect(model.getState()).toMatchObject({
      status: "error",
      error: "upstream is unavailable; repair its URL and retry",
      canSubmit: true,
      changeId: "captured",
      needsRewriteApproval: false,
    });
    await model.submit();
    expect(model.getState()).toMatchObject({
      status: "success",
      outcome: "rebased",
      canSubmit: false,
      changeId: "captured",
    });
    model.close();
  });
});

describe("jj fetch-and-rebase approval", () => {
  it.each(["rebased", "unchanged", "conflicts"] as const)(
    "requires an explicit approval choice before reporting %s",
    async (outcome) => {
      const calls: boolean[] = [];
      const ports: JjChangeFormPorts = {
        describe: async () => {},
        edit: async () => {},
        newChange: async () => {},
        newOn: async () => {},
        refresh: async () => {},
        fetchAndRebase: async (input) => {
          calls.push(input.acknowledgeRewrites);
          if (!input.acknowledgeRewrites)
            throw new CheckoutOperationError({
              code: "NOT_ALLOWED",
              reason: "rewrite_approval_required",
              message: "Review all mutable branches.",
            });
          return outcome;
        },
      };
      const snapshot = {
        serverId: "host",
        cwd: "/native",
        changeId: "captured",
        description: "Captured work",
        mode: "fetch-rebase" as const,
      };
      const cancelled = openJjChangeForm(snapshot, ports);
      await cancelled.submit();
      expect(cancelled.getState()).toMatchObject({
        status: "error",
        needsRewriteApproval: true,
        error: "Review all mutable branches.",
        canSubmit: true,
      });
      cancelled.close();
      expect(calls).toEqual([false]);
      const approved = openJjChangeForm(snapshot, ports);
      await approved.submit();
      await approved.submit();
      expect(calls).toEqual([false, false, true]);
      expect(approved.getState()).toMatchObject({
        status: "success",
        outcome,
        changeId: "captured",
        description: "Captured work",
      });
      approved.close();
    },
  );
});

describe("native selected PR mutation form", () => {
  it.each([
    { kind: "merge", method: "squash" },
    { kind: "enable-auto-merge", method: "merge" },
    { kind: "disable-auto-merge" },
  ] as const)(
    "retains $kind identity through pending, failure and successful retry",
    async (intent) => {
      const first = createDeferred<void>();
      const submitted: JjPrMutationSnapshot[] = [];
      const snapshot: JjPrMutationSnapshot = {
        serverId: "host",
        cwd: "/native",
        identity: { host: "forge.example", targetRepository: "upstream/project", number: 42 },
        intent,
      };
      const form = openJjPrMutationForm(snapshot, {
        mutate: async (input) => {
          submitted.push(input);
          if (submitted.length === 1) await first.promise;
        },
        refresh: async () => {},
      });
      const pending = form.submit();
      await form.submit();
      expect(form.getState()).toMatchObject({
        status: "pending",
        identity: snapshot.identity,
        intent,
      });
      expect(submitted).toEqual([snapshot]);
      first.reject(new Error("Provider refused this operation. Refresh eligibility and retry."));
      await pending;
      expect(form.getState()).toMatchObject({
        status: "error",
        error: "Provider refused this operation. Refresh eligibility and retry.",
        identity: snapshot.identity,
        intent,
      });
      await form.submit();
      expect(form.getState()).toMatchObject({
        status: "success",
        error: null,
        identity: snapshot.identity,
        intent,
      });
      await form.submit();
      expect(submitted).toEqual([snapshot, snapshot]);
      form.close();
    },
  );
});

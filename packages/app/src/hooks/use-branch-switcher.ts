import { useState, useCallback, useMemo, useRef } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { ToastApi } from "@/components/toast-host";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { createBranchSwitcherOperations } from "@/git/branch-switcher-operations";
import { confirmDialog } from "@/utils/confirm-dialog";

interface UseBranchSwitcherInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
  currentBranchName: string | null;
  isGitCheckout: boolean;
  /** Backend of the checkout; jj auto-snapshots so stash affordances are skipped. */
  vcs?: "git" | "jj" | null;
  /** jj: change ID of the current working-copy change, captured as a switch intent precondition (not a cross-process lock). */
  currentChangeId?: string | null;
  isConnected: boolean;
  toast: ToastApi;
  queryClient: QueryClient;
}

interface UseBranchSwitcherResult {
  branchOptions: ComboboxOption[];
  branchLoadMessage: string | null;
  isOpen: boolean;
  isSwitching: boolean;
  setIsOpen: (open: boolean) => void;
  handleBranchSelect: (branchId: string) => void;
  invalidateStashAndCheckout: () => Promise<void>;
}

export function useBranchSwitcher({
  client,
  normalizedServerId,
  normalizedWorkspaceId,
  workspaceDirectory,
  currentBranchName,
  isGitCheckout,
  vcs = null,
  currentChangeId,
  isConnected,
  toast,
  queryClient,
}: UseBranchSwitcherInput): UseBranchSwitcherResult {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const switchPending = useRef(false);

  // Git operations are bound to the workspace directory; the opaque workspace id is
  // used only for query cache identity below, never as a cwd.
  const operations = useMemo(
    () =>
      client && workspaceDirectory
        ? createBranchSwitcherOperations(client, workspaceDirectory)
        : null,
    [client, workspaceDirectory],
  );

  const branchSuggestionsQuery = useQuery({
    queryKey: ["branchSuggestions", normalizedServerId, normalizedWorkspaceId],
    queryFn: async () => {
      if (!operations) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await operations.getBranchSuggestions(200);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { branches: payload.branches ?? [], branchDetails: payload.branchDetails ?? [] };
    },
    enabled: isOpen && isGitCheckout && Boolean(operations) && isConnected,
    retry: false,
    staleTime: vcs === "jj" ? 0 : 15_000,
  });

  const queryLoadMessage = branchSuggestionsQuery.isFetching
    ? t("common.loading")
    : (branchSuggestionsQuery.error?.message ?? null);
  const branchLoadMessage = vcs === "jj" ? queryLoadMessage : null;
  const branchOptions = useMemo<ComboboxOption[]>(() => {
    if (branchLoadMessage) return [];
    const branches = branchSuggestionsQuery.data?.branches ?? [];
    return branches.map((name: string) => ({ id: name, label: name }));
  }, [branchSuggestionsQuery.data, branchLoadMessage]);

  // jj switch intent inputs, captured from the suggestion list loaded when the
  // picker opened: the bookmark's exact local revision (new-on target) and the
  // saved WIP change on its line (same-ID Resume offer). The daemon re-verifies
  // both against the live repo at execution time.
  const jjSuggestionDetails = useMemo(() => {
    const details = branchSuggestionsQuery.data?.branchDetails ?? [];
    return new Map(details.map((detail) => [detail.name, detail]));
  }, [branchSuggestionsQuery.data]);

  const stashListQueryKey = useMemo(
    () => ["stashList", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId],
  );

  const invalidateStashAndCheckout = useCallback(async () => {
    if (!workspaceDirectory) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["branchSuggestions", normalizedServerId, normalizedWorkspaceId],
      }),
      queryClient.invalidateQueries({ queryKey: stashListQueryKey }),
      invalidateCheckoutGitQueriesForClient(queryClient, {
        serverId: normalizedServerId,
        cwd: workspaceDirectory,
      }),
    ]);
  }, [
    queryClient,
    stashListQueryKey,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
  ]);

  const maybeRestoreStashForBranch = useCallback(
    async (branchId: string) => {
      // jj has no stash: the working copy is snapshotted on every switch.
      if (vcs === "jj") return;
      if (!operations) return;
      try {
        const stashPayload = await operations.listPaseoStashes();
        const targetStash = stashPayload.entries.find((e) => e.branch === branchId);
        if (!targetStash) return;
        const shouldRestore = await confirmDialog({
          title: t("branchSwitcher.restoreStashTitle"),
          message: t("branchSwitcher.restoreStashMessage"),
          confirmLabel: t("branchSwitcher.restore"),
          cancelLabel: t("branchSwitcher.later"),
        });
        if (!shouldRestore) return;
        const popPayload = await operations.popStash(targetStash.index);
        if (popPayload.error) {
          toast.error(popPayload.error.message);
        } else {
          toast.show(t("branchSwitcher.stashRestored"));
        }
        await invalidateStashAndCheckout();
      } catch {
        // Non-critical — user can still restore on next branch switch
      }
    },
    [operations, vcs, invalidateStashAndCheckout, toast, t],
  );

  const stashAndSwitch = useCallback(
    async (branchId: string) => {
      if (!operations) return;
      const shouldStash = await confirmDialog({
        title: t("branchSwitcher.uncommittedTitle"),
        message: t("branchSwitcher.uncommittedMessage"),
        confirmLabel: t("branchSwitcher.stashAndSwitch"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!shouldStash) return;

      try {
        const stashPayload = await operations.saveStash(currentBranchName ?? undefined);
        if (stashPayload.error) {
          toast.error(stashPayload.error.message);
          return;
        }
        await invalidateStashAndCheckout();
        const switchPayload = await operations.switchBranch(branchId);
        if (switchPayload.error) {
          toast.error(switchPayload.error.message);
          return;
        }
        await invalidateStashAndCheckout();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToStash"));
      }
    },
    [operations, currentBranchName, invalidateStashAndCheckout, toast, t],
  );

  const switchBranchWithJjIntent = useCallback(
    async (branchId: string) => {
      if (!operations) return;
      const detail = jjSuggestionDetails.get(branchId);
      // Captured revision pins the new change to the bookmark position seen in
      // the picker; if the bookmark moved since, the daemon fails the switch
      // with an actionable error instead of landing on the wrong revision.
      const targetCommitId = detail?.localRef;
      if (!targetCommitId || !currentChangeId) {
        toast.error("Refresh and select a local bookmark with a captured jj revision.");
        return;
      }
      let mode: "new-on" | "resume" = "new-on";
      let wipChangeId: string | undefined;
      if (detail?.wipChangeId) {
        const resume = await confirmDialog({
          title: t("branchSwitcher.jjResumeTitle", { branchName: branchId }),
          message: t("branchSwitcher.jjResumeMessage"),
          confirmLabel: t("branchSwitcher.jjResumeConfirm"),
          cancelLabel: t("branchSwitcher.jjResumeNewChange"),
        });
        if (resume) {
          mode = "resume";
          wipChangeId = detail.wipChangeId;
        }
      }
      if (mode === "new-on") {
        const proceed = await confirmDialog({
          title: t("branchSwitcher.jjSwitchTitle", { branchName: branchId }),
          message: t("branchSwitcher.jjSwitchMessage"),
          confirmLabel: t("branchSwitcher.jjSwitchConfirm"),
          cancelLabel: t("common.actions.cancel"),
        });
        if (!proceed) return;
      }
      try {
        const intent = { mode, wipChangeId, targetCommitId, expectedChangeId: currentChangeId };
        let payload = await operations.switchBranch(branchId, {
          ...intent,
          acknowledgeRewrites: false,
        });
        if (payload.error?.message.startsWith("Native rewrite approval required:")) {
          const approved = await confirmDialog({
            title: t("branchSwitcher.jjSwitchTitle", { branchName: branchId }),
            message: payload.error.message,
            confirmLabel: t("workspace.git.actions.jj.approveRewrite", {
              defaultValue: "Approve native rewrite",
            }),
            cancelLabel: t("common.actions.cancel"),
          });
          if (!approved) return;
          payload = await operations.switchBranch(branchId, {
            ...intent,
            acknowledgeRewrites: true,
          });
        }
        if (payload.error) {
          toast.error(payload.error.message);
          return;
        }
        toast.show(
          payload.mode === "resume"
            ? t("branchSwitcher.jjSwitchedResume", { branchName: branchId })
            : t("branchSwitcher.jjSwitchedNewOn", { branchName: branchId }),
          { variant: "success" },
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToSwitch"));
      } finally {
        await invalidateStashAndCheckout();
      }
    },
    [operations, jjSuggestionDetails, currentChangeId, invalidateStashAndCheckout, t, toast],
  );

  const handleBranchSelect = useCallback(
    (branchId: string) => {
      if (branchId === currentBranchName) return;

      void (async () => {
        if (!operations) return;
        // jj has no stash flow: snapshot + switch happens natively with a
        // captured intent; never offer the git stash dialog.
        if (vcs === "jj") {
          if (switchPending.current) return;
          switchPending.current = true;
          setIsSwitching(true);
          setIsOpen(false);
          try {
            await switchBranchWithJjIntent(branchId);
          } finally {
            switchPending.current = false;
            setIsSwitching(false);
          }
          return;
        }
        try {
          const payload = await operations.switchBranch(branchId);
          if (payload.error) {
            // If the error is about uncommitted changes, offer the stash dialog
            if (payload.error.message.toLowerCase().includes("uncommitted")) {
              await stashAndSwitch(branchId);
              return;
            }
            toast.error(payload.error.message);
            return;
          }
          // Success — refresh and check for stashes on the target branch
          await invalidateStashAndCheckout();
          await maybeRestoreStashForBranch(branchId);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : t("branchSwitcher.failedToSwitch"));
        }
      })();
    },
    [
      operations,
      currentBranchName,
      invalidateStashAndCheckout,
      maybeRestoreStashForBranch,
      stashAndSwitch,
      switchBranchWithJjIntent,
      t,
      toast,
      vcs,
    ],
  );

  return {
    branchOptions,
    branchLoadMessage,
    isOpen,
    isSwitching,
    setIsOpen,
    handleBranchSelect,
    invalidateStashAndCheckout,
  };
}

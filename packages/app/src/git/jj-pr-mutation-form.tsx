import { CheckoutOperationError } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { queryClient } from "@/data/query-client";
import { invalidateCheckoutGitQueriesForClient } from "./query-keys";
import { getForgePresentation, type Forge } from "./forge";
import { openJjPrMutationForm, type JjPrMutationSnapshot } from "./jj-pr-mutation-form-model";

export function JjPrMutationForm({
  snapshot,
  forge,
  onClose,
}: {
  snapshot: JjPrMutationSnapshot;
  forge: Forge;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const client = useHostRuntimeClient(snapshot.serverId);
  const [model] = useState(() =>
    openJjPrMutationForm(snapshot, {
      mutate: async (input) => {
        if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
        const expectedPullRequest = input.identity;
        const result =
          input.intent.kind === "merge"
            ? await client.checkoutPrMerge(input.cwd, {
                method: input.intent.method,
                expectedPullRequest,
              })
            : await client.checkoutForgeSetAutoMerge(
                input.cwd,
                input.intent.kind === "enable-auto-merge"
                  ? { enabled: true, method: input.intent.method, expectedPullRequest }
                  : { enabled: false, expectedPullRequest },
              );
        if (result.error) throw new CheckoutOperationError(result.error);
        if (!result.success) throw new Error(t("workspace.git.actions.toasts.failedMergePr"));
      },
      refresh: () =>
        invalidateCheckoutGitQueriesForClient(queryClient, {
          serverId: snapshot.serverId,
          cwd: snapshot.cwd,
        }),
    }),
  );
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const pending = state.status === "pending";
  const presentation = getForgePresentation(forge);
  const vocabulary = { context: presentation.changeRequestContext };
  const intent = snapshot.intent;
  let title: string;
  let pendingLabel: string;
  let successLabel: string;
  if (intent.kind === "merge") {
    title = t(`workspace.git.actions.mergePr.${intent.method}`, vocabulary);
    pendingLabel = t("workspace.git.actions.mergePr.pending", vocabulary);
    successLabel = t("workspace.git.actions.mergePr.success", vocabulary);
  } else {
    const enable = intent.kind === "enable-auto-merge";
    const method = enable ? intent.method : null;
    title = method
      ? t(
          `workspace.git.actions.autoMerge.${{ merge: "enableMerge", squash: "enableSquash", rebase: "enableRebase" }[method]}`,
        )
      : t("workspace.git.actions.autoMerge.disable");
    pendingLabel = t(
      enable
        ? "workspace.git.actions.autoMerge.enabling"
        : "workspace.git.actions.autoMerge.disabling",
    );
    successLabel = t(
      enable
        ? "workspace.git.actions.autoMerge.enabled"
        : "workspace.git.actions.autoMerge.disabled",
    );
  }
  let submitLabel = title;
  if (pending) submitLabel = pendingLabel;
  else if (state.status === "error") submitLabel = t("common.actions.retry");
  const header = useMemo(() => ({ title }), [title]);
  const submit = useCallback(() => void model.submit(), [model]);
  const close = useCallback(() => {
    if (model.getState().status !== "pending") onClose();
  }, [model, onClose]);
  return (
    <AdaptiveModalSheet visible header={header} onClose={close}>
      <View style={styles.form} testID="jj-pr-mutation-form">
        <Text style={styles.identity} testID="jj-pr-mutation-identity">
          {snapshot.identity
            ? `${snapshot.identity.targetRepository} ${presentation.numberPrefix}${snapshot.identity.number}`
            : snapshot.cwd}
        </Text>
        {state.error ? (
          <Alert variant="error" description={state.error} testID="jj-pr-mutation-error" />
        ) : null}
        {state.status === "success" ? (
          <Alert variant="success" description={successLabel} testID="jj-pr-mutation-success" />
        ) : null}
        <View style={styles.row}>
          <Button variant="outline" size={size} disabled={pending} onPress={close}>
            {t("common.actions.dismiss")}
          </Button>
          <Button
            size={size}
            disabled={pending || state.status === "success"}
            onPress={submit}
            testID="jj-pr-mutation-submit"
          >
            {submitLabel}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[3] },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  identity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));

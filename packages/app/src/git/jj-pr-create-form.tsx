import { CheckoutOperationError } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { openExternalUrl } from "@/utils/open-external-url";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { queryClient } from "@/data/query-client";
import { getForgePresentation, type Forge } from "@/git/forge";
import { openJjPrCreateForm, type JjPrCreateSnapshot } from "./jj-pr-create-form-model";

export function JjPrCreateFormHost({
  snapshot,
  forge,
  onClose,
}: {
  snapshot: JjPrCreateSnapshot | null;
  forge: Forge;
  onClose(): void;
}) {
  if (!snapshot) return null;
  return (
    <JjPrCreateForm
      key={`${snapshot.serverId}:${snapshot.cwd}:${snapshot.changeId}`}
      snapshot={snapshot}
      forge={forge}
      onClose={onClose}
    />
  );
}

function JjPrCreateForm({
  snapshot,
  forge,
  onClose,
}: {
  snapshot: JjPrCreateSnapshot;
  forge: Forge;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const presentation = getForgePresentation(forge);
  const vocabulary = { context: presentation.changeRequestContext };
  const client = useHostRuntimeClient(snapshot.serverId);
  const [model] = useState(() =>
    openJjPrCreateForm(snapshot, {
      create: async (input) => {
        if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
        const result = await client.checkoutPrCreate(input.cwd, input);
        if (result.error) throw new CheckoutOperationError(result.error);
        if (!result.url || result.number === null)
          throw new Error(t("workspace.git.actions.toasts.failedCreatePr"));
        return { url: result.url, number: result.number };
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
  const editable = !pending && state.status !== "success";
  const submit = useCallback(() => void model.submit(), [model]);
  const close = useCallback(() => {
    if (model.getState().status !== "pending") onClose();
  }, [model, onClose]);
  const openResult = useCallback(() => {
    const result = model.getState().result;
    if (result) void openExternalUrl(result.url);
  }, [model]);
  const title = t("workspace.git.actions.createPr.label", vocabulary);
  const submitLabel = pending ? t("workspace.git.actions.createPr.pending", vocabulary) : title;
  const header = useMemo(() => ({ title }), [title]);
  return (
    <AdaptiveModalSheet visible onClose={close} header={header}>
      <View style={styles.form} testID="jj-pr-create-form">
        <Text style={styles.identity}>
          {snapshot.bookmark} · {snapshot.changeId.slice(0, 12)}
        </Text>
        <Field label={t("workspace.git.actions.createPr.form.title")}>
          <FormTextInput
            initialValue={state.title}
            onChangeText={model.setTitle}
            editable={editable}
            size={size}
            placeholder={t("workspace.git.actions.createPr.form.automatic")}
            accessibilityLabel={t("workspace.git.actions.createPr.form.title")}
            testID="jj-pr-title"
          />
        </Field>
        <Field label={t("workspace.git.actions.createPr.form.body")}>
          <FormTextInput
            initialValue={state.body}
            onChangeText={model.setBody}
            editable={editable}
            size={size}
            multiline
            placeholder={t("workspace.git.actions.createPr.form.automatic")}
            accessibilityLabel={t("workspace.git.actions.createPr.form.body")}
            testID="jj-pr-body"
          />
        </Field>
        <Field label={t("workspace.git.actions.createPr.form.base")}>
          <FormTextInput
            initialValue={state.baseRef}
            onChangeText={model.setBaseRef}
            editable={editable}
            size={size}
            accessibilityLabel={t("workspace.git.actions.createPr.form.base")}
            testID="jj-pr-base"
          />
        </Field>
        {state.error ? (
          <Alert variant="error" description={state.error} testID="jj-pr-error" />
        ) : null}
        {state.result ? (
          <View>
            <Alert
              variant="success"
              description={`${t("workspace.git.actions.createPr.success", vocabulary)} ${presentation.numberPrefix}${state.result.number}`}
              testID="jj-pr-success"
            />
            <Button variant="outline" size={size} onPress={openResult}>
              {t("workspace.git.actions.viewPr", vocabulary)}
            </Button>
          </View>
        ) : null}
        <View style={styles.row}>
          <Button variant="outline" size={size} disabled={pending} onPress={close}>
            {t("common.actions.cancel")}
          </Button>
          <Button size={size} disabled={!editable} onPress={submit} testID="jj-pr-submit">
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

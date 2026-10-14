import { CheckoutOperationError } from "@getpaseo/client/internal/daemon-client";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Alert } from "@/components/ui/alert";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useCheckoutCommitsQuery } from "@/git/use-commits-query";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { invalidateCheckoutGitQueriesForClient } from "@/git/query-keys";
import { queryClient } from "@/data/query-client";
import { openJjChangeForm, type JjChangeFormSnapshot } from "./jj-change-form-model";

interface JjChangeControlsProps {
  serverId: string;
  cwd: string;
  changeId: string | null | undefined;
  description: string;
  refusedPaths: string[];
}

export function JjChangeControls(props: JjChangeControlsProps) {
  const { t } = useTranslation();
  const enabled = useSessionStore(
    (state) => state.sessions[props.serverId]?.serverInfo?.features?.checkoutJjCheckpoint === true,
  );
  const graphSelectionsEnabled = useSessionStore(
    (state) =>
      state.sessions[props.serverId]?.serverInfo?.features?.checkoutJjGraphSelections === true,
  );
  const error = useCheckoutGitActionsStore(
    (state) => state.errorByCheckout[`${props.serverId}::${props.cwd}`] ?? null,
  );
  const [opened, setOpened] = useState<JjChangeFormSnapshot | null>(null);
  const open = useCallback(
    (mode: JjChangeFormSnapshot["mode"]) => {
      if (props.changeId)
        setOpened({
          serverId: props.serverId,
          cwd: props.cwd,
          changeId: props.changeId,
          description: props.description,
          mode,
        });
    },
    [props.changeId, props.serverId, props.cwd, props.description],
  );
  const openDescribe = useCallback(() => open("describe"), [open]);
  const openEdit = useCallback(() => open("edit"), [open]);
  const openNewOn = useCallback(() => open("new-on"), [open]);
  const close = useCallback(() => setOpened(null), []);
  if (!enabled) return null;
  return (
    <View style={styles.controls} testID="jj-change-controls">
      <View style={styles.row}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.changeId}
          onPress={openDescribe}
          testID="jj-describe-open"
        >
          {t("workspace.git.actions.describeChange.label")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.changeId}
          onPress={openEdit}
          testID="jj-edit-open"
        >
          {t("workspace.git.actions.editChange.label")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!props.changeId || !graphSelectionsEnabled}
          onPress={openNewOn}
          testID="jj-newon-open"
        >
          {t("workspace.git.actions.newChangeOn.label")}
        </Button>
      </View>
      {props.refusedPaths.length ? (
        <Alert
          variant="warning"
          size="sm"
          title={t("workspace.git.actions.jj.snapshotRefused")}
          description={props.refusedPaths.join(", ")}
          testID="jj-refused-paths"
        />
      ) : null}
      {error ? (
        <Alert variant="error" size="sm" description={error} testID="jj-action-error" />
      ) : null}
      {opened ? (
        <JjChangeForm
          key={`${opened.mode}:${opened.cwd}:${opened.changeId}`}
          snapshot={opened}
          onClose={close}
        />
      ) : null}
    </View>
  );
}

function JjChangeForm({ snapshot, onClose }: { snapshot: JjChangeFormSnapshot; onClose(): void }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(snapshot.serverId);
  const [model] = useState(() =>
    openJjChangeForm(snapshot, {
      describe: async (input) => {
        if (!client) throw new Error("Host disconnected");
        const result = await client.describeChange(input);
        if (result.error) throw new CheckoutOperationError(result.error);
        if (!result.success) throw new Error("Describe did not complete");
      },
      edit: async (input) => {
        if (!client) throw new Error("Host disconnected");
        const result = await client.editChange(input);
        if (result.error) throw new CheckoutOperationError(result.error);
        if (!result.success) throw new Error("Edit did not complete");
      },
      newOn: async (input) => {
        if (!client) throw new Error("Host disconnected");
        const result = await client.newChange(input);
        if (result.error) throw new CheckoutOperationError(result.error);
        if (!result.success) throw new Error("New change did not complete");
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
  const commits = useCheckoutCommitsQuery({
    serverId: snapshot.serverId,
    cwd: snapshot.cwd,
    enabled: snapshot.mode !== "describe",
  });
  const size = compact ? "md" : "sm";
  const title = t(
    {
      describe: "workspace.git.actions.describeChange.label",
      "new-on": "workspace.git.actions.newChangeOn.label",
      edit: "workspace.git.actions.editChange.label",
    }[snapshot.mode],
  );
  const header = useMemo(() => ({ title }), [title]);
  const submit = useCallback(() => void model.submit(), [model]);
  const selectChange = useCallback(
    (selection: { changeId: string; label: string; commitId?: string }) =>
      model.selectChange(selection),
    [model],
  );
  const close = useCallback(() => {
    if (model.getState().status !== "pending") onClose();
  }, [model, onClose]);
  const pending = state.status === "pending";
  let submitLabel = title;
  if (pending) submitLabel = t("workspace.git.actions.jj.saving");
  else if (state.needsRewriteApproval)
    submitLabel = t("workspace.git.actions.jj.approveRewrite", {
      defaultValue: "Approve native rewrite",
    });
  return (
    <AdaptiveModalSheet visible onClose={close} header={header}>
      <View style={styles.form} testID="jj-change-form">
        <Text style={styles.identity}>{snapshot.changeId}</Text>
        <Alert
          variant="warning"
          size={size}
          description={t("workspace.git.actions.jj.rewriteWarning")}
          testID="jj-rewrite-warning"
        />
        {snapshot.mode === "describe" ? (
          <Field label={t("workspace.git.actions.jj.description")}>
            <FormTextInput
              initialValue={snapshot.description}
              onChangeText={model.setDraft}
              multiline
              size={size}
              editable={!pending}
              accessibilityLabel={t("workspace.git.actions.jj.description")}
              testID="jj-description-input"
            />
          </Field>
        ) : (
          <View>
            {state.targetChangeId && state.targetChangeLabel ? (
              <View testID="jj-selected-change">
                <Text style={styles.identity}>
                  {state.targetChangeId.slice(0, 12)} {state.targetChangeLabel}
                </Text>
                {state.targetCommitId ? (
                  <Text style={styles.identity}>{state.targetCommitId.slice(0, 12)}</Text>
                ) : null}
              </View>
            ) : null}
            {commits.status === "loaded" ? (
              commits.data.commits
                .filter((commit) =>
                  snapshot.mode === "new-on"
                    ? Boolean(commit.changeId)
                    : Boolean(commit.changeId) && commit.changeId !== snapshot.changeId,
                )
                .map((commit) => (
                  <ChangeSelection
                    key={commit.sha}
                    changeId={commit.changeId!}
                    commitId={snapshot.mode === "new-on" ? commit.sha : null}
                    label={commit.subject || commit.shortSha}
                    testID={
                      snapshot.mode === "new-on"
                        ? `jj-newon-select-${commit.sha}`
                        : `jj-edit-select-${commit.changeId}`
                    }
                    selected={
                      snapshot.mode === "new-on"
                        ? state.targetCommitId === commit.sha
                        : state.targetChangeId === commit.changeId
                    }
                    size={size}
                    disabled={pending}
                    select={selectChange}
                  />
                ))
            ) : (
              <Text style={styles.identity}>{t("workspace.git.actions.jj.loadingHistory")}</Text>
            )}
            {commits.status === "error" ? (
              <Alert variant="error" description={commits.error.message} />
            ) : null}
          </View>
        )}
        {state.error ? (
          <Alert variant="error" description={state.error} testID="jj-form-error" />
        ) : null}
        {state.status === "success" ? (
          <Alert
            variant="success"
            description={t("workspace.git.actions.jj.saved")}
            testID="jj-form-success"
          />
        ) : null}
        <View style={styles.row}>
          <Button variant="outline" size={size} disabled={pending} onPress={onClose}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            size={size}
            disabled={!state.canSubmit}
            onPress={submit}
            testID="jj-change-submit"
          >
            {submitLabel}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function ChangeSelection({
  changeId,
  commitId,
  label,
  testID,
  selected,
  size,
  disabled,
  select,
}: {
  changeId: string;
  commitId: string | null;
  label: string;
  testID: string;
  selected: boolean;
  size: "sm" | "md";
  disabled: boolean;
  select(selection: { changeId: string; label: string; commitId?: string }): void;
}) {
  const onPress = useCallback(
    () => select({ changeId, label, ...(commitId ? { commitId } : {}) }),
    [changeId, commitId, label, select],
  );
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size={size}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
    >{`${changeId.slice(0, 12)} ${label}`}</Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: { paddingHorizontal: theme.spacing[3], gap: theme.spacing[2] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  form: { padding: theme.spacing[6], gap: theme.spacing[4] },
  identity: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));

import { useCallback, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import { ToolbarLabelSelectTrigger } from "@/components/ui/toolbar-label-trigger";

interface BranchSwitcherProps {
  currentBranchName: string | null;
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  isGitCheckout: boolean;
  /** Backend of the checkout; stash affordances are skipped on jj. */
  vcs?: "git" | "jj" | null;
  /** jj: change ID of the current working-copy change (switch precondition, not a cross-process lock). */
  currentChangeId?: string | null;
  testID?: string;
}

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedGitBranch = withUnistyles(GitBranch);

export function BranchSwitcher({
  currentBranchName,
  serverId,
  workspaceId,
  workspaceDirectory,
  isGitCheckout,
  vcs = null,
  currentChangeId,
  testID = "workspace-header-branch-switcher",
}: BranchSwitcherProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const queryClient = useQueryClient();

  const {
    branchOptions,
    branchLoadMessage,
    resumeLookupError,
    isRetryingResumeLookup,
    retryResumeLookup,
    isOpen,
    isSwitching,
    setIsOpen,
    handleBranchSelect,
  } = useBranchSwitcher({
    client,
    normalizedServerId: serverId,
    normalizedWorkspaceId: workspaceId,
    workspaceDirectory,
    currentBranchName,
    isGitCheckout,
    vcs,
    currentChangeId,
    isConnected,
    toast,
    queryClient,
  });

  const handleOpen = useCallback(() => setIsOpen(true), [setIsOpen]);

  const branchLeadingSlot = useMemo(
    () => <ThemedGitBranch size={14} uniProps={foregroundMutedIconColorMapping} />,
    [],
  );

  const renderBranchOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={branchLeadingSlot}
      />
    ),
    [branchLeadingSlot],
  );

  const label = currentBranchName ?? t("branchSwitcher.title");
  const resumeErrorFooter = useMemo(
    () =>
      resumeLookupError ? (
        <View style={styles.resumeError} testID="jj-resume-lookup-error">
          <Text style={styles.resumeErrorText}>{resumeLookupError}</Text>
          <Button
            size="sm"
            variant="ghost"
            disabled={isSwitching || isRetryingResumeLookup}
            onPress={retryResumeLookup}
          >
            {t(isRetryingResumeLookup ? "common.loading" : "common.actions.retry")}
          </Button>
        </View>
      ) : null,
    [isRetryingResumeLookup, isSwitching, resumeLookupError, retryResumeLookup, t],
  );
  if (!currentBranchName && vcs !== "jj") {
    return null;
  }

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <ToolbarLabelSelectTrigger
            testID={testID}
            label={isSwitching ? t("workspace.git.actions.jj.saving") : label}
            disabled={isSwitching}
            open={isOpen}
            onPress={handleOpen}
            accessibilityRole="button"
            accessibilityLabel={t("branchSwitcher.currentBranch", {
              branchName: label,
            })}
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <Text style={styles.tooltipText}>{t("branchSwitcher.triggerTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={branchOptions}
        value={currentBranchName ?? ""}
        onSelect={handleBranchSelect}
        searchable
        placeholder={t("branchSwitcher.placeholder")}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={branchLoadMessage ?? t("branchSwitcher.empty")}
        title={t("branchSwitcher.title")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderBranchOption}
        footer={resumeErrorFooter}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 1,
    minWidth: 0,
  },
  tooltipText: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
  },
  resumeError: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: 4,
  },
  resumeErrorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));

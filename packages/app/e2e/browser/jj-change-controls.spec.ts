import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { loadSessionMessageReaders } from "../support/helpers/new-workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// Worker-scoped environment belongs at file scope, not inside describe.
test.use({
  // Pi catalog discovery loads user extensions, which can write into these temp checkouts.
  e2eDaemonConfig: { version: 1, agents: { providers: { pi: { enabled: false } } } },
});
const cleanupTasks: Array<{ run(): Promise<void> }> = [];
test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) await task.run();
});

test.describe("native jj changes", () => {
  test("Integrate keeps approval explicit, stale bases retryable and both heads stable across layout changes", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const repo = await createTempGitRepo("paseo-e2e-jj-integrate-");
    const jj = (args: string[]) =>
      execFileSync("jj", args, { cwd: repo.path, encoding: "utf8" }).trim();
    jj(["git", "init", "--colocate"]);
    jj(["config", "set", "--repo", "user.name", "Paseo E2E"]);
    jj(["config", "set", "--repo", "user.email", "e2e@paseo.test"]);
    jj(["describe", "-m", "Selected integration work"]);
    await writeFile(path.join(repo.path, "integration.txt"), "selected work\n");
    const selectedId = jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const selectedCommit = jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    const baseCommit = jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]);
    const client = await connectSeedClient();
    cleanupTasks.push({
      run: async () => {
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
      title: "Native integration",
    });
    expect(created.workspace).not.toBeNull();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace!.id));
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page, 90_000);
    const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
    const openIntegration = async () => {
      await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
      await page.getByRole("menuitem", { name: "Merge locally", exact: true }).click();
      await expect(page.getByTestId("jj-change-form")).toContainText(selectedId);
      await expect(page.getByTestId("jj-change-form")).toContainText("Selected integration work");
    };
    await openIntegration();
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-change-submit")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Approve integration", exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId("jj-form-error")).toContainText(baseCommit);
    await expect(page.getByTestId("jj-form-error")).toContainText(selectedCommit);
    await page.screenshot({ path: testInfo.outputPath("native-integration-approval-wide.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])).toBe(baseCommit);
    await openIntegration();
    await page.getByTestId("jj-change-submit").click();
    await expect(
      page.getByRole("button", { name: "Approve integration", exact: true }),
    ).toBeEnabled();
    jj(["new", "--no-edit", "main", "-m", "Updated integration base"]);
    // Descriptions include a trailing newline; the subject is the exact first line.
    const movedBase = jj([
      "log",
      "--no-graph",
      "-r",
      'subject(exact:"Updated integration base")',
      "-T",
      "commit_id",
    ]);
    expect(movedBase).toMatch(/^[0-9a-f]{40,64}$/);
    jj(["bookmark", "set", "main", "-r", movedBase]);
    await page.getByRole("button", { name: "Approve integration", exact: true }).click();
    await expect(page.getByTestId("jj-form-error")).toContainText("base moved after capture");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-form-error")).toContainText("base moved after capture");
    await expect(page.getByTestId("jj-change-form")).toContainText(selectedId);
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText("base moved after capture");
    expect(jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"])).toBe(movedBase);
    await page.screenshot({ path: testInfo.outputPath("native-integration-failure-narrow.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 1400, height: 900 });
    await panel.getByTestId("changes-refresh").click();
    await openIntegration();
    await page.getByTestId("jj-change-submit").click();
    await page.getByRole("button", { name: "Approve integration", exact: true }).click();
    await expect(page.getByTestId("jj-form-success")).toContainText(
      "The base now contains the selected work.",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-form-success")).toContainText(
      "The base now contains the selected work.",
    );
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(selectedId);
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])).toBe(selectedCommit);
    expect(jj(["file", "show", "-r", "main", "integration.txt"])).toBe("selected work");
    expect((await readFile(path.join(repo.path, "integration.txt"))).toString()).toBe(
      "selected work\n",
    );
    await page.screenshot({ path: testInfo.outputPath("native-integration-success-narrow.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Describe retains a refused draft; Finish, New and Edit keep native identities", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const repo = await createTempGitRepo("paseo-e2e-jj-");
    const jj = (args: string[]) =>
      execFileSync("jj", args, { cwd: repo.path, encoding: "utf8" }).trim();
    jj(["git", "init", "--colocate"]);
    // The daemon invokes jj without test-only CLI overrides; keep its identity
    // stable when the workspace is first inspected by a different process.
    jj(["config", "set", "--repo", "user.name", "Paseo Test"]);
    jj(["config", "set", "--repo", "user.email", "paseo-test@example.invalid"]);
    await writeFile(path.join(repo.path, "native.txt"), "native WIP\n");
    const client = await connectSeedClient();
    cleanupTasks.push({
      run: async () => {
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
      title: "Native changes",
    });
    expect(created.workspace).not.toBeNull();
    const workspace = { id: created.workspace!.id, repoPath: repo.path };
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page, 90_000);
    const currentId = () => jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const firstId = currentId();
    const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
    const describe = panel.getByTestId("jj-describe-open");
    await describe.click();
    const input = page.getByRole("textbox", { name: "Description" });
    await input.fill("Retained native description");
    await page.screenshot({ path: testInfo.outputPath("native-describe-wide.png") });
    jj(["new"]);
    expect(currentId()).not.toBe(firstId);
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-change-submit")).toBeDisabled();
    await expect(page.getByTestId("jj-change-submit")).toContainText("Saving");
    await expect(page.getByText(/changed since this form opened/)).toBeVisible();
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toHaveCount(0);
    await expect(input).toHaveValue("Retained native description");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByTestId("changes-refresh").click();
    await expect(panel.getByTestId("changes-refresh")).toBeEnabled();
    await describe.click();
    await input.fill("Native completed message");
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-success")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const describedId = currentId();
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "description"])).toBe(
      "Native completed message",
    );
    const confirmedFinish = page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.message()).toContain("not a cross-process lock");
      return dialog.accept();
    });
    await page.getByTestId("changes-primary-cta").filter({ visible: true }).click();
    await confirmedFinish;
    await expect.poll(currentId).not.toBe(describedId);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "change_id"])).toBe(describedId);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "description"])).toBe(
      "Native completed message",
    );
    await panel.getByTestId("changes-refresh").click();
    await expect(panel.getByTestId("changes-refresh")).toBeEnabled();
    await panel.getByTestId("jj-edit-open").click();
    await expect(page.getByTestId("jj-change-form")).toContainText(currentId());
    await page.getByTestId(`jj-edit-select-${describedId}`).click({ timeout: 20_000 });
    await expect(page.getByTestId("jj-selected-change")).toContainText(describedId.slice(0, 12));
    await expect(page.getByTestId("jj-selected-change")).toContainText("Native completed message");
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText(
      "Confirm the native rewrite warning",
    );
    await expect(page.getByTestId("jj-form-error")).toContainText(describedId);
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("native-edit-approval-wide.png") });
    await page.getByRole("button", { name: "Approve native rewrite", exact: true }).click();
    await expect.poll(currentId).toBe(describedId);
    await expect(page.getByTestId("jj-form-success")).toBeVisible();
    await expect(page.getByTestId("jj-selected-change")).toContainText(describedId.slice(0, 12));
    await expect(page.getByTestId("jj-selected-change")).toContainText("Native completed message");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const previousDescription = jj(["log", "--no-graph", "-r", "@", "-T", "description"]);
    await writeFile(path.join(repo.path, "native.txt"), "preserved by described new change\n");
    await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "New change", exact: true }).click();
    const newDescription = "Started from the native action";
    const newDescriptionInput = page.getByRole("textbox", { name: "Description" });
    await newDescriptionInput.fill(newDescription);
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText(
      "Confirm the native rewrite warning",
    );
    await expect(newDescriptionInput).toHaveValue(newDescription);
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Approve native rewrite", exact: true }).click();
    await expect(page.getByTestId("jj-form-success")).toBeVisible();
    await expect.poll(currentId).not.toBe(describedId);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "change_id"])).toBe(describedId);
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "description"])).toBe(newDescription);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "description"])).toBe(previousDescription);
    expect(jj(["file", "show", "--revision", "@-", "native.txt"])).toBe(
      "preserved by described new change",
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "New change", exact: true }).click();
    const retainedNewDescription = "Keep this draft after a stale change";
    const retainedInput = page.getByRole("textbox", { name: "Description" });
    await retainedInput.fill(retainedNewDescription);
    jj(["new"]);
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText("changed since this form opened");
    await expect(retainedInput).toHaveValue(retainedNewDescription);
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await panel.getByTestId("changes-refresh").click();
    await expect(panel.getByTestId("changes-refresh")).toBeEnabled();

    const capturedBase = jj(["log", "--no-graph", "-r", describedId, "-T", "commit_id"]);
    const capturedChangeId = jj(["log", "--no-graph", "-r", describedId, "-T", "change_id"]);
    await panel.getByTestId("jj-newon-open").click();
    await page.getByTestId(`jj-newon-select-${capturedBase}`).click();
    await expect(page.getByTestId("jj-selected-change")).toContainText(
      capturedChangeId.slice(0, 12),
    );
    await expect(page.getByTestId("jj-selected-change")).toContainText(capturedBase.slice(0, 12));
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-success")).toBeVisible();
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])).toBe(capturedBase);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const branchSwitcher = page.getByTestId("changes-branch-switcher").filter({ visible: true });
    jj(["new", "main", "--no-edit", "-m", "Feature base"]);
    jj(["bookmark", "create", "feature", "-r", 'description(substring:"Feature base")']);
    const beforeFeature = currentId();
    const oldBookmark = jj(["log", "--no-graph", "-r", "feature", "-T", "commit_id"]);
    await panel.getByTestId("changes-refresh").click();
    await branchSwitcher.click();
    const confirmedFeature = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.getByRole("button", { name: "feature", exact: true }).click();
    await confirmedFeature;
    await expect.poll(currentId).not.toBe(beforeFeature);
    await expect(branchSwitcher).toContainText("feature");
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])).toBe(oldBookmark);
    await writeFile(path.join(repo.path, "native.txt"), "dirty switch and same-ID Resume\n");
    const savedId = currentId();
    const main = jj(["log", "--no-graph", "-r", "main", "-T", "commit_id"]);
    await panel.getByTestId("changes-refresh").click();
    const switchToNewMain = async () => {
      await branchSwitcher.click();
      const confirmedSwitch = page.waitForEvent("dialog").then(async (dialog) => {
        expect(dialog.message()).toContain("Saved work on main");
        const newChangeConfirmation = page.waitForEvent("dialog");
        await dialog.dismiss();
        const newChangeDialog = await newChangeConfirmation;
        expect(newChangeDialog.message()).toContain("Switch to main");
        expect(newChangeDialog.message()).toContain("A new change starts");
        return newChangeDialog.accept();
      });
      await page.getByRole("button", { name: "main", exact: true }).click();
      await confirmedSwitch;
      // @ can move before checkpoint persistence and the switch response finish.
      await expect(branchSwitcher).toContainText("main");
      await expect(branchSwitcher).toBeEnabled();
    };
    await switchToNewMain();
    await expect.poll(currentId).not.toBe(savedId);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"])).toBe(main);
    expect(jj(["log", "--no-graph", "-r", "feature", "-T", "commit_id"])).toBe(oldBookmark);
    await expect(branchSwitcher).toContainText("main");
    await branchSwitcher.click();
    const confirmedResume = page.waitForEvent("dialog").then((dialog) => {
      expect(dialog.message()).toContain("same change ID");
      return dialog.accept();
    });
    await page.getByRole("button", { name: "feature", exact: true }).click();
    await confirmedResume;
    await expect.poll(currentId).toBe(savedId);
    await expect(branchSwitcher).toContainText("feature");
    await page.screenshot({ path: testInfo.outputPath("native-switch-resume-wide.png") });

    await writeFile(path.join(repo.path, "native.txt"), "saved before lookup failure\n");
    const beforeLookupFailure = currentId();
    await panel.getByTestId("changes-refresh").click();
    await switchToNewMain();
    await expect.poll(currentId).not.toBe(beforeLookupFailure);

    const checkpointDirectory = path.join(
      process.env.E2E_PASEO_HOME!,
      "projects",
      "jj-checkpoints",
    );
    let checkpointPath: string | null = null;
    for (const file of await readdir(checkpointDirectory)) {
      const candidate = path.join(checkpointDirectory, file);
      const checkpoint = JSON.parse((await readFile(candidate)).toString()) as {
        backingRoot?: string;
      };
      if (checkpoint.backingRoot === repo.path) {
        checkpointPath = candidate;
        break;
      }
    }
    expect(checkpointPath).not.toBeNull();
    const savedCheckpoint = await readFile(checkpointPath!);
    try {
      const checkpoint = JSON.parse(savedCheckpoint.toString()) as {
        savedWip: Array<{ bookmark: string | null; changeId: string }>;
      };
      const corruptedResume = checkpoint.savedWip.find((entry) => entry.bookmark === "feature");
      if (!corruptedResume) throw new Error("The fixture has no saved Resume change on feature");
      corruptedResume.changeId = "k".repeat(32);
      await writeFile(checkpointPath!, JSON.stringify(checkpoint));
      await branchSwitcher.click();
      const lookupError = page.getByTestId("jj-resume-lookup-error");
      await expect(lookupError).toContainText("could not be resolved");
      await expect(lookupError.getByRole("button", { name: "Retry" })).toBeEnabled();
      expect(currentId()).not.toBe(savedId);
      await writeFile(checkpointPath!, savedCheckpoint);
      await lookupError.getByRole("button", { name: "Retry" }).click();
      await expect(page.getByTestId("jj-resume-lookup-error")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "feature", exact: true })).toBeVisible();
    } finally {
      await writeFile(checkpointPath!, savedCheckpoint);
    }
  });
  test("Fetch and rebase keeps approval explicit and remote failures available for retry", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const repo = await createTempGitRepo("paseo-e2e-jj-fetch-rebase-");
    const jj = (args: string[]) =>
      execFileSync("jj", args, { cwd: repo.path, encoding: "utf8" }).trim();
    const origin = path.join(repo.path, ".git", "paseo-origin.git");
    execFileSync("git", ["init", "--bare", origin]);
    jj(["git", "init", "--colocate"]);
    jj(["config", "set", "--repo", "user.name", "Paseo Test"]);
    jj(["config", "set", "--repo", "user.email", "paseo-test@example.invalid"]);
    jj(["git", "remote", "add", "origin", origin]);
    jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    jj(["config", "set", "--repo", 'revset-aliases."trunk()"', "main@origin"]);
    jj(["describe", "-m", "Captured native branch"]);
    await writeFile(path.join(repo.path, "native.txt"), "local work\n");
    const currentId = () => jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const captured = currentId();
    const beforeCommit = jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    jj(["new", "-r", "main", "-m", "Updated trunk"]);
    await writeFile(path.join(repo.path, "upstream.txt"), "upstream work\n");
    jj(["bookmark", "set", "main"]);
    jj(["git", "push", "--bookmark", "main", "--remote", "origin"]);
    jj(["edit", captured]);
    const client = await connectSeedClient();
    cleanupTasks.push({
      run: async () => {
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
      title: "Fetch all remotes and rebase",
    });
    expect(created.workspace).not.toBeNull();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace!.id));
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page, 90_000);
    const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
    await panel.getByTestId("jj-fetch-rebase-open").click();
    await expect(page.getByTestId("jj-change-form")).toContainText(captured);
    await expect(page.getByTestId("jj-change-form")).toContainText("Captured native branch");
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-change-submit")).toBeDisabled();
    await expect(page.getByTestId("jj-change-submit")).toContainText("Fetching and rebasing");
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toBeEnabled();
    await expect(page.getByTestId("jj-form-error")).toContainText("all mutable work above trunk()");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"])).toBe(beforeCommit);
    await panel.getByTestId("jj-fetch-rebase-open").click();
    await page.getByTestId("jj-change-submit").click();
    await page.getByRole("button", { name: "Approve native rewrite", exact: true }).click();
    await expect(page.getByTestId("jj-form-success")).toContainText(
      "Fetched all remotes and rebased mutable work onto trunk.",
    );
    expect(currentId()).toBe(captured);
    expect((await readFile(path.join(repo.path, "upstream.txt"))).toString()).toBe(
      "upstream work\n",
    );
    await page.screenshot({ path: testInfo.outputPath("native-fetch-rebase-success-wide.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    const missingRemote = path.join(repo.path, ".git", "missing-upstream.git");
    jj(["git", "remote", "add", "upstream", missingRemote]);
    await panel.getByTestId("jj-fetch-rebase-open").click();
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText("missing-upstream.git");
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-form-error")).toContainText("missing-upstream.git");
    await expect(page.getByTestId("jj-change-form")).toContainText(captured);
    await page.getByTestId("jj-change-submit").focus();
    await expect(page.getByTestId("jj-change-submit")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("native-fetch-rebase-failure-narrow.png") });
    jj(["git", "remote", "set-url", "upstream", origin]);
    await page.getByTestId("jj-change-submit").click();
    await page.getByRole("button", { name: "Approve native rewrite", exact: true }).click();
    await expect(page.getByTestId("jj-form-success")).toContainText(
      "Mutable work is already on trunk.",
    );
    expect(currentId()).toBe(captured);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("Describe opens at narrow width with visible draft, warning and keyboard focus", async ({
    page,
  }, testInfo) => {
    const repo = await createTempGitRepo("paseo-e2e-jj-mobile-");
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: repo.path });
    execFileSync("jj", ["config", "set", "--repo", "user.name", "Paseo Test"], {
      cwd: repo.path,
    });
    execFileSync("jj", ["config", "set", "--repo", "user.email", "paseo-test@example.invalid"], {
      cwd: repo.path,
    });
    execFileSync("jj", ["config", "set", "--repo", "snapshot.max-new-file-size", "8"], {
      cwd: repo.path,
    });
    await writeFile(
      path.join(repo.path, "refused-native.txt"),
      "A new file beyond the configured native snapshot limit\n",
    );
    const client = await connectSeedClient();
    cleanupTasks.push({
      run: async () => {
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
      title: "Native compact changes",
    });
    expect(created.workspace).not.toBeNull();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace!.id));
    await page.reload();
    await page.getByTestId("workspace-explorer-toggle").first().click();
    const changesTab = page.getByTestId("explorer-tab-changes").filter({ visible: true });
    await expect(changesTab).toBeVisible({ timeout: 30_000 });
    await changesTab.click();
    const explorer = page.getByTestId("explorer-content-area").filter({ visible: true });
    await explorer.getByTestId("jj-describe-open").click();
    const input = page.getByRole("textbox", { name: "Description" });
    await expect(input).toBeVisible();
    await expect(page.getByTestId("jj-change-submit")).toBeDisabled();
    await input.fill("Compact native draft");
    await expect(page.getByTestId("jj-rewrite-warning")).toContainText("not a cross-process lock");
    await input.focus();
    await expect(input).toBeFocused();
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText("refused-native.txt");
    await expect(input).toHaveValue("Compact native draft");
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Approve native rewrite", exact: true }),
    ).toHaveCount(0);
    await input.focus();
    await expect(page.getByTestId("jj-form-error")).toContainText("refused-native.txt");
    const formBounds = await page.getByTestId("jj-change-form").boundingBox();
    expect(formBounds).not.toBeNull();
    expect(formBounds!.x).toBeGreaterThanOrEqual(0);
    expect(formBounds!.x + formBounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("native-describe-narrow.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("an older host shows an actionable update error without sending a jj mutation", async ({
    page,
  }) => {
    expect(process.env.PASEO_JJ_DISPATCH).toBeUndefined();
    const repo = await createTempGitRepo("paseo-e2e-jj-old-host-");
    const jj = (args: string[]) =>
      execFileSync("jj", args, { cwd: repo.path, encoding: "utf8" }).trim();
    jj(["git", "init", "--colocate"]);
    jj(["config", "set", "--repo", "user.name", "Paseo Test"]);
    jj(["config", "set", "--repo", "user.email", "paseo-test@example.invalid"]);
    await writeFile(path.join(repo.path, "old-host.txt"), "keep this file\n");
    const beforeChange = jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const client = await connectSeedClient();
    cleanupTasks.push({
      run: async () => {
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
      title: "Older jj host",
    });
    expect(created.workspace).not.toBeNull();
    const frames = await loadSessionMessageReaders();
    let describeRequests = 0;
    await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
      const daemonSocket = browserSocket.connectToServer();
      function forwardBrowserMessage(message: string | Buffer) {
        const request = frames.client(message);
        if (request?.type === "checkout.describe_change.request") describeRequests += 1;
        daemonSocket.send(message);
      }
      function forwardDaemonMessage(message: string | Buffer) {
        const response = frames.server(message);
        if (response?.type === "status" && response.payload.status === "server_info") {
          const features = z.record(z.string(), z.unknown()).parse(response.payload.features);
          expect(features["checkoutJjCheckpoint"]).toBe(true);
          expect(features["checkoutJjGraphSelections"]).toBe(true);
          delete features["checkoutJjRewriteApproval"];
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: { ...response, payload: { ...response.payload, features } },
            }),
          );
          return;
        }
        browserSocket.send(message);
      }
      browserSocket.onMessage(forwardBrowserMessage);
      daemonSocket.onMessage(forwardDaemonMessage);
    });

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace!.id));
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page, 90_000);
    const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
    await panel.getByTestId("jj-describe-open").click();
    const input = page.getByRole("textbox", { name: "Description" });
    await input.fill("Keep this draft on an older host");
    await page.getByTestId("jj-change-submit").click();
    await expect(page.getByTestId("jj-form-error")).toContainText(
      "Update the host to use structured jj rewrite approval.",
    );
    await expect(input).toHaveValue("Keep this draft on an older host");
    await expect(page.getByTestId("jj-change-submit")).toBeEnabled();
    expect(describeRequests).toBe(0);
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(beforeChange);
    expect(await readFile(path.join(repo.path, "old-host.txt"), "utf8")).toBe("keep this file\n");
  });
});

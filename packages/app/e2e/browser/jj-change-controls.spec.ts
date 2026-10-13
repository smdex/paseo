import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// Worker-scoped environment belongs at file scope, not inside describe.
test.use({ e2eDaemonEnvironment: { PASEO_JJ_DISPATCH: "1" } });
const cleanupTasks: Array<{ run(): Promise<void> }> = [];
test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) await task.run();
});

test.describe("native jj changes", () => {
  test("Describe retains a refused draft; Finish, New and Edit keep native identities", async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const repo = await createTempGitRepo("paseo-e2e-jj-");
    const jj = (args: string[]) =>
      execFileSync("jj", args, { cwd: repo.path, encoding: "utf8" }).trim();
    jj(["git", "init", "--colocate"]);
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
    await expect(page.getByText(/changed since this form opened/)).toBeVisible();
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
    await panel.getByTestId("jj-edit-open").click();
    await page.getByRole("button", { name: new RegExp(describedId.slice(0, 12)) }).click();
    await page.getByTestId("jj-change-submit").click();
    await expect.poll(currentId).toBe(describedId);
    await expect(page.getByTestId("jj-form-success")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
    const confirmedNew = page.waitForEvent("dialog").then((dialog) => dialog.accept());
    await page.getByRole("menuitem", { name: "New change", exact: true }).click();
    await confirmedNew;
    await expect.poll(currentId).not.toBe(describedId);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "change_id"])).toBe(describedId);
  });
  test("Describe opens at narrow width with visible draft, warning and keyboard focus", async ({
    page,
  }, testInfo) => {
    const repo = await createTempGitRepo("paseo-e2e-jj-mobile-");
    execFileSync("jj", ["git", "init", "--colocate"], { cwd: repo.path });
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
    const formBounds = await page.getByTestId("jj-change-form").boundingBox();
    expect(formBounds).not.toBeNull();
    expect(formBounds!.x).toBeGreaterThanOrEqual(0);
    expect(formBounds!.x + formBounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath("native-describe-narrow.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});

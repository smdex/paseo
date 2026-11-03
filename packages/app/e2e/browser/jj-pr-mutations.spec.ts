import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { test, expect } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import { connectSeedClient } from "../support/helpers/seed-client";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test.use({ e2eDaemonEnvironment: { PASEO_JJ_DISPATCH: "1" } });
const stateSchema = z.object({
  number: z.number(),
  headSha: z.string(),
  blocked: z.boolean(),
  autoMergeEnabled: z.boolean(),
  merged: z.boolean(),
  fail: z.boolean(),
  commands: z.array(z.object({ operation: z.string(), args: z.array(z.string()) })),
});
for (const operation of ["merge", "enable", "disable"] as const) {
  test(`native PR ${operation} retains pending, failure and retry results across layouts`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180000);
    const repo = await createTempGitRepo("paseo-e2e-jj-pr-mutation-");
    const client = await connectSeedClient();
    const jj = (args: string[]) =>
      execFileSync(
        "jj",
        [
          "--config",
          "user.name=Paseo E2E",
          "--config",
          "user.email=paseo-e2e@example.invalid",
          "--no-pager",
          "--color",
          "never",
          ...args,
        ],
        { cwd: repo.path, encoding: "utf8" },
      ).trim();
    const statePath = path.join(repo.path, ".git", "paseo-e2e-pr-mutations.json");
    try {
      execFileSync(
        "git",
        ["remote", "add", "origin", "https://github.com/paseo-e2e/local-fixture.git"],
        { cwd: repo.path },
      );
      jj(["git", "init", "--colocate"]);
      jj(["new", "main"]);
      await writeFile(path.join(repo.path, "native-feature.txt"), "Published feature\n");
      jj(["describe", "-m", "Published feature"]);
      jj(["bookmark", "create", "feature"]);
      const headSha = jj(["log", "--no-graph", "-r", "feature", "-T", "commit_id"]);
      jj(["new"]);
      await writeFile(path.join(repo.path, "unpublished.txt"), "Local work stays untouched\n");
      const selected = jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
      const initial = {
        number: 42,
        headSha,
        blocked: operation !== "merge",
        autoMergeEnabled: operation === "disable",
        merged: false,
        fail: true,
        commands: [],
      };
      await writeFile(statePath, JSON.stringify(initial));
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
        title: `Native PR ${operation}`,
      });
      if (!created.workspace) throw new Error("Expected native workspace fixture");
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
      await waitForWorkspaceTabsVisible(page);
      await openChangesPanel(page);
      await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
      const label = {
        merge: "Merge PR (squash)",
        enable: "Auto merge (squash)",
        disable: "Disable auto-merge",
      }[operation];
      await page.getByRole("menuitem", { name: label, exact: true }).click();
      await expect(page.getByTestId("jj-pr-mutation-identity")).toContainText(
        "paseo-e2e/local-fixture #42",
      );
      await page.getByTestId("jj-pr-mutation-submit").click();
      await expect(page.getByTestId("jj-pr-mutation-submit")).toBeDisabled();
      await expect(page.getByTestId("jj-pr-mutation-submit")).toContainText(
        { merge: "Merging PR", enable: "Enabling auto-merge", disable: "Disabling auto-merge" }[
          operation
        ],
      );
      await expect(page.getByTestId("jj-pr-mutation-error")).toContainText(
        "Provider refused the captured PR",
      );
      await expect(page.getByTestId("jj-pr-mutation-submit")).toHaveText("Retry");
      const failed = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
      expect(failed.commands.map((command) => command.operation)).toEqual([operation]);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(1);
      await expect(page.getByTestId("jj-pr-mutation-error")).toContainText(
        "Provider refused the captured PR",
      );
      await expect(page.getByTestId("jj-pr-mutation-identity")).toContainText("#42");
      await page.screenshot({ path: testInfo.outputPath(`${operation}-failure-narrow.png`) });
      await writeFile(statePath, JSON.stringify({ ...failed, fail: false }));
      await page.getByTestId("jj-pr-mutation-submit").click();
      const success = {
        merge: "PR merged",
        enable: "Auto-merge enabled",
        disable: "Auto-merge disabled",
      }[operation];
      await expect(page.getByTestId("jj-pr-mutation-success")).toHaveText(success);
      await expect(page.getByTestId("jj-pr-mutation-submit")).toBeDisabled();
      await page.setViewportSize({ width: 1400, height: 900 });
      await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(1);
      await expect(page.getByTestId("jj-pr-mutation-success")).toHaveText(success);
      const completed = stateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
      expect(completed.commands.map((command) => command.operation)).toEqual([
        operation,
        operation,
      ]);
      expect(jj(["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(selected);
      expect(await readFile(path.join(repo.path, "unpublished.txt"), "utf8")).toBe(
        "Local work stays untouched\n",
      );
      await expect(page).toHaveURL(new RegExp(created.workspace.id));
      await page
        .getByTestId("jj-pr-mutation-form")
        .getByRole("button", { name: "Dismiss", exact: true })
        .click();
      await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
}

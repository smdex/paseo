import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { expect, test } from "../support/fixtures";
import { createTempGithubRepo } from "../support/helpers/github-fixtures";
import { connectSeedClient } from "../support/helpers/seed-client";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const credentialEnvironment = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_1: "!gh auth git-credential",
};
test.use({ e2eDaemonEnvironment: { PASEO_JJ_DISPATCH: "1", ...credentialEnvironment } });

function command(binary: string, args: string[], cwd?: string): string {
  return execFileSync(binary, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...credentialEnvironment },
  }).trim();
}
function jj(cwd: string, args: string[]): string {
  return command(
    "jj",
    [
      "--config",
      "user.name=Paseo E2E",
      "--config",
      "user.email=paseo-e2e@example.invalid",
      "--config",
      "experimental-advance-branches.enabled-branches=[]",
      "--no-pager",
      "--color",
      "never",
      ...args,
    ],
    cwd,
  );
}

test("native Create PR preserves a failed draft, prevents duplicate submission, and shows the created request", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const reusable = process.env.PASEO_E2E_REUSE_GITHUB_PR;
  const generated = reusable
    ? null
    : await createTempGithubRepo({ category: "jj-pr-create", prs: [] });
  const fullName = reusable ? reusable.split("#")[0] : generated!.fullName;
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-create-pr-"));
  const branch = `paseo-e2e-jj-create-${randomUUID()}`;
  const client = await connectSeedClient();
  try {
    const base = command("gh", [
      "repo",
      "view",
      fullName,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    command("git", [
      "clone",
      "--quiet",
      "--branch",
      base,
      `https://github.com/${fullName}.git`,
      cwd,
    ]);
    jj(cwd, ["git", "init", "--colocate"]);
    jj(cwd, ["new", base]);
    await writeFile(
      path.join(cwd, "native-create-pr.txt"),
      "Published through the native Create PR action.\n",
    );
    jj(cwd, ["describe", "-m", "Native PR feature"]);
    jj(cwd, ["bookmark", "create", branch]);
    const headSha = jj(cwd, ["log", "--no-graph", "-r", branch, "-T", "commit_id"]);
    jj(cwd, ["new"]);
    const selected = jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Native PR creation",
    });
    if (!created.workspace) throw new Error("Expected the native workspace fixture");
    const route = buildHostWorkspaceRoute(getServerId(), created.workspace.id);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(route);
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page);
    await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "Create PR", exact: true }).click();
    const title = page.getByTestId("jj-pr-title");
    const body = page.getByTestId("jj-pr-body");
    const baseInput = page.getByTestId("jj-pr-base");
    const titleText = `Native publication ${branch}`;
    await title.fill(titleText);
    await body.fill("This body must survive a provider refusal.");
    await baseInput.fill("paseo-e2e-missing-base");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(title).toHaveValue(titleText);
    await expect(body).toHaveValue("This body must survive a provider refusal.");
    await expect(baseInput).toHaveValue("paseo-e2e-missing-base");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByTestId("jj-pr-submit").click();
    await expect(page.getByTestId("jj-pr-submit")).toBeDisabled();
    await expect(page.getByTestId("jj-pr-submit")).toContainText("Creating PR");
    await expect(page.getByTestId("jj-pr-error")).toContainText(/base/i, { timeout: 60_000 });
    await expect(title).toHaveValue(titleText);
    await expect(body).toHaveValue("This body must survive a provider refusal.");
    await expect(baseInput).toHaveValue("paseo-e2e-missing-base");
    await expect(page.getByTestId("jj-pr-submit")).toBeEnabled();
    await expect(page).toHaveURL(new RegExp(created.workspace.id));
    expect(jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(selected);
    await page.screenshot({ path: testInfo.outputPath("native-pr-failure-wide.png") });
    await baseInput.fill(base);
    await page.getByTestId("jj-pr-submit").click();
    await expect(page.getByTestId("jj-pr-success")).toContainText("PR Created", {
      timeout: 60_000,
    });
    const requests = z
      .array(
        z.object({
          number: z.number(),
          title: z.string(),
          body: z.string(),
          headRefOid: z.string(),
          headRefName: z.string(),
          baseRefName: z.string(),
        }),
      )
      .parse(
        JSON.parse(
          command("gh", [
            "pr",
            "list",
            "--repo",
            fullName,
            "--head",
            branch,
            "--json",
            "number,title,body,headRefOid,headRefName,baseRefName",
          ]),
        ),
      );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      title: titleText,
      body: "This body must survive a provider refusal.",
      headRefOid: headSha,
      headRefName: branch,
      baseRefName: base,
    });
    await expect(page.getByTestId("jj-pr-success")).toContainText(`#${requests[0]!.number}`);
    await expect(page.getByRole("button", { name: "View PR", exact: true })).toBeVisible();
    expect(jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(selected);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-pr-success")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("native-pr-success-narrow.png") });
  } finally {
    try {
      const requests = z
        .array(z.object({ number: z.number() }))
        .parse(
          JSON.parse(
            command("gh", ["pr", "list", "--repo", fullName, "--head", branch, "--json", "number"]),
          ),
        );
      for (const request of requests)
        command("gh", ["pr", "close", String(request.number), "--repo", fullName]);
      try {
        command("gh", ["api", "-X", "DELETE", `repos/${fullName}/git/refs/heads/${branch}`]);
      } catch (error) {
        testInfo.annotations.push({
          type: "cleanup",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
      await generated?.cleanup();
    }
  }
});

test("native direct merge acts on the captured published PR and preserves local jj work across layouts", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const reusable = process.env.PASEO_E2E_REUSE_GITHUB_PR;
  const generated = reusable
    ? null
    : await createTempGithubRepo({ category: "jj-pr-merge", prs: [] });
  const fullName = reusable ? reusable.split("#")[0] : generated!.fullName;
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-merge-pr-"));
  const prefix = `paseo-e2e-jj-merge-${randomUUID()}`;
  const base = `${prefix}-base`;
  const head = `${prefix}-head`;
  const client = await connectSeedClient();
  try {
    const defaultBase = command("gh", [
      "repo",
      "view",
      fullName,
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ]);
    command("git", [
      "clone",
      "--quiet",
      "--branch",
      defaultBase,
      `https://github.com/${fullName}.git`,
      cwd,
    ]);
    command("git", ["checkout", "-b", base], cwd);
    command("git", ["push", "origin", base], cwd);
    jj(cwd, ["git", "init", "--colocate"]);
    jj(cwd, ["new", base]);
    await writeFile(
      path.join(cwd, "published-native-feature.txt"),
      "Only this published feature belongs in the PR.\n",
    );
    jj(cwd, ["describe", "-m", "Published native merge feature"]);
    jj(cwd, ["bookmark", "create", head]);
    jj(cwd, ["git", "push", "--bookmark", head, "--remote", "origin"]);
    const published = jj(cwd, ["log", "--no-graph", "-r", head, "-T", "commit_id"]);
    const prUrl = command("gh", [
      "pr",
      "create",
      "--repo",
      fullName,
      "--base",
      base,
      "--head",
      head,
      "--title",
      `Native merge ${prefix}`,
      "--body",
      "Merge only the published jj feature.",
    ]);
    const pr = z
      .object({ number: z.number() })
      .parse(
        JSON.parse(command("gh", ["pr", "view", prUrl, "--repo", fullName, "--json", "number"])),
      );
    jj(cwd, ["new"]);
    await writeFile(
      path.join(cwd, "unpublished-native-change.txt"),
      "A local descendant must not be pushed by Merge PR.\n",
    );
    jj(cwd, ["describe", "-m", "Local unpublished descendant"]);
    jj(cwd, ["bookmark", "move", head, "--to", "@"]);
    const localHead = jj(cwd, ["log", "--no-graph", "-r", head, "-T", "commit_id"]);
    expect(localHead).not.toBe(published);
    jj(cwd, ["new"]);
    await writeFile(
      path.join(cwd, "unpublished-native-wip.txt"),
      "This local work must remain unpublished.\n",
    );
    const selected = jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "change_id"]);
    const created = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Native direct PR merge",
    });
    if (!created.workspace) throw new Error("Expected native workspace fixture");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await waitForWorkspaceTabsVisible(page);
    await openChangesPanel(page);
    await page.getByTestId("changes-primary-cta-caret").filter({ visible: true }).click();
    await page
      .getByRole("menuitem", { name: "Merge PR (squash)", exact: true })
      .click({ timeout: 60_000 });
    await expect(page.getByTestId("jj-pr-mutation-identity")).toContainText(
      `${fullName} #${pr.number}`,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(1);
    await expect(page.getByTestId("jj-pr-mutation-identity")).toContainText(`#${pr.number}`);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(1);
    await page.getByTestId("jj-pr-mutation-submit").click();
    await expect(page.getByTestId("jj-pr-mutation-submit")).toBeDisabled();
    await expect(page.getByTestId("jj-pr-mutation-submit")).toContainText("Merging PR");
    await expect(page.getByTestId("jj-pr-mutation-success")).toHaveText("PR merged", {
      timeout: 60_000,
    });
    const merged = z
      .object({ state: z.string(), headRefOid: z.string(), baseRefName: z.string() })
      .parse(
        JSON.parse(
          command("gh", [
            "pr",
            "view",
            String(pr.number),
            "--repo",
            fullName,
            "--json",
            "state,headRefOid,baseRefName",
          ]),
        ),
      );
    expect(merged).toEqual({ state: "MERGED", headRefOid: published, baseRefName: base });
    expect(command("git", ["ls-remote", "origin", `refs/heads/${head}`], cwd).split(/\s+/)[0]).toBe(
      published,
    );
    expect(jj(cwd, ["log", "--no-graph", "-r", head, "-T", "commit_id"])).toBe(localHead);
    expect(jj(cwd, ["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(selected);
    expect(await readFile(path.join(cwd, "unpublished-native-wip.txt"), "utf8")).toBe(
      "This local work must remain unpublished.\n",
    );
    await expect(page).toHaveURL(new RegExp(created.workspace.id));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(1);
    await expect(page.getByTestId("jj-pr-mutation-success")).toHaveText("PR merged");
    await expect(page.getByTestId("jj-pr-mutation-identity")).toContainText(`#${pr.number}`);
    await page.screenshot({ path: testInfo.outputPath("native-direct-merge-success-narrow.png") });
    await page
      .getByTestId("jj-pr-mutation-form")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(page.getByTestId("jj-pr-mutation-form")).toHaveCount(0);
  } finally {
    try {
      const open = z
        .array(z.object({ number: z.number() }))
        .parse(
          JSON.parse(
            command("gh", ["pr", "list", "--repo", fullName, "--head", head, "--json", "number"]),
          ),
        );
      for (const request of open)
        command("gh", ["pr", "close", String(request.number), "--repo", fullName]);
      for (const branch of [head, base]) {
        try {
          command("gh", ["api", "-X", "DELETE", `repos/${fullName}/git/refs/heads/${branch}`]);
        } catch (error) {
          testInfo.annotations.push({
            type: "cleanup",
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
      await generated?.cleanup();
    }
  }
});

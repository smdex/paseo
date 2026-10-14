import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

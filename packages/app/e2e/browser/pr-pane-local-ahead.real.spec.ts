import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace } from "../support/helpers/launcher";
import { createTempGithubRepo, type GhPrFixture } from "../support/helpers/github-fixtures";
import {
  connectWorkspaceSetupClient,
  openProjectViaDaemon,
  type WorkspaceSetupDaemonClient,
} from "../support/helpers/workspace-setup";
import { getServerId } from "../support/helpers/server-id";
import { expectPrPaneState, expectPrPaneTitle, openPrPane } from "../support/helpers/pr-pane";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

test.use({ e2eDaemonEnvironment: { PASEO_JJ_DISPATCH: "1" } });

test.describe("PR pane for a jj workspace with unpublished work", () => {
  test.describe.configure({ retries: 0, timeout: 180_000 });

  test("keeps the open PR visible when the local bookmark advances beyond its published head", async ({
    page,
  }) => {
    let repo: Awaited<ReturnType<typeof createTempGithubRepo>> | undefined;
    let client: WorkspaceSetupDaemonClient | undefined;
    let fixtureCleanup: (() => Promise<void>) | undefined;
    let pr: GhPrFixture | undefined;
    let owner: string | undefined;
    let prPath: string | undefined;
    let originalRemoteUrl: string | undefined;
    try {
      const reusablePr = process.env.PASEO_E2E_REUSE_GITHUB_PR;
      if (reusablePr) {
        const reusable = await cloneExistingGithubPr(reusablePr);
        ({ pr, owner } = reusable);
        fixtureCleanup = reusable.cleanup;
      } else {
        repo = await createTempGithubRepo({
          category: "pr-pane-local-ahead",
          prs: [{ title: "Open PR with local work ahead", state: "open" }],
        });
        pr = repo.prs[0];
        owner = repo.owner;
        fixtureCleanup = () => repo!.cleanup();
      }
      if (!pr) throw new Error("Expected the open pull request fixture");
      prPath = pr.localPath;

      runJj(pr.localPath, ["git", "init", "--colocate"]);
      runJj(pr.localPath, ["new"]);
      await writeFile(`${pr.localPath}/unpublished.txt`, "Local work ahead of the PR head.\n");
      runJj(pr.localPath, ["describe", "-m", "Local work ahead of the PR head"]);
      runJj(pr.localPath, ["bookmark", "set", pr.branch, "-r", "@"]);
      originalRemoteUrl = runGit(pr.localPath, ["remote", "get-url", "origin"]);

      client = await connectWorkspaceSetupClient();
      const workspace = await openProjectViaDaemon(client, pr.localPath);
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: workspace.id,
      });
      await gotoWorkspace(page, workspace.id);
      await openPrPane(page);

      await expectPrPaneTitle(page, pr.title);
      await expect(page.getByTestId("pr-pane-title")).toContainText(`#${pr.number}`);
      await expectPrPaneState(page, "open");

      runJj(pr.localPath, [
        "git",
        "remote",
        "set-url",
        "origin",
        `https://github.com/${owner}/paseotmp-missing-${Date.now()}.git`,
      ]);
      await page.getByTestId("pr-pane-refresh").click();
      const paneError = page.getByTestId("pr-pane-error");
      await expect(paneError).toContainText("Failed to refresh git state.", { timeout: 30_000 });
      const retry = paneError.getByRole("button", { name: "Retry", exact: true });
      await expect(retry).toBeEnabled();
      await expect(page).toHaveURL(new RegExp(workspace.id));

      runJj(pr.localPath, ["git", "remote", "set-url", "origin", originalRemoteUrl]);
      await retry.click();
      await expectPrPaneTitle(page, pr.title);
      await expect(page.getByTestId("pr-pane-title")).toContainText(`#${pr.number}`);
      await expectPrPaneState(page, "open");
      await expect(page).toHaveURL(new RegExp(workspace.id));
    } finally {
      try {
        if (prPath && originalRemoteUrl) {
          runJj(prPath, ["git", "remote", "set-url", "origin", originalRemoteUrl]);
        }
      } finally {
        await client?.close().catch(() => undefined);
        await fixtureCleanup?.().catch(() => undefined);
      }
    }
  });
});

function runJj(cwd: string, args: string[]): void {
  const result = spawnSync(
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
    { cwd, encoding: "utf8", env: { ...process.env, JJ_EDITOR: "true" } },
  );
  if (result.status !== 0) {
    throw new Error(`jj ${args[0]} failed: ${result.stderr.trim()}`);
  }
}

async function cloneExistingGithubPr(reference: string): Promise<{
  owner: string;
  pr: GhPrFixture;
  cleanup(): Promise<void>;
}> {
  const match = /^([^/]+\/[^#]+)#(\d+)$/.exec(reference);
  if (!match) throw new Error("PASEO_E2E_REUSE_GITHUB_PR must be owner/repository#number");
  const fullName = match[1];
  const number = Number(match[2]);
  const authEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
  const details = runCommand(
    "gh",
    ["pr", "view", String(number), "--repo", fullName, "--json", "number,title,url,headRefName"],
    authEnv,
  );
  const parsed = z
    .object({
      number: z.number(),
      title: z.string(),
      url: z.string(),
      headRefName: z.string(),
    })
    .parse(JSON.parse(details));
  const localPath = await mkdtemp(path.join(tmpdir(), "paseo-existing-pr-"));
  try {
    runCommand(
      "git",
      [
        "clone",
        "--quiet",
        "--branch",
        parsed.headRefName,
        `https://github.com/${fullName}.git`,
        localPath,
      ],
      authEnv,
    );
    runCommand("git", ["config", "user.name", "Paseo E2E"], authEnv, localPath);
    runCommand("git", ["config", "user.email", "paseo-e2e@example.invalid"], authEnv, localPath);
  } catch (error) {
    await rm(localPath, { recursive: true, force: true });
    throw error;
  }
  return {
    owner: fullName.split("/")[0],
    pr: {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      branch: parsed.headRefName,
      localPath,
    },
    cleanup: () => rm(localPath, { recursive: true, force: true }),
  };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status})`);
  }
  return result.stdout.trim();
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status})`);
  }
  return result.stdout.trim();
}

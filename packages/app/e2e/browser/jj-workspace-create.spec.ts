import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  loadSessionMessageReaders,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({
  // Pi catalog discovery loads user extensions, which can write into these temp checkouts.
  e2eDaemonConfig: { version: 1, agents: { providers: { pi: { enabled: false } } } },
});

test("jj sibling creation shows pending, preserves collision errors, and retries once into the result", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(process.env.PASEO_JJ_DISPATCH).toBeUndefined();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-jj-sibling-"));
  const repo = path.join(directory, "project");
  await mkdir(repo);
  const jj = (args: string[], cwd = repo) =>
    execFileSync(
      "jj",
      [
        "--no-pager",
        "--color=never",
        "--config",
        "user.name=Paseo Test",
        "--config",
        "user.email=paseo-test@example.invalid",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    ).trim();
  jj(["git", "init", "--no-colocate"]);
  await writeFile(path.join(repo, "base.txt"), "base\n");
  jj(["commit", "-m", "base"]);
  jj(["new", "-m", "current parent"]);
  jj(["new", "-m", "current change"]);
  await writeFile(path.join(repo, "current.txt"), "keep current\n");
  const current = jj(["log", "--no-graph", "-r", "@", "-T", "change_id"]);
  const parent = jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"]);
  const client = await connectNewWorkspaceDaemonClient();
  let releaseCreation = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseCreation = resolve;
  });
  let requestSeen = () => {};
  const requested = new Promise<void>((resolve) => {
    requestSeen = resolve;
  });
  const slugs: string[] = [];
  let sibling = "";
  try {
    const project = await openProjectViaDaemon(client, repo);
    const frames = await loadSessionMessageReaders();
    await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
      const server = ws.connectToServer();
      ws.onMessage(async (message) => {
        const request = frames.client(message);
        if (request?.type === "workspace.create.request" && request.source?.kind === "worktree") {
          expect(request.source.refName).toBe("@-");
          const slug = request.source.worktreeSlug;
          expect(slug).toEqual(expect.any(String));
          slugs.push(slug!);
          if (slugs.length === 1) {
            sibling = path.join(directory, `project-${slug}`);
            await mkdir(sibling);
            await writeFile(path.join(sibling, "keep.txt"), "occupied\n");
            requestSeen();
            await gate;
          }
        }
        server.send(message);
      });
      server.onMessage((message) => ws.send(message));
    });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    await page.getByTestId("workspace-create-isolation-trigger").click();
    await page.getByTestId("workspace-create-isolation-worktree").click();
    const submit = page.getByTestId("workspace-create-submit").filter({ visible: true });
    await submit.click();
    await requested;
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("jj-create-pending.png") });
    releaseCreation();
    const error = page
      .getByText(
        `Workspace path already exists: ${sibling}. Choose a different worktree name or remove the existing directory before retrying.`,
        { exact: true },
      )
      .first();
    await expect(error).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => slugs.length).toBe(2);
    await expect(error).toBeVisible();
    await expect(submit).toBeEnabled();
    await expect(page).toHaveURL(/\/new(?:\?.*)?$/);
    expect(await readFile(path.join(sibling, "keep.txt"), "utf8")).toBe("occupied\n");
    await page.screenshot({ path: testInfo.outputPath("jj-create-collision.png") });
    await rm(sibling, { recursive: true });
    await submit.click();
    const result = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: project.workspaceId,
      projectDisplayName: project.projectDisplayName,
    });
    expect(result.workspaceDirectory).toBe(sibling);
    expect(new Set(slugs).size).toBe(1);
    expect(slugs).toHaveLength(3);
    expect(jj(["log", "--no-graph", "-r", "@-", "-T", "commit_id"], sibling)).toBe(parent);
    expect(jj(["log", "--no-graph", "-r", "@", "-T", "change_id"])).toBe(current);
    expect(await readFile(path.join(repo, "current.txt"), "utf8")).toBe("keep current\n");
    const workspaces = await client.fetchWorkspaces();
    expect(
      workspaces.entries.filter((workspace) => workspace.workspaceDirectory === sibling),
    ).toHaveLength(1);
    expect(jj(["workspace", "list", "-T", 'name ++ "\n"']).split("\n")).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath("jj-create-success.png") });
  } finally {
    releaseCreation();
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

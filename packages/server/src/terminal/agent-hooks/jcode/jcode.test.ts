import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { jcodeAgentHookProvider } from "./jcode.js";

const temporaryDirs: string[] = [];

// TMPDIR can point anywhere (a scratch dir on dev machines); pin temp files to
// the OS default so nothing strays into shared state.
beforeAll(() => {
  delete process.env.TMPDIR;
});

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function readConfigToml(configDir: string): string {
  return readFileSync(join(configDir, "config.toml"), "utf8");
}

function hookLine(event: string): string {
  return `${event} = "paseo hooks jcode ${event}"`;
}

describe("Jcode terminal agent hooks", () => {
  it("creates a [hooks] table with one command per event, idempotently", () => {
    const configDir = createTempDir("paseo-jcode-config-");

    installAgentHooks(jcodeAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    for (const event of jcodeAgentHookProvider.events) {
      expect(config).toContain(`\n${hookLine(event.event)}`);
    }
    expect(config).toContain("[hooks]");
    expect(secondInstall.changed).toBe(false);
    expect(agentHooksAreInstalled(jcodeAgentHookProvider, { configDir })).toBe(true);
  });

  it("appends the [hooks] table after existing config without touching it", () => {
    const configDir = createTempDir("paseo-jcode-config-append-");
    const existing = [
      "# my config",
      "[provider]",
      'model = "astra"',
      "",
      "[hooks]",
      "# my hook notes",
      'pre_tool = "~/bin/my-policy"',
      "pre_tool_timeout_ms = 5000",
      "",
      "[ambient]",
      "enabled = true",
    ].join("\n");
    writeFileSync(join(configDir, "config.toml"), existing);

    installAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    // Existing keys, comments, and sibling tables survive byte-for-byte.
    expect(config).toContain('pre_tool = "~/bin/my-policy"');
    expect(config).toContain("# my hook notes");
    expect(config).toContain("pre_tool_timeout_ms = 5000");
    expect(config).toContain("[ambient]\nenabled = true");
    // Paseo hooks land after the existing [hooks] body, before [ambient].
    const hooksBody = config.slice(config.indexOf("[hooks]"), config.indexOf("[ambient]"));
    expect(hooksBody).toContain(`\n${hookLine("turn_end")}`);
    expect(agentHooksAreInstalled(jcodeAgentHookProvider, { configDir })).toBe(true);
  });

  it("never overrides a user hook on a claimed key", () => {
    const configDir = createTempDir("paseo-jcode-config-claimed-");
    writeFileSync(join(configDir, "config.toml"), '[hooks]\nturn_end = "~/bin/my-notify"\n');

    installAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    expect(config).toContain('turn_end = "~/bin/my-notify"');
    expect(config).not.toContain(hookLine("turn_end"));
  });

  it("uninstalls only its own exact lines and keeps user lines with the marker in a comment", () => {
    const configDir = createTempDir("paseo-jcode-config-uninstall-");
    installAgentHooks(jcodeAgentHookProvider, { configDir });
    const installed = readConfigToml(configDir);
    writeFileSync(
      join(configDir, "config.toml"),
      `${installed}[hooks.extra]\n# run paseo hooks jcode turn_end yourself if you want it\n`,
    );

    uninstallAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    for (const event of jcodeAgentHookProvider.events) {
      expect(config).not.toContain(hookLine(event.event));
    }
    // The user's comment and unrelated table survive; isInstalled goes false
    // even though the comment mentions the marker.
    expect(config).toContain("# run paseo hooks jcode turn_end yourself if you want it");
    expect(config).toContain("[hooks.extra]");
    expect(agentHooksAreInstalled(jcodeAgentHookProvider, { configDir })).toBe(false);
  });

  it("removes a [hooks] table it created, and keeps one the user created", () => {
    const createdDir = createTempDir("paseo-jcode-config-drop-");
    installAgentHooks(jcodeAgentHookProvider, { configDir: createdDir });
    uninstallAgentHooks(jcodeAgentHookProvider, { configDir: createdDir });
    // An emptied file stays as an empty file rather than being deleted.
    expect(readConfigToml(createdDir)).toBe("");

    const userDir = createTempDir("paseo-jcode-config-keep-");
    writeFileSync(
      join(userDir, "config.toml"),
      "[hooks]\n# my notes\n\n[ambient]\nenabled = true\n",
    );
    installAgentHooks(jcodeAgentHookProvider, { configDir: userDir });
    uninstallAgentHooks(jcodeAgentHookProvider, { configDir: userDir });
    expect(readConfigToml(userDir)).toBe("[hooks]\n# my notes\n\n[ambient]\nenabled = true\n");
  });

  it("is a no-op when the [hooks] body has unsupported syntax", () => {
    const configDir = createTempDir("paseo-jcode-config-multiline-");
    const existing = [
      "[hooks]",
      'turn_end = """',
      "notify-send jcode",
      '"""',
      "",
      "[ambient]",
      "enabled = true",
    ].join("\n");
    writeFileSync(join(configDir, "config.toml"), existing);

    installAgentHooks(jcodeAgentHookProvider, { configDir });

    expect(readConfigToml(configDir)).toBe(existing);
    expect(agentHooksAreInstalled(jcodeAgentHookProvider, { configDir })).toBe(false);

    // Even after a supported install, unsupported syntax blocks later edits.
    const mixedDir = createTempDir("paseo-jcode-config-mixed-");
    installAgentHooks(jcodeAgentHookProvider, { configDir: mixedDir });
    const installed = readConfigToml(mixedDir);
    writeFileSync(
      join(mixedDir, "config.toml"),
      installed.replace(hookLine("session_start"), 'session_start = """multiline\nvalue"""'),
    );
    uninstallAgentHooks(jcodeAgentHookProvider, { configDir: mixedDir });
    expect(readConfigToml(mixedDir)).toContain('"""multiline');
    expect(readConfigToml(mixedDir)).toContain(hookLine("turn_end"));
  });

  it("does not touch an inline [hooks.x] subtable as if it were [hooks]", () => {
    const configDir = createTempDir("paseo-jcode-config-inline-");
    const existing = "[hooks.notifications]\nenabled = true\n";
    writeFileSync(join(configDir, "config.toml"), existing);

    installAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    expect(config).toContain("[hooks.notifications]\nenabled = true");
    expect(config).toContain("[hooks]");
    expect(config).toContain(hookLine("turn_end"));
  });

  it("is a no-op for alternative hooks-table spellings it cannot prove", () => {
    for (const existing of [
      '[hooks] # my comment\nturn_end = "notify"\n',
      '[ hooks ]\nturn_end = "notify"\n',
      '["hooks"]\nturn_end = "notify"\n',
      'hooks = { turn_end = "notify" }\n',
      'hooks.turn_end = "notify"\n',
      '"hooks" = { turn_end = "notify" }\n',
      'hooks . turn_end = "notify"\n',
      '["ho\\u006fks"]\nturn_end = "notify"\n',
    ]) {
      const configDir = createTempDir("paseo-jcode-config-variant-");
      writeFileSync(join(configDir, "config.toml"), existing);

      installAgentHooks(jcodeAgentHookProvider, { configDir });
      uninstallAgentHooks(jcodeAgentHookProvider, { configDir });

      // The write is newline-normalized but no content is added or removed.
      expect(readConfigToml(configDir)).toBe(existing);
      expect(agentHooksAreInstalled(jcodeAgentHookProvider, { configDir })).toBe(false);
    }
  });

  it("is a no-op when a multiline string anywhere contains a [hooks]-looking line", () => {
    const configDir = createTempDir("paseo-jcode-config-multiline-anywhere-");
    const existing = '[dictation]\ncommand = """\n[hooks]\nturn_end = x\n"""\n';
    writeFileSync(join(configDir, "config.toml"), existing);

    installAgentHooks(jcodeAgentHookProvider, { configDir });
    uninstallAgentHooks(jcodeAgentHookProvider, { configDir });

    expect(readConfigToml(configDir)).toBe(existing);
  });

  it("is a no-op for CRLF files", () => {
    const configDir = createTempDir("paseo-jcode-config-crlf-");
    const existing = '[hooks]\r\nturn_end = "notify"\r\n';
    writeFileSync(join(configDir, "config.toml"), existing);

    installAgentHooks(jcodeAgentHookProvider, { configDir });

    expect(readConfigToml(configDir)).toBe(existing);
  });

  it("never removes a user line under a different key with Paseo's exact value", () => {
    const configDir = createTempDir("paseo-jcode-config-cross-key-");
    installAgentHooks(jcodeAgentHookProvider, { configDir });
    const installed = readConfigToml(configDir);
    // A user line under a different key whose value is byte-identical to Paseo's start hook.
    const poisoned = `${installed.replace("\n\n", "\n")}stop = ${JSON.stringify(
      `paseo hooks jcode session_start`,
    )}\n`;
    writeFileSync(join(configDir, "config.toml"), poisoned);

    uninstallAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    expect(config).toContain(`stop = "paseo hooks jcode session_start"`);
    expect(config).not.toContain("session_start =");
  });

  it("never removes a same-text line owned by another table", () => {
    const configDir = createTempDir("paseo-jcode-config-cross-table-");
    installAgentHooks(jcodeAgentHookProvider, { configDir });
    const installed = readConfigToml(configDir);
    writeFileSync(
      join(configDir, "config.toml"),
      `${installed}[ambient]\n${hookLine("turn_end")}\n`,
    );

    uninstallAgentHooks(jcodeAgentHookProvider, { configDir });

    const config = readConfigToml(configDir);
    // Paseo's own line inside [hooks] is gone; the copy under [ambient] stays.
    const hooksBody = config.slice(config.indexOf("[hooks]"), config.indexOf("[ambient]"));
    expect(hooksBody).not.toContain(hookLine("turn_end"));
    expect(config.slice(config.indexOf("[ambient]")).trim()).toBe(
      `[ambient]\n${hookLine("turn_end")}`,
    );
  });

  it("maps events to activity states", async () => {
    for (const [event, state] of [
      ["session_start", "running"],
      ["post_tool", "running"],
      ["turn_end", "idle"],
      ["session_end", "idle"],
      ["pre_tool", null],
    ] as const) {
      await expect(
        jcodeAgentHookProvider.resolveActivity({
          event,
          input: { read: async () => null },
        }),
      ).resolves.toBe(state);
    }
  });
});

import type { AgentHookConfigFormat } from "../agent-hook-installer.js";

/**
 * Jcode hook configuration is TOML (`~/.jcode/config.toml`) and each `[hooks]`
 * key holds exactly one command string that jcode executes directly (no shell).
 * There is no TOML parser among the workspace dependencies, so the format keeps
 * the whole file as raw text and rewrites only the exact `event = "paseo hooks
 * jcode <event>"` lines it previously wrote.
 *
 * Fail-closed: any file this line editor cannot fully model is returned
 * unchanged — CRLF endings, multi-line strings anywhere (a `[hooks]`-looking
 * line inside one would corrupt the lexical scan), and any alternative spelling
 * of the hooks table itself (`[hooks] # comment`, `["hooks"]`, root
 * `hooks = {...}`, root dotted `hooks.x = …`). Appending our own `[hooks]` next
 * to any of those would be invalid or conflicting TOML, so we prove table
 * identity or do not edit. Ownership of existing lines is an exact decoded-value
 * match, so a user value or comment that merely contains the marker text is
 * never mistaken for a Paseo hook.
 *
 * Byte fidelity: untouched lines survive verbatim, but the write is
 * newline-normalized — the file always ends with exactly one `\n` (the shared
 * installer's atomic write). A file the editor emptied stays as an empty file.
 */
export const jcodeHooksFormat: AgentHookConfigFormat<string> = {
  empty() {
    return "";
  },
  parse(raw) {
    return raw;
  },
  stringify(config) {
    if (config.length === 0) return config;
    return config.endsWith("\n") ? config : `${config}\n`;
  },
  install(config, provider) {
    if (!isFileSupported(config)) return config;
    const lines = toLines(config);
    const range = ensureHooksTable(lines);
    if (!isTableBodySupported(lines, range)) return config;

    for (const event of provider.events) {
      removePaseoAssignments(lines, range, event.event, provider.id);
      // jcode allows one command per hook key. Never override a user hook; the
      // event just goes unreported and isInstalled stays false until they free
      // the key.
      if (hasAssignment(lines, range, event.event)) continue;
      lines.splice(
        range.end,
        0,
        `${event.event} = ${tomlString(hookCommand(provider.id, event.event))}`,
      );
      range.end += 1;
    }

    return fromLines(lines);
  },
  uninstall(config, provider) {
    if (!isFileSupported(config)) return config;
    const lines = toLines(config);
    const range = findHooksTable(lines);
    if (!range) return config;
    if (!isTableBodySupported(lines, range)) return config;

    for (const event of provider.events) {
      removePaseoAssignments(lines, range, event.event, provider.id);
    }

    // Drop the [hooks] table only when nothing but blank lines remain. A
    // comment is enough to keep it: that table existed before Paseo.
    const bodyBlank = lines
      .slice(range.start + 1, range.end)
      .every((line) => line.trim().length === 0);
    if (bodyBlank) {
      lines.splice(range.start, range.end - range.start);
      const previous = range.start - 1;
      if (previous >= 0 && (lines[previous] ?? "").trim().length === 0) {
        lines.splice(previous, 1);
      }
    }

    return fromLines(lines);
  },
  isInstalled(config, provider) {
    if (!isFileSupported(config)) return false;
    const lines = toLines(config);
    const range = findHooksTable(lines);
    if (!range) return false;

    return provider.events.every((event) => {
      return assignments(lines, range, event.event).some((line) =>
        isPaseoAssignment(line, event.event, provider.id),
      );
    });
  },
};

/**
 * jcode parses the command shell-style but executes it directly, so the POSIX
 * gate other providers use cannot run here. `paseo hooks` already no-ops when
 * `PASEO_TERMINAL_ID` is absent, and the daemon prepends its CLI directory to
 * terminal `PATH`, which resolves `paseo` inside Paseo terminals.
 */
function hookCommand(providerId: string, event: string): string {
  return `paseo hooks ${providerId} ${event}`;
}

function tomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface LineRange {
  start: number;
  /** Exclusive end: index of the next table header or lines.length. */
  end: number;
}

function findHooksTable(lines: string[]): LineRange | null {
  for (let index = 0; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() !== "[hooks]") continue;
    let end = index + 1;
    while (end < lines.length && !isTableHeader(lines[end] ?? "")) end += 1;
    return { start: index, end };
  }
  return null;
}

function ensureHooksTable(lines: string[]): LineRange {
  const existing = findHooksTable(lines);
  if (existing) return existing;

  if (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length > 0) {
    lines.push("");
  }
  lines.push("[hooks]");
  return { start: lines.length - 1, end: lines.length };
}

function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

const ASSIGNMENT_PATTERN = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

function assignments(lines: string[], range: LineRange, event: string): string[] {
  const found: string[] = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index] ?? "";
    const match = ASSIGNMENT_PATTERN.exec(line);
    if (match?.[1] === event) found.push(line);
  }
  return found;
}

function hasAssignment(lines: string[], range: LineRange, event: string): boolean {
  return assignments(lines, range, event).length > 0;
}

/** Exact decoded-value match on the same key; only the line Paseo wrote is Paseo's. */
function isPaseoAssignment(line: string, event: string, providerId: string): boolean {
  const match = ASSIGNMENT_PATTERN.exec(line);
  const value = match?.[2]?.trim() ?? "";
  return match?.[1] === event && decodeTomlBasicString(value) === hookCommand(providerId, event);
}

function removePaseoAssignments(
  lines: string[],
  range: LineRange,
  event: string,
  providerId: string,
): void {
  // Indices inside the table only, removed back to front so earlier indices
  // stay valid; a same-text line in another table must never be touched.
  const indices: number[] = [];
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (isPaseoAssignment(lines[index] ?? "", event, providerId)) indices.push(index);
  }
  for (const index of indices.toReversed()) {
    lines.splice(index, 1);
    range.end -= 1;
  }
}

function decodeTomlBasicString(value: string): string | null {
  if (!/^"(?:[^"\\\n]|\\.)*"$/.test(value)) return null;
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"' };
  return value
    .slice(1, -1)
    .replaceAll(/\\(.)/g, (full: string, escaped: string) => escapes[escaped] ?? full);
}

/**
 * A second spelling of the hooks table anywhere in the file: `[hooks] # note`,
 * `[ hooks ]`, `"hooks" = {…}`, root dotted `hooks . x = …`, or any quoted
 * table header ("hooks", "ho\u006fks", …). Any of these means we cannot prove
 * which table our lines belong to, so the file is not editable. Rather than
 * model TOML key decoding, we only ever edit files whose every key and table
 * header is bare.
 */
const HOOKS_TABLE_VARIANT = /^\[\s*["']?hooks["']?\s*\]/;
const ROOT_HOOKS_KEY = /^hooks\s*(\.|=)/;
const QUOTED_TABLE_HEADER = /^\[\s*["']/;
const QUOTED_KEY = /^\s*["']/;

function isFileSupported(config: string): boolean {
  if (config.includes("\r")) return false;
  const lines = toLines(config);
  if (lines.some((line) => line.includes('"""') || line.includes("'''"))) return false;
  return !lines.some((line) => {
    const trimmed = line.trim();
    if (trimmed === "[hooks]") return false;
    if (HOOKS_TABLE_VARIANT.test(trimmed) || ROOT_HOOKS_KEY.test(trimmed)) return true;
    // Reject quoted table headers and quoted assignment keys outright.
    if (QUOTED_TABLE_HEADER.test(trimmed) || QUOTED_KEY.test(trimmed)) return true;
    return false;
  });
}

/**
 * Supported body: blank lines, comments, and single-line `key = value`
 * assignments with a bare key. Multiline strings, dotted keys, and any line
 * that is not recognizably an assignment or comment make the table unsupported
 * and every edit a no-op.
 */
function isTableBodySupported(lines: string[], range: LineRange): boolean {
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = ASSIGNMENT_PATTERN.exec(line);
    if (!match) return false;
    if (match[2]?.includes('"""') || match[2]?.includes("'''")) return false;
  }
  return true;
}

function toLines(config: string): string[] {
  const lines = config.split("\n");
  // A trailing newline is representation, not content; dropping the phantom
  // empty element keeps inserts at the true end of the table.
  if (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") {
    lines.pop();
  }
  return lines;
}

function fromLines(lines: string[]): string {
  return lines.join("\n");
}

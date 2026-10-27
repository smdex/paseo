import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pLimit from "p-limit";
import { looksLikeDefiniteWindowsPath, normalizePathPreservingCase } from "./path.js";

// Shared by all daemon service/session instances. This excludes daemon lifecycle
// operations, not external jj/editor processes; those still require retention.
interface LifecycleTail {
  active: boolean;
  done: Promise<void>;
}
// ponytail: one identity lookup at a time preserves admission order; shard only with a proven alias-safe key.
const lifecycleIdentityQueue = pLimit(1);
const lifecycleTails = new Map<string, LifecycleTail>();
const lifecycleOwners = new AsyncLocalStorage<ReadonlyMap<string, LifecycleTail>>();

export async function workspaceLifecycleKey(path: string): Promise<string> {
  const normalize = (value: string) => {
    const windows = looksLikeDefiniteWindowsPath(value);
    const normalized = normalizePathPreservingCase(value, windows);
    return windows ? normalized.toLowerCase() : normalized;
  };
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return normalize(join(await realpath(ancestor), ...suffix));
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return normalize(resolve(path));
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function withWorkspaceLifecycle<T>(
  backingRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = await lifecycleIdentityQueue(() => workspaceLifecycleKey(backingRoot));
  const previous = lifecycleTails.get(key);
  const inherited = lifecycleOwners.getStore();
  if (inherited?.get(key)?.active) return operation();
  let release!: () => void;
  const entry = {
    active: false,
    done: new Promise<void>((resolveDone) => {
      release = resolveDone;
    }),
  };
  lifecycleTails.set(key, entry);
  await previous?.done;
  try {
    entry.active = true;
    const owners = new Map(inherited);
    owners.set(key, entry);
    return await lifecycleOwners.run(owners, operation);
  } finally {
    entry.active = false;
    release();
    if (lifecycleTails.get(key) === entry) lifecycleTails.delete(key);
  }
}

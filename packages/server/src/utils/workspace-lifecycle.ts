import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizePathForIdentity } from "./path.js";

// Shared by all daemon service/session instances. This excludes daemon lifecycle
// operations, not external jj/editor processes; those still require retention.
interface LifecycleTail {
  active: boolean;
  done: Promise<void>;
}
const lifecycleTails = new Map<string, LifecycleTail>();
const lifecycleOwners = new AsyncLocalStorage<ReadonlyMap<string, LifecycleTail>>();

export function workspaceLifecycleKey(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return normalizePathForIdentity(join(realpathSync(ancestor), ...suffix));
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return normalizePathForIdentity(resolve(path));
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function withWorkspaceLifecycle<T>(
  backingRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = workspaceLifecycleKey(backingRoot);
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

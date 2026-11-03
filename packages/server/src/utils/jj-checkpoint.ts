import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../server/atomic-file.js";
import { resolvePaseoHome } from "../server/paseo-home.js";
import { workspaceLifecycleKey } from "./workspace-lifecycle.js";
import { resolveJjRepoIdentity } from "./vcs-backend.js";
import {
  PaseoWorktreeMetadataSchema,
  readJjWorkspaceIncarnation,
  readPaseoWorktreeMetadata,
  writePaseoWorktreeMetadataFile,
} from "./worktree-metadata.js";

const HeadSchema = z.object({
  commitId: z.string().regex(/^[0-9a-f]{40,64}$/),
  changeId: z.string().regex(/^[k-z]{32}$/),
});
const OperationSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "describe",
    "finish",
    "new",
    "edit",
    "rename",
    "restore",
    "fetch-rebase",
    "integrate",
  ]),
  before: HeadSchema,
  target: HeadSchema.optional(),
  impact: z
    .object({ otherWorkspaces: z.number().int().nonnegative(), published: z.boolean() })
    .optional(),
  beforeOperation: z.string(),
  // Native bookmarks follow rewrites; resolve this pin at beforeOperation
  // for the captured head. The live name alone is not an immutable reference.
  recoveryPin: z.string(),
  affectedHeads: z.array(HeadSchema),
  status: z.enum(["pending", "completed", "reconciliation_required", "refused"]),
  after: HeadSchema.nullable(),
  afterOperation: z.string().nullable(),
  error: z.string().nullable(),
});
export const JjCheckpointSchema = z.object({
  version: z.literal(1),
  backingRoot: z.string(),
  sharedStore: z.string(),
  incarnation: z.string().nullable(),
  generation: z.number().int().nonnegative(),
  metadata: PaseoWorktreeMetadataSchema.nullable(),
  selection: HeadSchema,
  completedChanges: z.array(HeadSchema),
  // Capture ownership; an ancestor bookmark is not the WIP's owning line.
  savedWip: z.array(HeadSchema.extend({ bookmark: z.string().nullable().optional() })),
  comparison: z.object({ pinnedCommitId: z.string().nullable(), liveBase: z.string().nullable() }),
  // Keep forge identity stable when PR checkout adds a remote to the shared store, even without a local bookmark.
  forgeRemote: z.object({ remoteName: z.string(), remoteUrl: z.string() }).optional(),
  publication: z
    .object({
      remoteName: z.string(),
      remoteUrl: z.string(),
      localBookmark: z.string(),
      remoteBookmark: z.string(),
      sourceRepository: z.string().nullable(),
      targetRepository: z.string().nullable(),
    })
    .nullable(),
  recoveryPins: z.array(z.string()),
  operations: z.array(OperationSchema),
});
export type JjCheckpoint = z.infer<typeof JjCheckpointSchema>;
export type JjCheckpointOperation = z.infer<typeof OperationSchema>;
export type JjCheckpointHead = z.infer<typeof HeadSchema>;

export class JjCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JjCheckpointError";
  }
}

export class JjRewriteApprovalRequiredError extends JjCheckpointError {
  constructor(message: string) {
    super(message);
    this.name = "JjRewriteApprovalRequiredError";
  }
}

export async function jjCheckpointPath(
  backingRoot: string,
  paseoHome?: string,
  incarnation?: string | null,
): Promise<string> {
  if (incarnation === undefined) incarnation = await readJjWorkspaceIncarnation(backingRoot);
  const key = createHash("sha256")
    .update(JSON.stringify([await workspaceLifecycleKey(backingRoot), incarnation]))
    .digest("hex");
  return join(
    paseoHome ? resolve(paseoHome) : resolvePaseoHome(),
    "projects",
    "jj-checkpoints",
    `${key}.json`,
  );
}

function liveCheckpointReference(backingRoot: string): string {
  return join(backingRoot, ".jj", "paseo-checkpoint-reference.json");
}

async function checkpointReferenceExists(
  backingRoot: string,
  paseoHome?: string,
): Promise<boolean> {
  for (const reference of [
    `${await jjCheckpointPath(backingRoot, paseoHome)}.reference`,
    liveCheckpointReference(backingRoot),
  ]) {
    try {
      await fs.access(reference);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return false;
}

export async function readJjCheckpoint(
  backingRoot: string,
  paseoHome?: string,
): Promise<JjCheckpoint | null> {
  try {
    return JjCheckpointSchema.parse(
      JSON.parse(await fs.readFile(await jjCheckpointPath(backingRoot, paseoHome), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (!(await checkpointReferenceExists(backingRoot, paseoHome))) return null;
      throw new JjCheckpointError(
        "The saved jj checkpoint is missing; its durable reference remains. Reconcile it before mutation.",
      );
    }
    throw new JjCheckpointError(
      "The saved jj checkpoint cannot be read. Reconcile it on the host before changing this workspace.",
    );
  }
}

// Callers hold the existing backing-root lifecycle owner. Atomic rename is a
// daemon-local commit boundary, not a lock against another daemon or jj CLI.
export async function writeJjCheckpoint(
  checkpoint: JjCheckpoint,
  paseoHome?: string,
): Promise<JjCheckpoint> {
  const next = JjCheckpointSchema.parse({ ...checkpoint, generation: checkpoint.generation + 1 });
  const path = await jjCheckpointPath(next.backingRoot, paseoHome, next.incarnation);
  await writeJsonFileAtomic(path, next);
  const reference = {
    backingRoot: next.backingRoot,
    sharedStore: next.sharedStore,
    incarnation: next.incarnation,
  };
  await writeJsonFileAtomic(`${path}.reference`, reference);
  if (
    (await readJjWorkspaceIncarnation(next.backingRoot)) !== next.incarnation ||
    !(await resolveJjRepoIdentity(next.backingRoot))
  )
    throw new JjCheckpointError(
      "The live checkout changed while saving its checkpoint; retained state requires reconciliation.",
    );
  // This materialized reference survives loss of the checkpoint directory. It
  // is not another owner, and archives retain their registry reference after .jj disposal.
  await writeJsonFileAtomic(liveCheckpointReference(next.backingRoot), reference);
  return next;
}

function ownership(metadata: JjCheckpoint["metadata"]): string | null {
  return metadata?.version === 2 ? (metadata.jjBookmark ?? null) : null;
}

export async function validateJjCheckpoint(
  checkpoint: JjCheckpoint,
  backingRoot: string,
): Promise<void> {
  const identity = await resolveJjRepoIdentity(backingRoot);
  const incarnation = await readJjWorkspaceIncarnation(backingRoot);
  if (
    !identity ||
    checkpoint.backingRoot !== (await workspaceLifecycleKey(backingRoot)) ||
    checkpoint.sharedStore !== (await workspaceLifecycleKey(identity.sharedStorePath)) ||
    checkpoint.incarnation !== incarnation
  ) {
    throw new JjCheckpointError(
      "The jj checkpoint belongs to a different backing checkout. Live files and retained heads were not changed.",
    );
  }
  const live = await readPaseoWorktreeMetadata(backingRoot);
  if (metadataAuthority(live) !== metadataAuthority(checkpoint.metadata)) {
    throw new JjCheckpointError(
      "The live jj metadata does not match its saved checkpoint. Reconcile ownership and comparison state before changing this workspace.",
    );
  }
}

function metadataAuthority(metadata: JjCheckpoint["metadata"]): string {
  return JSON.stringify({
    owner: ownership(metadata),
    base: metadata?.baseRef ?? null,
    baseName: metadata?.baseRefName ?? null,
    publicationHint: metadata?.changeRequestLookupTarget ?? null,
  });
}

export async function jjArchiveCheckpointPath(
  backingRoot: string,
  pin: string,
  paseoHome?: string,
): Promise<string> {
  const key = createHash("sha256").update(pin).digest("hex");
  const rootKey = createHash("sha256")
    .update(await workspaceLifecycleKey(backingRoot))
    .digest("hex");
  const home = paseoHome ? resolve(paseoHome) : resolvePaseoHome();
  return join(home, "projects", "jj-checkpoints", "archives", rootKey, `${key}.json`);
}

export async function writeJjArchiveCheckpoint(
  checkpoint: JjCheckpoint,
  pin: string,
  paseoHome?: string,
): Promise<void> {
  await writeJsonFileAtomic(
    await jjArchiveCheckpointPath(checkpoint.backingRoot, pin, paseoHome),
    checkpoint,
  );
}

export async function readJjArchiveCheckpoint(
  backingRoot: string,
  pin: string,
  paseoHome?: string,
): Promise<JjCheckpoint | null> {
  try {
    return JjCheckpointSchema.parse(
      JSON.parse(
        await fs.readFile(await jjArchiveCheckpointPath(backingRoot, pin, paseoHome), "utf8"),
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new JjCheckpointError(
      "The retained archive checkpoint cannot be read. No recovery effects were started.",
    );
  }
}

export async function importJjCheckpoint(input: {
  backingRoot: string;
  head: JjCheckpointHead;
  paseoHome?: string;
}): Promise<JjCheckpoint> {
  const existing = await readJjCheckpoint(input.backingRoot, input.paseoHome);
  if (existing) {
    await validateJjCheckpoint(existing, input.backingRoot);
    return existing;
  }
  const identity = await resolveJjRepoIdentity(input.backingRoot);
  if (!identity) throw new JjCheckpointError("The jj backing checkout is unavailable.");
  const metadata = await readPaseoWorktreeMetadata(input.backingRoot);
  if (metadata && (!metadata.baseRef || !/^[0-9a-f]{40,64}$/.test(metadata.baseRef)))
    throw new JjCheckpointError(
      "Legacy jj comparison metadata has no exact base pin. Reconcile it before importing a checkpoint.",
    );
  const baseName = metadata?.baseRefName ?? null;
  const liveBase =
    baseName && baseName !== "@" && !/^[0-9a-f]{40,64}$/.test(baseName) ? baseName : null;
  return writeJjCheckpoint(
    {
      version: 1,
      backingRoot: await workspaceLifecycleKey(input.backingRoot),
      sharedStore: await workspaceLifecycleKey(identity.sharedStorePath),
      incarnation: await readJjWorkspaceIncarnation(input.backingRoot),
      generation: 0,
      metadata,
      selection: input.head,
      completedChanges: [],
      savedWip: [],
      comparison: { pinnedCommitId: metadata?.baseRef ?? null, liveBase },
      publication: null,
      recoveryPins: [],
      operations: [],
    },
    input.paseoHome,
  );
}

const RestorePhaseSchema = z.object({
  version: z.literal(1),
  backingRoot: z.string(),
  sharedStore: z.string(),
  incarnation: z.string().nullable(),
  recoveryPin: z.string(),
  archiveGeneration: z.number().int().nonnegative(),
  selection: HeadSchema,
  status: z.enum(["pending", "completed"]),
});
export type JjRestorePhase = z.infer<typeof RestorePhaseSchema>;
const RestoreReferenceSchema = RestorePhaseSchema.omit({ status: true });
type JjRestoreReference = z.infer<typeof RestoreReferenceSchema>;

function restoreReference(phase: JjRestorePhase): JjRestoreReference {
  const { status: _status, ...reference } = phase;
  return reference;
}

// Registration precedes UUID/metadata materialization. This root-keyed fact
// must be discoverable even by a newly registered child with no UUID yet.
async function jjRestorePhasePath(backingRoot: string, paseoHome?: string): Promise<string> {
  const key = createHash("sha256")
    .update(await workspaceLifecycleKey(backingRoot))
    .digest("hex");
  return join(
    paseoHome ? resolve(paseoHome) : resolvePaseoHome(),
    "projects",
    "jj-checkpoints",
    "restores",
    `${key}.json`,
  );
}

async function readRestoreJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateRestoreReference(
  reference: JjRestoreReference,
  backingRoot: string,
  paseoHome?: string,
): Promise<void> {
  const archive = await readJjArchiveCheckpoint(backingRoot, reference.recoveryPin, paseoHome);
  if (
    !archive ||
    reference.backingRoot !== (await workspaceLifecycleKey(backingRoot)) ||
    archive.backingRoot !== reference.backingRoot ||
    archive.sharedStore !== reference.sharedStore ||
    archive.incarnation !== reference.incarnation ||
    archive.generation !== reference.archiveGeneration ||
    !archive.recoveryPins.includes(reference.recoveryPin) ||
    JSON.stringify(archive.selection) !== JSON.stringify(reference.selection)
  )
    throw new JjCheckpointError(
      "The jj restoration reference differs from its retained archive authority; reconcile before unarchive, mutation or publication.",
    );
}

export async function readJjRestorePhase(
  backingRoot: string,
  paseoHome?: string,
): Promise<JjRestorePhase | null> {
  try {
    const path = await jjRestorePhasePath(backingRoot, paseoHome);
    const [payload, witness] = await Promise.all([
      readRestoreJson(path),
      readRestoreJson(`${path}.reference`),
    ]);
    const reference = witness === undefined ? null : RestoreReferenceSchema.parse(witness);
    if (reference) await validateRestoreReference(reference, backingRoot, paseoHome);
    if (payload === undefined) {
      if (reference)
        throw new JjCheckpointError(
          "The required jj restoration phase is missing; its retained reference requires reconciliation before unarchive, mutation or publication.",
        );
      return null;
    }
    const phase = RestorePhaseSchema.parse(payload);
    const authority = restoreReference(phase);
    // Older phase payloads have no witness; they remain readable but never
    // bypass their exact archived authority. New begins retain the witness.
    await validateRestoreReference(authority, backingRoot, paseoHome);
    if (reference && JSON.stringify(reference) !== JSON.stringify(authority))
      throw new JjCheckpointError(
        "The jj restoration phase differs from its retained reference; reconciliation is required.",
      );
    return phase;
  } catch (error) {
    if (error instanceof JjCheckpointError) throw error;
    throw new JjCheckpointError(
      "The saved jj restoration phase cannot be read; reconcile it before unarchive, mutation or publication.",
    );
  }
}

export async function assertJjRestorationResolved(
  backingRoot: string,
  paseoHome?: string,
): Promise<void> {
  const phase = await readJjRestorePhase(backingRoot, paseoHome);
  if (phase && phase.status !== "completed")
    throw new JjCheckpointError(
      "An unresolved jj restoration requires reconciliation before unarchive, mutation or publication; files and pins remain retained.",
    );
}

export async function beginJjCheckpointRestoration(
  checkpoint: JjCheckpoint,
  recoveryPin: string,
  paseoHome?: string,
): Promise<JjRestorePhase> {
  await assertJjRestorationResolved(checkpoint.backingRoot, paseoHome);
  const phase: JjRestorePhase = {
    version: 1,
    backingRoot: checkpoint.backingRoot,
    sharedStore: checkpoint.sharedStore,
    incarnation: checkpoint.incarnation,
    recoveryPin,
    archiveGeneration: checkpoint.generation,
    selection: checkpoint.selection,
    status: "pending",
  };
  const reference = restoreReference(phase);
  await validateRestoreReference(reference, phase.backingRoot, paseoHome);
  // A missing payload after this boundary is required state, not legacy absence.
  await writeJsonFileAtomic(
    `${await jjRestorePhasePath(phase.backingRoot, paseoHome)}.reference`,
    reference,
  );
  await writeJsonFileAtomic(await jjRestorePhasePath(phase.backingRoot, paseoHome), phase);
  return phase;
}

export async function completeJjCheckpointRestoration(
  phase: JjRestorePhase,
  paseoHome?: string,
): Promise<void> {
  const current = await readJjRestorePhase(phase.backingRoot, paseoHome);
  if (JSON.stringify(current) !== JSON.stringify(phase))
    throw new JjCheckpointError(
      "The jj restoration phase changed; retained heads require reconciliation.",
    );
  await writeJsonFileAtomic(await jjRestorePhasePath(phase.backingRoot, paseoHome), {
    ...phase,
    status: "completed",
  });
}

export async function restoreJjCheckpoint(input: {
  backingRoot: string;
  sharedStore: string;
  incarnation: string;
  paseoHome?: string;
  recoveryPin: string;
}): Promise<JjCheckpoint | null> {
  const checkpoint = await readJjArchiveCheckpoint(
    input.backingRoot,
    input.recoveryPin,
    input.paseoHome,
  );
  // Legacy restoration retains its exact-pin contract. Once a checkpoint
  // exists, its identity and pin must agree; never reconstruct from a live base.
  if (!checkpoint) return null;
  if (
    checkpoint.incarnation !== input.incarnation ||
    checkpoint.sharedStore !== (await workspaceLifecycleKey(input.sharedStore)) ||
    !checkpoint.recoveryPins.includes(input.recoveryPin)
  ) {
    throw new JjCheckpointError(
      "The retained checkpoint does not authorize this recovery pin or backing checkout.",
    );
  }
  if (checkpoint.metadata)
    await writePaseoWorktreeMetadataFile(input.backingRoot, checkpoint.metadata);
  const current = await readJjCheckpoint(input.backingRoot, input.paseoHome);
  const generation = Math.max(checkpoint.generation, current?.generation ?? 0);
  const operations = new Map(
    [...checkpoint.operations, ...(current?.operations ?? [])].map((operation) => [
      operation.id,
      operation,
    ]),
  );
  const pins = new Set([...checkpoint.recoveryPins, ...(current?.recoveryPins ?? [])]);
  await writeJjCheckpoint(
    { ...checkpoint, generation, operations: [...operations.values()], recoveryPins: [...pins] },
    input.paseoHome,
  );
  return checkpoint;
}

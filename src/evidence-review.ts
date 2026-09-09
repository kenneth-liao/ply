/**
 * Evidence inspection for the new workflow (#109, spec #102 US-005, ADR-0014):
 * one presentation-integrity boundary that turns verified evidence into a
 * self-contained offline review sheet. Two callers, one renderer:
 *
 * - `reviewPublishedGeneration` — a published Generation Job's external
 *   evidence (out/generation, out/matting): the exact ordered References
 *   verified against the identities recorded at Job creation, every output
 *   verified against its content identity, and the associated matte — found
 *   by the derived sha-256 source linkage (#108's inverse) and verified
 *   before display.
 * - `reviewRetainedLayer` — a Project Layer's retained evidence
 *   (generation/, matting/, content/): the hash-verified retained bytes, the
 *   retained matte/generation lineage, and caller References shown only when
 *   their recorded paths still verify. Unavailable References are labeled
 *   with their recorded identity — never substituted, never invented — so
 *   review stays usable offline after the external temporary files are gone
 *   and the Project is relocated.
 *
 * Poka-yoke at the presentation boundary: every displayed image is embedded
 * as a data URL of bytes that were hash-verified FIRST; missing, corrupt,
 * ambiguous, or unreadable evidence fails the review (or is explicitly
 * labeled unavailable) instead of rendering something the record does not
 * vouch for. The renderer is an executable-document boundary: every
 * interpolated string is context-escaped, the CSP forbids everything but
 * embedded evidence, and the sheet is published atomically so a failed write
 * never truncates a prior sheet.
 *
 * A review is evidence, never a verdict: nothing here implies likeness
 * approval or canonical cutout promotion (ADR-0014). No function here
 * generates, runs an engine, adopts into a library, or touches the network.
 */
import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import type { GenerationJobRecord } from "./generation.js";
import type { MattingRecord } from "./matting.js";
import { loadVerifiedGenerationOutputs, resolveRetainedProvenance, type RetainedProvenance } from "./generation-retention.js";
import {
  selectMatteOutput,
  findMatteForSource,
  resolveRetainedMattingProvenance,
  RETAINED_MATTING_DIR,
  type RetainedMattingProvenance,
} from "./matting-retention.js";
import { readLayerInternalFull, type ResolvedLayer } from "./layer.js";
import { resolveProjectRoot } from "./project.js";
import { withProjectLock, atomicCreate } from "./project-lock.js";
import { atomicReplace } from "./reference-import.js";
import { outsideDir } from "./paths.js";
import { dataUrl, escapeHtml } from "./html.js";

/** One displayed Reference: verified bytes, or an explicit unavailable label. */
export interface EvidenceReference {
  label: string;
  /** The caller-supplied path exactly as the record wrote it. */
  path: string;
  /** The recorded sha-256 content identity derived at Job creation. */
  contentHash: string;
  /** The verified bytes, or null when they cannot be vouched for. */
  bytes: Buffer | null;
  /** When bytes is null: the plain reason, shown on the sheet. */
  unavailable: string | null;
}

/** One displayed candidate image — always verified bytes. */
export interface EvidenceCandidate {
  label: string;
  contentHash: string;
  bytes: Buffer;
  note?: string;
}

/** The matte evidence associated with one candidate. */
export interface EvidenceMatte {
  forLabel: string;
  present: boolean;
  bytes: Buffer | null;
  matteId?: string;
  engine?: string;
  alpha?: { width: number; height: number; transparentPx: number; opaquePx: number };
  note?: string;
}

export interface EvidenceSheetInput {
  title: string;
  subtitle?: string;
  /** Record facts shown as rows — identities, request facts, lineage. */
  facts: [string, string][];
  references: EvidenceReference[];
  candidates: EvidenceCandidate[];
  mattes: EvidenceMatte[];
}

export interface PublishedGenerationReviewOutput {
  contentHash: string;
  file: string;
  mediaType: string;
  bytes: Buffer;
  matte: { matteId: string; engine: string; contentHash: string; file: string; bytes: Buffer } | null;
}

export interface PublishedGenerationReview {
  jobId: string;
  reviewPath: string;
  references: { label: string; path: string; contentHash: string; bytes: Buffer }[];
  outputs: PublishedGenerationReviewOutput[];
}

export interface RetainedLayerReview {
  layerId: string;
  reviewPath: string;
  candidate: { label: string; contentHash: string; bytes: Buffer };
  references: EvidenceReference[];
  /** The retained Generation Job whose output is (or preceded) these bytes. */
  generation: { jobId: string; output: { contentHash: string; file: string } } | null;
  /** The retained matte whose output IS these bytes (a matted Layer). */
  matting: { matteId: string; engine: string; alpha: { width: number; height: number; transparentPx: number; opaquePx: number } } | null;
  /** A generated candidate's associated matte (matted result ingested as another Layer). */
  associatedMatte: { matteId: string; engine: string; contentHash: string; bytes: Buffer } | null;
  /** Set when the pre-matte candidate pixels are not retained — stated, never invented. */
  predecessorCandidateNote: string | null;
}

export interface ReviewOptions {
  /**
   * Fault-injection seam for sheet publication: when set, the write goes
   * through here. Production always performs the real atomic replace.
   */
  replaceArtifact?: (file: string, bytes: Buffer) => Promise<void>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const DISCLAIMER =
  "review evidence only — nothing here implies likeness approval or cutout promotion; " +
  "approval and publishing belong to the caller's own workflow (ADR-0014)";

/**
 * Read one Reference from its recorded caller path and verify its bytes
 * against the identity recorded at Job creation. The review fails (never
 * displays) a missing or changed Reference in published-evidence review:
 * the caller's likeness comparison would be against a Reference the job was
 * not generated with — exactly the substitution the record exists to prevent.
 */
async function readVerifiedReference(pathAsWritten: string, contentHash: string, label: string): Promise<Buffer> {
  const resolved = path.resolve(pathAsWritten);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw new Error(
      `Reference "${resolved}" (${label}) is missing — the review needs every Reference the job was generated with`,
    );
  }
  const actual = sha256(bytes);
  if (actual !== contentHash) {
    throw new Error(
      `Reference "${resolved}" (${label}) changed content identity — recorded sha-256 ${contentHash}, actual ${actual}. ` +
        `The review would compare against a Reference the job was not generated with.`,
    );
  }
  return bytes;
}

/**
 * The retained-review counterpart: attempt the same verification but report
 * unavailability instead of failing the review — a relocated Project retains
 * Reference identities, not caller Reference bytes, and the sheet must stay
 * usable for the candidate and matte it does hold. Unverified bytes are never
 * displayed: the label carries the recorded identity so the caller knows the
 * comparison is not possible, not silently skipped.
 */
async function attemptRetainedReference(pathAsWritten: string, contentHash: string, label: string): Promise<EvidenceReference> {
  const resolved = path.resolve(pathAsWritten);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (err) {
    return {
      label,
      path: pathAsWritten,
      contentHash,
      bytes: null,
      unavailable: `file is missing or unreadable (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
    };
  }
  const actual = sha256(bytes);
  if (actual !== contentHash) {
    return {
      label,
      path: pathAsWritten,
      contentHash,
      bytes: null,
      unavailable: `content changed — recorded ${contentHash.slice(0, 12)}, actual ${actual.slice(0, 12)}; never substituted`,
    };
  }
  return { label, path: pathAsWritten, contentHash, bytes, unavailable: null };
}

/**
 * Read one retained content blob and re-hash it to its content identity —
 * the Project's readers never trust stored bytes blindly, and neither does
 * the review that displays them.
 */
async function readRetainedContentBlob(resolvedProjectRoot: string, contentHash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error(`Retained content identity "${contentHash.slice(0, 12)}" is not a sha-256 hash — refusing to read`);
  }
  const blob = path.join(resolvedProjectRoot, "content", contentHash);
  if (outsideDir(resolvedProjectRoot, blob)) {
    throw new Error(`Security error: retained content path escapes project boundary.`);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(blob);
  } catch {
    throw new Error(`Retained content ${contentHash.slice(0, 12)} is missing — the Project's content store is incomplete`);
  }
  const actual = sha256(bytes);
  if (actual !== contentHash) {
    throw new Error(
      `Retained content ${contentHash.slice(0, 12)} does not match its content identity (actual ${actual.slice(0, 12)}) — the Project's content store is corrupted`,
    );
  }
  return bytes;
}

/**
 * Review one published Generation Job's external evidence and write the
 * self-contained sheet beside the record (`<jobDir>/review.html`, like the
 * legacy review). Pure local reads — offline by construction.
 */
export async function reviewPublishedGeneration(
  jobRoot: string,
  matteRoot: string,
  jobId: string,
  opts: ReviewOptions = {},
): Promise<PublishedGenerationReview> {
  // Every output is read and hash-verified first — a missing or corrupt
  // output fails the whole review instead of displaying partial evidence.
  const { job, outputs } = await loadVerifiedGenerationOutputs(jobRoot, jobId);

  // References, in caller order, verified against their recorded identities.
  const references: PublishedGenerationReview["references"] = [];
  const refEvidence = [];
  const recordedRefs = job.request.references ?? [];
  for (let i = 0; i < recordedRefs.length; i++) {
    const ref = recordedRefs[i]!;
    const label = `ref ${i + 1}`;
    const bytes = await readVerifiedReference(ref.path, ref.contentHash, label);
    refEvidence.push({ label, path: ref.path, contentHash: ref.contentHash, bytes, unavailable: null });
    references.push({ label, path: ref.path, contentHash: ref.contentHash, bytes });
  }

  // The associated matte per output, found by the derived source-identity
  // linkage and verified before display; ambiguous lineage fails closed.
  const reviewedOutputs: PublishedGenerationReviewOutput[] = [];
  const mattes: EvidenceMatte[] = [];
  for (let i = 0; i < outputs.length; i++) {
    const { output, bytes } = outputs[i]!;
    const label = outputs.length > 1 ? `output ${i + 1}` : "candidate";
    let matte: PublishedGenerationReviewOutput["matte"] = null;
    let matteEvidence: EvidenceMatte;
    const found = await findMatteForSource(matteRoot, output.contentHash);
    if (found) {
      const selected = await selectMatteOutput(matteRoot, found.matte.matteId);
      matte = {
        matteId: found.matte.matteId,
        engine: found.matte.result.engine,
        contentHash: selected.output.contentHash,
        file: selected.output.file,
        bytes: selected.bytes,
      };
      matteEvidence = {
        forLabel: label,
        present: true,
        bytes: selected.bytes,
        matteId: found.matte.matteId,
        engine: found.matte.result.engine,
        alpha: found.matte.result.alpha,
      };
    } else {
      matteEvidence = { forLabel: label, present: false, bytes: null };
    }
    mattes.push(matteEvidence);
    reviewedOutputs.push({ contentHash: output.contentHash, file: output.file, mediaType: output.mediaType, bytes, matte });
  }

  const sheet = renderEvidenceSheet({
    title: `generation evidence · ${job.jobId}`,
    subtitle: `${job.request.intent} · ${job.run.model} · prompt: ${job.request.prompt}`,
    facts: factsForJob(job),
    references: refEvidence,
    candidates: reviewedOutputs.map((o, i) => ({
      label: outputs.length > 1 ? `output ${i + 1}` : "candidate",
      contentHash: o.contentHash,
      bytes: o.bytes,
    })),
    mattes,
  });
  const reviewPath = path.join(jobRoot, jobId, "review.html");
  await (opts.replaceArtifact ?? atomicReplace)(reviewPath, Buffer.from(sheet));
  return { jobId: job.jobId, reviewPath, references, outputs: reviewedOutputs };
}

/** Record facts rows for a Generation Job sheet. */
function factsForJob(job: GenerationJobRecord): [string, string][] {
  const rows: [string, string][] = [
    ["job", job.jobId],
    ["created", job.createdAt],
    ["prompt", job.request.prompt],
    ["intent", job.request.intent],
    ["model", job.run.model],
    ["effective prompt", job.run.fullPrompt],
    ["outputs", job.run.outputs.map((o) => `${o.file} (${o.contentHash.slice(0, 12)})`).join(", ")],
  ];
  (job.request.references ?? []).forEach((r, i) => rows.push([`ref ${i + 1}`, `${r.path} (${r.contentHash.slice(0, 12)})`]));
  for (const w of job.run.warnings) rows.push(["warning", w]);
  return rows;
}

/**
 * Review one Project Layer's retained evidence and write the self-contained
 * sheet to `outPath`. Everything resolves through the canonical retained
 * readers under the Project lock: ambiguity and unreadable records fail
 * closed (exit 1), the Layer's bytes are re-verified by resolution, and a
 * current revision no generation or matte claims is refused clearly — a
 * review never reaches for substitute evidence.
 */
export async function reviewRetainedLayer(
  projectPath: string,
  layerId: string,
  outPath: string,
  opts: ReviewOptions = {},
): Promise<RetainedLayerReview> {
  const resolvedRoot = await resolveProjectRoot(projectPath);
  // The destination guard runs before any evidence resolution: reserved
  // Project storage and alias paths into it are refused before any read.
  const dest = await guardProjectDestination(resolvedRoot, outPath);
  const review = await withProjectLock(resolvedRoot, async () => {
    const full = await readLayerInternalFull(resolvedRoot, layerId);
    const layer: ResolvedLayer = {
      id: full.id,
      createdAt: full.createdAt,
      currentRevisionId: full.currentRevisionId,
      currentRevision: full.currentRevision,
    };
    const rev = layer.currentRevision;
    if (rev.kind !== "image") {
      throw new Error(`Layer "${layerId}" is a text Layer — no Generation Job or matte claims text content, so there is no evidence to review`);
    }
    const contentHash = rev.contentHash;

    // The one canonical lineage resolution: ambiguity or unreadable retained
    // records fail closed here rather than report possibly wrong provenance.
    const matting: RetainedMattingProvenance | null = await resolveRetainedMattingProvenance(resolvedRoot, contentHash);
    const generation: RetainedProvenance | null = await resolveRetainedProvenance(resolvedRoot, contentHash);
    if (!matting && !generation) {
      throw new Error(
        `Layer "${layerId}" current revision (${contentHash.slice(0, 12)}) is not generated or matted content — ` +
          `no retained Generation Job or matte claims these bytes, so there is no evidence to review`,
      );
    }
    let predecessor: RetainedProvenance | null = null;
    if (matting) {
      predecessor = await resolveRetainedProvenance(resolvedRoot, matting.matte.request.source.contentHash);
    }

    // References come from the one job record that produced (or preceded)
    // these bytes; retained review labels unavailable paths instead of
    // failing, because Reference bytes are caller-owned and never retained.
    const jobRecord = generation?.job ?? predecessor?.job ?? null;
    const references: EvidenceReference[] = [];
    if (jobRecord) {
      const recorded = jobRecord.request.references ?? [];
      for (let i = 0; i < recorded.length; i++) {
        references.push(await attemptRetainedReference(recorded[i]!.path, recorded[i]!.contentHash, `ref ${i + 1}`));
      }
    }

    // A generated (unmatted) candidate's associated matte: found by the same
    // derived source-identity linkage over the retained matte records, its
    // output pixels retained with the matted Layer's ingestion.
    let associatedMatte: RetainedLayerReview["associatedMatte"] = null;
    if (!matting && generation) {
      const found = await findMatteForSource(path.join(resolvedRoot, RETAINED_MATTING_DIR), contentHash);
      if (found) {
        const output = found.matte.result.outputs[0]!;
        const bytes = await readRetainedContentBlob(resolvedRoot, output.contentHash);
        associatedMatte = { matteId: found.matte.matteId, engine: found.matte.result.engine, contentHash: output.contentHash, bytes };
      }
    }

    // The pre-matte candidate pixels of a matted generated Layer were never
    // retained — stated on the sheet, never invented.
    const predecessorCandidateNote =
      matting && predecessor
        ? `The generated source (job ${predecessor.jobId}, output ${predecessor.output.contentHash.slice(0, 12)}) ` +
          `is retained as its recorded identity only — pre-matte pixels are not Project state and are never invented here.`
        : null;

    return {
      layerId: layer.id,
      candidate: { label: "candidate", contentHash, bytes: full.contentBytes },
      references,
      // The job whose output IS these bytes, or — for a matted generated
      // Layer — the predecessor job the matte's source came from; the
      // request facts keep their one home in that record.
      generation: (generation ?? predecessor)
        ? {
            jobId: (generation ?? predecessor)!.jobId,
            output: {
              contentHash: (generation ?? predecessor)!.output.contentHash,
              file: (generation ?? predecessor)!.output.file,
            },
          }
        : null,
      matting: matting ? { matteId: matting.matteId, engine: matting.matte.result.engine, alpha: matting.matte.result.alpha } : null,
      associatedMatte,
      predecessorCandidateNote,
      mattingRecord: matting?.matte ?? null,
      jobRecord,
    };
  });

  const facts: [string, string][] = [
    ["layer", review.layerId],
    ["current revision", review.candidate.contentHash.slice(0, 16)],
    ["content identity", review.candidate.contentHash],
  ];
  if (review.generation) facts.push(["generated by", `${review.generation.jobId} (output ${review.generation.output.contentHash.slice(0, 12)})`]);
  if (review.matting) {
    facts.push(["matted by", `${review.matting.matteId} (engine ${review.matting.engine})`]);
    facts.push([
      "alpha report",
      `${review.matting.alpha.width}×${review.matting.alpha.height} · ${review.matting.alpha.transparentPx} transparent / ${review.matting.alpha.opaquePx} opaque px`,
    ]);
  }
  if (review.jobRecord) facts.push(["prompt", review.jobRecord.request.prompt]);
  for (const w of review.mattingRecord?.result.warnings ?? []) facts.push(["warning", w]);
  if (review.predecessorCandidateNote) facts.push(["generated source", review.predecessorCandidateNote]);

  const candidates = [{ label: "candidate", contentHash: review.candidate.contentHash, bytes: review.candidate.bytes }];
  const mattes: EvidenceMatte[] = [];
  if (review.matting) {
    // A matted Layer's bytes ARE the matte output — shown on the
    // checkerboard with the recorded engine and alpha report.
    mattes.push({
      forLabel: "candidate",
      present: true,
      bytes: review.candidate.bytes,
      matteId: review.matting.matteId,
      engine: review.matting.engine,
      alpha: review.matting.alpha,
    });
  } else if (review.associatedMatte) {
    mattes.push({
      forLabel: "candidate",
      present: true,
      bytes: review.associatedMatte.bytes,
      matteId: review.associatedMatte.matteId,
      engine: review.associatedMatte.engine,
    });
  } else {
    mattes.push({ forLabel: "candidate", present: false, bytes: null });
  }

  const sheet = renderEvidenceSheet({
    title: `layer evidence · ${review.layerId}`,
    subtitle: review.predecessorCandidateNote ?? undefined,
    facts,
    references: review.references,
    candidates,
    mattes,
  });
  await publishSheet(dest, Buffer.from(sheet), outPath, opts);
  return {
    layerId: review.layerId,
    // The caller-chosen destination path verbatim; realpaths are containment
    // guards only (the render --out reporting rule).
    reviewPath: dest.target,
    candidate: review.candidate,
    references: review.references,
    generation: review.generation,
    matting: review.matting,
    associatedMatte: review.associatedMatte,
    predecessorCandidateNote: review.predecessorCandidateNote,
  };
}

/**
 * Destination policy for the retained review sheet (docs/project-storage-contract.md
 * §6): reserved Project storage is protected state — a review sheet is derived
 * evidence and must never be publishable over the manifest, the lock, or any
 * canonical directory — and existing in-Project files are never overwritten.
 * A fresh non-reserved path inside the Project is fine (like render exports).
 *
 * Containment is judged on PHYSICAL paths: the Project root and the existing
 * destination parent are realpath-resolved first, so an external directory
 * symlink that resolves into the Project is classified by where the write
 * actually lands, not by its lexical shape — the alias cannot bypass the
 * reserved-storage guard (PROD-1). Fresh in-Project destinations publish with
 * atomic no-replace (O_EXCL), so even a writer racing the same path loses
 * loudly instead of being silently replaced.
 */
const RESERVED_PROJECT_STORAGE = new Set([
  "compositions",
  "layers",
  "content",
  "renders",
  "generation",
  "matting",
]);

interface ResolvedDestination {
  /** The lexical destination path — the external overwrite case's target. */
  target: string;
  /** Where an in-Project write physically lands (realpath'd parent + name). */
  landedPath: string;
  inProject: boolean;
}

async function resolveReviewDestination(resolvedProjectRoot: string, outPath: string): Promise<ResolvedDestination> {
  const target = path.resolve(outPath);
  const parent = path.dirname(target);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    throw new Error(`Review destination "${outPath}" has no existing parent directory — create it first`);
  }
  if (!parentStat.isDirectory()) {
    throw new Error(`Review destination "${outPath}" parent is not a directory`);
  }
  // The parent exists, so its realpath is authoritative for where a rename
  // or create lands; a dangling alias already failed the stat above.
  const parentReal = await realpath(parent);
  const inProject = !outsideDir(await realpath(resolvedProjectRoot), parentReal);
  return { target, landedPath: path.join(parentReal, path.basename(target)), inProject };
}

async function guardProjectDestination(resolvedProjectRoot: string, outPath: string): Promise<ResolvedDestination> {
  const dest = await resolveReviewDestination(resolvedProjectRoot, outPath);
  if (!dest.inProject) return dest; // outside the Project: the documented overwrite case
  const rel = path.relative(await realpath(resolvedProjectRoot), dest.landedPath);
  const top = rel.split(path.sep)[0]!;
  if (rel === "ply.json" || rel === ".ply.lock" || RESERVED_PROJECT_STORAGE.has(top)) {
    throw new Error(
      `Review destination "${outPath}" is inside the Project's reserved storage — choose a path outside it (reserved Project state is never overwritten)`,
    );
  }
  return dest;
}

/**
 * Publish the resolved destination: fresh in-Project paths with atomic
 * no-replace (an existing file — including one created concurrently after
 * the guard — makes the publication fail loudly; in-Project state is never
 * overwritten), external destinations with the documented atomic replace.
 */
async function publishSheet(dest: ResolvedDestination, bytes: Buffer, outPath: string, opts: ReviewOptions): Promise<void> {
  if (!dest.inProject) {
    await (opts.replaceArtifact ?? atomicReplace)(dest.target, bytes);
    return;
  }
  try {
    await atomicCreate(dest.landedPath, bytes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Review destination "${outPath}" already exists inside the Project — choose a fresh path (in-Project state is never overwritten)`,
      );
    }
    throw err;
  }
}

/**
 * The one evidence-sheet renderer: verified bytes in, self-contained HTML
 * out. Full-size views are true 1:1 in a scrollable container; the row view
 * is exactly 168px, the size that decides legibility; the detail section
 * applies one fixed crop to every image so views are directly comparable (a
 * fixed region, not face detection); matte evidence shows through a
 * checkerboard. Every image is a data URL of hash-verified bytes and the CSP
 * forbids everything else.
 */
function renderEvidenceSheet(input: EvidenceSheetInput): string {
  const referenceFigures = input.references
    .map((ref) => {
      const caption = `${escapeHtml(ref.label)} · ${escapeHtml(ref.path)} · ${escapeHtml(ref.contentHash.slice(0, 12))}`;
      if (ref.bytes) {
        return `<figure><div class="refwrap"><img class="ref" src="${escapeHtml(dataUrl(ref.bytes))}"></div><figcaption>${caption}</figcaption></figure>`;
      }
      const reason = escapeHtml(ref.unavailable ?? "unavailable");
      return `<figure><div class="empty"></div><figcaption>${caption} · pixels unavailable (${reason}) — never substituted</figcaption></figure>`;
    })
    .join("\n");

  const candidateFull = input.candidates
    .map(
      ({ label, contentHash, bytes }) =>
        `<figure><div class="fullwrap"><img class="full" src="${escapeHtml(dataUrl(bytes))}"></div><figcaption>${escapeHtml(label)} · ${escapeHtml(contentHash.slice(0, 12))} · full size</figcaption></figure>`,
    )
    .join("\n");
  const candidateThumb = input.candidates
    .map(
      ({ label, contentHash, bytes }) =>
        `<figure><img class="thumb" src="${escapeHtml(dataUrl(bytes))}"><figcaption>${escapeHtml(label)} · ${escapeHtml(contentHash.slice(0, 12))} · 168px</figcaption></figure>`,
    )
    .join("\n");

  // One fixed crop geometry for every displayed image — references and
  // candidates are directly comparable. A fixed region, not face detection.
  const detail = (bytes: Buffer, caption: string) =>
    `<figure><div class="face"><img src="${escapeHtml(dataUrl(bytes))}" style="width:200%;left:-50%;top:-32%"></div><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  const detailFigures = [
    ...input.references.filter((r) => r.bytes).map((r) => detail(r.bytes!, `${r.label} detail`)),
    ...input.candidates.map((c) => detail(c.bytes, `${c.label} detail`)),
  ].join("\n");

  const matteFigures = input.mattes
    .map((m) => {
      const who = escapeHtml(m.forLabel);
      if (m.present && m.bytes) {
        const alpha = m.alpha
          ? ` · ${m.alpha.width}×${m.alpha.height} · ${m.alpha.transparentPx} transparent / ${m.alpha.opaquePx} opaque px`
          : "";
        return `<figure><div class="fullwrap"><img class="matte" src="${escapeHtml(dataUrl(m.bytes))}"></div><figcaption>${who} · matte ${escapeHtml(m.matteId ?? "")} via ${escapeHtml(m.engine ?? "unknown")}${alpha}</figcaption></figure>`;
      }
      return `<figure><div class="empty"></div><figcaption>${who} · no matte — reviewed as generated</figcaption></figure>`;
    })
    .join("\n");

  const facts = input.facts
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
    .join("\n");

  const reviewedAt = new Date().toISOString();
  const subtitle = input.subtitle
    ? `<p class="meta">${escapeHtml(input.subtitle).replaceAll("\n", "<br>")}</p>`
    : "";

  return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(input.title)}</title>
<style>
body{background:#0b0b0d;color:#e7e7ea;font:14px/1.5 -apple-system,sans-serif;margin:0;padding:32px}
h1,h2{font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#8a8a94;margin:24px 0}
h1{font-size:15px}h2{font-size:12px}
.meta{color:#8a8a94;font-size:12px;margin:0 0 8px}
table{border-collapse:collapse;margin:16px 0;max-width:900px}
th,td{text-align:left;font-size:12px;padding:4px 14px 4px 0;vertical-align:top}
th{color:#8a8a94;font-family:ui-monospace,monospace;font-weight:400;white-space:nowrap}
td{font-family:ui-monospace,monospace;overflow-wrap:anywhere}
.g{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.gfull{display:grid;gap:24px}
figure{margin:0;background:linear-gradient(160deg,#16181d,#0e1013);border:1px solid #26282e;border-radius:8px;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
figcaption{font-size:11px;color:#8a8a94;font-family:ui-monospace,monospace;text-align:center}
.fullwrap,.refwrap{width:100%;overflow-x:auto;border-radius:4px}
img.full,img.ref,img.matte{display:block;width:auto;max-width:none;height:auto;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
img.thumb{display:block;width:168px;height:auto;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.empty{width:168px;height:168px;border-radius:4px;
  background:repeating-conic-gradient(#1c1e24 0% 25%, #121419 0% 50%) 50%/24px 24px}
.face{position:relative;width:160px;aspect-ratio:1;overflow:hidden;border-radius:4px}
.face img{position:absolute;max-width:none;display:block}
</style>
<h1>${escapeHtml(input.title)}</h1>
<p class="meta">reviewed ${escapeHtml(reviewedAt)} · ${escapeHtml(DISCLAIMER)}</p>
${subtitle}
<h2>record facts</h2>
<table>${facts}</table>
<h2>references — the exact ordered inputs, verified against recorded identities</h2>
<div class="gfull">${referenceFigures || "<p>no References were attached to this request</p>"}</div>
<h2>candidates — full view, as published</h2>
<div class="gfull">${candidateFull}</div>
<h2>candidates — 168px (intended display size)</h2>
<div class="g">${candidateThumb}</div>
<h2>matte — what isolation produced (checkerboard shows the alpha)</h2>
<div class="gfull">${matteFigures}</div>
<h2>detail — one fixed crop for every image (a fixed region, not face detection)</h2>
<div class="g">${detailFigures || "<p>no images</p>"}</div>
</body>`;
}
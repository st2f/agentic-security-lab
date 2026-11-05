import type { Candidate, Evidence } from "./contracts.ts";

/** Shared reference rules; callers own observations and filesystem revalidation. */
export function candidateReferences(candidates: Candidate[]): Evidence[] {
  return candidates.flatMap((candidate) => [
    ...candidate.supportingEvidence,
    ...candidate.contradictoryEvidence.map((entry) => entry.reference),
  ]);
}

export function isValidEvidenceRange(
  reference: Evidence,
  snapshotId: string,
): boolean {
  return (
    reference.snapshotId === snapshotId &&
    reference.endLine >= reference.startLine &&
    reference.endLine - reference.startLine < 200
  );
}

/** Listings supply no source lines, so they cannot satisfy an evidence reference. */
export function hasEvidenceLines(
  reference: Evidence,
  lines: ReadonlySet<number> | ReadonlyMap<number, string>,
): boolean {
  for (let line = reference.startLine; line <= reference.endLine; line++) {
    if (!lines.has(line)) return false;
  }
  return true;
}

export function evidenceKey(reference: Evidence): string {
  return JSON.stringify([
    reference.snapshotId,
    reference.toolCallId,
    reference.path,
    reference.startLine,
    reference.endLine,
  ]);
}

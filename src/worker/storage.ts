// Quarantined public reports live under a prefix with no retention lock, so an admin can destroy unlawful
// content. Accepted evidence is moved under prefixes covered by R2 bucket lock rules (see docs/deploy.md).

export const QUARANTINE_PREFIX = "quarantena/";

export function storageKeys(reportId: string, accepted: boolean) {
  const q = accepted ? "" : `${QUARANTINE_PREFIX}${reportId}/`;
  return {
    manifest: accepted ? `manifests/${reportId}.json` : `${q}manifest.json`,
    original: (idx: number, sha: string, ext: string) => (accepted ? `originals/${reportId}/` : q) + `${idx + 1}-${sha}.${ext}`,
    derived: (idx: number) => (accepted ? `derived/${reportId}/` : q) + `${idx + 1}-gps.jpg`,
  };
}

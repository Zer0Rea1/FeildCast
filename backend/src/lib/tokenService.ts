import crypto from 'crypto';

// Generates a unique SRT streamid for each reporter in each conference
// Format: fc-{conferenceShortId}-{reporterShortName}-{random}
// e.g. "fc-abc123-ahmed-a1b2c3d4"
// Only [a-z0-9-] may appear in a slug segment — this value is later used as
// a filesystem path segment (HLS output dir) and embedded in an SRT URI
// query string, so anything else (e.g. "../", "&", "|") must never survive.
function toSlug(value: string, maxLen: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'x';
}

export function generateStreamId(conferenceId: string, reporterName: string): string {
  const confSlug = toSlug(conferenceId, 6);
  const nameSlug = toSlug(reporterName, 12);
  const rand = crypto.randomBytes(4).toString('hex');
  return `fc-${confSlug}-${nameSlug}-${rand}`;
}

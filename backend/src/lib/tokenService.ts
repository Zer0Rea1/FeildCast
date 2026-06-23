import crypto from 'crypto';

// Generates a unique SRT streamid for each reporter in each conference
// Format: fc-{conferenceShortId}-{reporterShortName}-{random}
// e.g. "fc-abc123-ahmed-a1b2c3d4"
export function generateStreamId(conferenceId: string, reporterName: string): string {
  const confSlug = conferenceId.slice(0, 6);
  const nameSlug = reporterName.toLowerCase().replace(/\s+/g, '-').slice(0, 12);
  const rand = crypto.randomBytes(4).toString('hex');
  return `fc-${confSlug}-${nameSlug}-${rand}`;
}

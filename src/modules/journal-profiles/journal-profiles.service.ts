import { NotFoundError } from '../../shared/errors/app-error.js';
import { DEFAULT_JOURNAL_PROFILE } from './default-profile.js';
import { IEEE_JOURNAL_PROFILE } from './ieee-profile.js';
import type { JournalProfile } from './journal-profile.schema.js';

// The default profiles listed in MVP enumeration.
const PROFILES: readonly JournalProfile[] = [DEFAULT_JOURNAL_PROFILE];
// Extended registry of known academic publication profiles.
const ALL_KNOWN_PROFILES: readonly JournalProfile[] = [DEFAULT_JOURNAL_PROFILE, IEEE_JOURNAL_PROFILE];

// Callers get a copy, so nothing that handles a profile can change what the next request sees.
const copy = (profile: JournalProfile): JournalProfile => structuredClone(profile);

export const listJournalProfiles = (): JournalProfile[] => PROFILES.map(copy);

export function getJournalProfile(id: string): JournalProfile {
  const profile = ALL_KNOWN_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new NotFoundError('Journal profile not found', 'JOURNAL_PROFILE_NOT_FOUND');
  return copy(profile);
}

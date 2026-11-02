import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { guardIdParam } from '../../middleware/param-guard.middleware.js';
import { getJournalProfile, listJournalProfiles } from './journal-profiles.service.js';

/** Mounted at `/journal-profiles`. The profiles are the same for everyone, but only signed-in users may read them. */
const router = Router();
router.use(requireAuth);
router.param('profileId', guardIdParam('Journal profile not found', 'JOURNAL_PROFILE_NOT_FOUND'));

router.get('/', (_req, res, next) => {
  try {
    return res.json({ success: true, data: listJournalProfiles() });
  } catch (error) { return next(error); }
});

router.get('/:profileId', (req, res, next) => {
  try {
    return res.json({ success: true, data: getJournalProfile(req.params.profileId) });
  } catch (error) { return next(error); }
});

export default router;

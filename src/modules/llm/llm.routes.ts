import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { getLlmStatus } from './llm.service.js';

/**
 * Mounted at `/llm`. There is deliberately no route that sends text to the model: every call to it is made by a step of
 * the writing workflow, on a snapshot, for a project the caller owns. A route that took free text would let any signed-in
 * user spend the key.
 */
const router = Router();
router.use(requireAuth);

router.get('/status', (_req, res, next) => {
  try {
    return res.json({ success: true, data: getLlmStatus() });
  } catch (error) { return next(error); }
});

export default router;

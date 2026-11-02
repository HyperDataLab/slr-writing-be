import { Router } from 'express';
import healthRoutes from './modules/health/health.routes.js';
import journalProfilesRoutes from './modules/journal-profiles/journal-profiles.routes.js';
import llmRoutes from './modules/llm/llm.routes.js';
import projectsRoutes from './modules/projects/projects.routes.js';

const router = Router();

router.use('/health', healthRoutes);
router.use('/journal-profiles', journalProfilesRoutes);
router.use('/llm', llmRoutes);
router.use('/projects', projectsRoutes);

export default router;

import { Router } from 'express';
import { SlrClient } from '../slr-client/slr-client.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', service: 'slr-writing-be', uptimeSeconds: Math.round(process.uptime()) } });
});

router.get('/slr', async (_req, res) => {
  const status = await new SlrClient().checkHealth();
  res.json({ success: true, data: status });
});

export default router;

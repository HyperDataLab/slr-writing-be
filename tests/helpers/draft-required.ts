import request from 'supertest';
import type { Express } from 'express';

/**
 * Generates Methods and drafts every section the engine can draft (Results plus any other section with a READY plan),
 * optionally recording the H2 approval for each. Mirrors the sections that verification and H3 now require.
 */
export async function draftRequiredSections(
  app: Express,
  headers: Record<string, string>,
  projectId: string,
  snapshotId: string,
  options: { approve: boolean; /** Also write and approve Abstract and Conclusion (default true when approving). */ synthesis?: boolean },
): Promise<string[]> {
  const base = `/api/projects/${projectId}/snapshots/${snapshotId}/manuscript`;

  await request(app).post(`${base}/methods`).set(headers).send({});

  const plans = await request(app).get(`${base}/paragraph-plans`).set(headers);
  const content = plans.body?.data?.revision?.content as { plans: Array<{ sectionKey: string; status: string }> } | undefined;
  const drafted = new Set<string>(['results']);
  for (const plan of content?.plans ?? []) if (plan.status === 'READY_TO_DRAFT') drafted.add(plan.sectionKey);
  drafted.delete('methods');

  for (const key of drafted) await request(app).post(`${base}/sections/${key}/draft`).set(headers).send({});

  const keys = ['methods', ...drafted];
  if (options.approve) {
    for (const key of keys) await request(app).post(`${base}/sections/${key}/approve`).set(headers).send({ version: 1 });
    // Abstract and Conclusion are written last, from the sections just approved (the test's model mock must answer them).
    for (const key of options.synthesis === false ? [] : ['abstract', 'conclusion']) {
      await request(app).post(`${base}/sections/${key}/draft`).set(headers).send({});
      await request(app).post(`${base}/sections/${key}/approve`).set(headers).send({ version: 1 });
      keys.push(key);
    }
  }
  return keys;
}

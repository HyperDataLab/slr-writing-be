import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/prisma.js';
import { createBlueprint, decideBlueprint } from '../../src/modules/blueprint/blueprint.service.js';
import { generateMethods } from '../../src/modules/methods/methods.service.js';
import { importSnapshot } from '../../src/modules/snapshots/snapshot-import.service.js';

// QA: connection-pool behaviour of the H1 decision. decideBlueprint holds a transaction connection and, for an approval,
// loads the snapshot through the global client (a second connection). With the pg pool (10) this can starve. Needs PostgreSQL.
const tag = `qa-bpp-${Date.now()}`;
const alice = `${tag}-alice`;
let counter = 0;
const real = () => JSON.parse(readFileSync(new URL('../fixtures/real/slr-be-demo-run.json', import.meta.url), 'utf8'));
afterAll(() => prisma.$disconnect());

async function setup() {
  const slrProjectId = `${tag}-slr-${counter++}`;
  const project = await prisma.project.create({ data: { name: slrProjectId, ownerId: alice, slrProjectId } });
  const raw = real();
  raw.run.project_id = slrProjectId; raw.corpus.project_id = slrProjectId; raw.supplements.prisma_writing_export.project.id = slrProjectId;
  const { snapshot } = await importSnapshot({ projectId: project.id, importedBy: alice, input: raw, source: 'slr-be' });
  return { project, snapshot };
}
const errorText = (e: unknown) => (e instanceof Error ? `${e.constructor.name} ${(e as any).code ?? ""}: ${e.message.split(String.fromCharCode(10)).filter(Boolean).slice(-2).join(" | ").slice(0, 300)}` : String(e));

describe('connection pool', () => {
  it('10 approvals of 10 different snapshots at once all succeed quickly (no pool starvation)', async () => {
    const all = await Promise.all(Array.from({ length: 10 }, async () => { const s = await setup(); await createBlueprint({ projectId: s.project.id, snapshotId: s.snapshot.id, actor: alice }); return s; }));
    const start = Date.now();
    const pending = Promise.allSettled(all.map((s) => decideBlueprint({
      projectId: s.project.id, snapshotId: s.snapshot.id, slrProjectId: 'x', authorization: undefined, actor: alice, version: 1, decision: 'APPROVED', note: null,
    })));
    // An unrelated query fired 500 ms into the burst: does the whole process stall?
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probeStart = Date.now();
    await prisma.project.findFirst({ where: { ownerId: 'nobody' } });
    console.log(`[qa] pool: unrelated query during the burst took ${Date.now() - probeStart}ms`);
    const settled = await pending;
    const ms = Date.now() - start;
    const errors = settled.filter((r) => r.status === 'rejected').map((r) => errorText((r as PromiseRejectedResult).reason));
    console.log(`[qa] pool: 10 approvals on 10 snapshots took ${ms}ms, errors=${JSON.stringify([...new Set(errors)])}`);
    expect(errors).toEqual([]);
    expect(ms).toBeLessThan(10_000);
  }, 180_000);

  it('20 approvals of one snapshot: errors are reported (diagnostic)', async () => {
    const s = await setup();
    await createBlueprint({ projectId: s.project.id, snapshotId: s.snapshot.id, actor: alice });
    const start = Date.now();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => decideBlueprint({
      projectId: s.project.id, snapshotId: s.snapshot.id, slrProjectId: 'x', authorization: undefined, actor: alice, version: 1, decision: 'APPROVED', note: null,
    })));
    const errors = settled.filter((r) => r.status === 'rejected').map((r) => errorText((r as PromiseRejectedResult).reason));
    console.log(`[qa] pool: 20 approvals on one snapshot took ${Date.now() - start}ms, errors=${JSON.stringify([...new Set(errors)])}`);
    expect(errors).toEqual([]);
  }, 180_000);

  it('methods and blueprint creating the manuscript at once: errors are reported (diagnostic)', async () => {
    const s = await setup();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2
      ? generateMethods({ projectId: s.project.id, snapshotId: s.snapshot.id, actor: alice } as any)
      : createBlueprint({ projectId: s.project.id, snapshotId: s.snapshot.id, actor: alice }))));
    const errors = settled.filter((r) => r.status === 'rejected').map((r) => errorText((r as PromiseRejectedResult).reason));
    console.log(`[qa] race methods+blueprint errors=${JSON.stringify([...new Set(errors)])}`);
    expect(errors).toEqual([]);
  }, 180_000);
});

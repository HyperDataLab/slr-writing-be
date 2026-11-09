// Step 1 of 2. Integration check: writing BE (5121, Firebase mode, owner checks ON) against the real, latest slr-be (5000) + Firestore emulator.
const SLR = "http://127.0.0.1:5000/api", W = "http://127.0.0.1:5121/api", AUTH = "http://127.0.0.1:9099";
const SLR_PROJECT = "proj_slr_artifacts_rich";

async function signIn(email) {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Demo@12345", returnSecureToken: true }),
  });
  const j = await r.json();
  if (!j.idToken) throw new Error("sign-in failed for " + email + ": " + JSON.stringify(j).slice(0, 200));
  return j.idToken;
}
async function call(label, base, method, path, token, body, show = true) {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (show) console.log(label.padEnd(46), r.status, j?.success === false ? j.error?.code ?? j.message : "ok");
  return { status: r.status, body: j, data: j?.data };
}

const leader = await signIn("leader@slr.local");
const reviewer = await signIn("reviewer1@slr.local");
const outsider = await signIn("outsider@example.com");

console.log("=== A. slr-be itself with Firebase tokens");
await call("leader reads SLR project", SLR, "GET", `/projects/${SLR_PROJECT}`, leader);
await call("reviewer (member) reads SLR project", SLR, "GET", `/projects/${SLR_PROJECT}`, reviewer);
await call("outsider reads SLR project", SLR, "GET", `/projects/${SLR_PROJECT}`, outsider);
const runs = await call("list runs", SLR, "GET", `/projects/${SLR_PROJECT}/synthesis/artifacts/runs`, leader, null, false);
const runList = runs.data ?? runs.body;
const run = (Array.isArray(runList) ? runList : [])[0];
console.log("runs:", Array.isArray(runList) ? runList.length : "?", "latest:", run?.run_id, "artifacts:", run?.artifacts?.map((a) => `${a.artifact_type}:${a.review_status}`).join(" "));
const RUN = run.run_id;
await call("reviewer tries to approve A1 (must fail)", SLR, "POST", `/projects/${SLR_PROJECT}/synthesis/artifacts/runs/${RUN}/artifacts/A1/review`, reviewer, { decision: "APPROVED" });
for (const t of ["A1", "A2", "A7", "A10"]) await call(`leader approves ${t}`, SLR, "POST", `/projects/${SLR_PROJECT}/synthesis/artifacts/runs/${RUN}/artifacts/${t}/review`, leader, { decision: "APPROVED" });

console.log("\n=== B. writing BE: linking and roles");
await call("outsider links the SLR project (must fail)", W, "POST", "/projects", outsider, { name: "Outsider", slrProjectId: SLR_PROJECT });
const lp = await call("leader links the SLR project", W, "POST", "/projects", leader, { name: "Leader project", slrProjectId: SLR_PROJECT });
const rp = await call("reviewer links the SLR project", W, "POST", "/projects", reviewer, { name: "Reviewer project", slrProjectId: SLR_PROJECT });
const LP = lp.data.id, RP = rp.data.id;
const list = await call("leader lists SLR runs for the picker", W, "GET", `/projects/${LP}/slr-runs`, leader, null, false);
console.log("picker rows:", list.status, JSON.stringify(list.data?.map((r) => ({ id: r.runId, importable: r.importable, complete: r.complete, A: r.mvpArtifacts }))));

console.log("\n=== C. import the real run");
const imp = await call("leader imports run (from-slr)", W, "POST", `/projects/${LP}/snapshots/from-slr`, leader, { runId: RUN });
if (imp.status >= 400) { console.log(JSON.stringify(imp.body?.error ?? imp.body).slice(0, 1500)); process.exit(1); }
const S = imp.data.snapshot.id;
console.log("snapshot", S, imp.data.snapshot.status, "warnings:", imp.data.warnings?.map((w) => w.code).join(",") || "none");
const impR = await call("reviewer imports the same run", W, "POST", `/projects/${RP}/snapshots/from-slr`, reviewer, { runId: RUN });
const SR = impR.data?.snapshot?.id;

const M = (p, s) => `/projects/${p}/snapshots/${s}/manuscript`;
console.log("\n=== D. owner-only approvals with real roles");
await call("reviewer: methods", W, "POST", `${M(RP, SR)}/methods`, reviewer);
await call("reviewer: blueprint", W, "POST", `${M(RP, SR)}/blueprint`, reviewer, {});
await call("reviewer approves H1 (must be refused)", W, "POST", `${M(RP, SR)}/blueprint/approve`, reviewer, { version: 1 });

console.log("\n=== E. owner runs the whole pipeline");
await call("leader: methods", W, "POST", `${M(LP, S)}/methods`, leader);
await call("leader: blueprint", W, "POST", `${M(LP, S)}/blueprint`, leader, {});
await call("leader approves H1", W, "POST", `${M(LP, S)}/blueprint/approve`, leader, { version: 1 });
const plans = await call("leader: paragraph plans", W, "POST", `${M(LP, S)}/paragraph-plans`, leader, {});
const pv = await call("leader: plans view", W, "GET", `${M(LP, S)}/paragraph-plans`, leader, null, false);
const planList = pv.data?.revision?.content?.plans ?? [];
const bySection = {};
for (const p of planList) { bySection[p.sectionKey] ??= { total: 0, ready: 0 }; bySection[p.sectionKey].total++; if (p.status === "READY_TO_DRAFT") bySection[p.sectionKey].ready++; }
console.log("plans by section:", JSON.stringify(bySection), "issues:", pv.data?.issues?.length);
const sections = Object.entries(bySection).filter(([, v]) => v.ready > 0).map(([k]) => k);
for (const k of sections) await call(`leader drafts ${k}`, W, "POST", `${M(LP, S)}/sections/${k}/draft`, leader, {});
const all = ["methods", ...sections.filter((k) => k !== "methods")];
const ver = await call("leader runs verification", W, "POST", `${M(LP, S)}/verification/run`, leader, {});
console.log("verification:", ver.data?.report?.status, JSON.stringify(ver.data?.report?.summary), Object.entries(ver.data?.report?.gates ?? {}).map(([g, r]) => `${g}:${r.status}`).join(" "));
for (const k of all) await call(`leader approves H2 ${k}`, W, "POST", `${M(LP, S)}/sections/${k}/approve`, leader, { version: 1 });
const st = await call("leader: final status", W, "GET", `${M(LP, S)}/final/status`, leader, null, false);
console.log("H3 canApprove:", st.data?.canApprove, "required:", st.data?.requiredSections, "omitted:", st.data?.omittedSections, "reasons:", st.data?.blockingReasons);
await call("reviewer cannot approve H3 on own project", W, "POST", `${M(RP, SR)}/final/approve`, reviewer, {});
if (st.data?.canApprove) {
  await call("leader approves H3", W, "POST", `${M(LP, S)}/final/approve`, leader, {});
  const ex = await call("leader exports", W, "POST", `${M(LP, S)}/export`, leader, {});
  console.log("export files:", ex.data?.manifest?.map((f) => f.filename).join(", "));
}
process.exit(0);

// Step 2 of 2 (run after flow-link-import-roles.mjs). Continues on the leader's existing project/snapshot: map RQ coverage (what the user does in the Outline editor), then the whole pipeline.
const AUTH = "http://127.0.0.1:9099", W = "http://127.0.0.1:5121/api";
const token = async (email) => (await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Demo@12345", returnSecureToken: true }) })).json()).idToken;
const leader = await token("leader@slr.local");
async function call(label, method, path, body, show = true) {
  const r = await fetch(W + path, { method, headers: { Authorization: `Bearer ${leader}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (show) console.log(label.padEnd(44), r.status, j?.success === false ? j.error?.code + " | " + (j.error?.message ?? "").slice(0, 140) : "ok");
  return { status: r.status, data: j?.data, body: j };
}
const projects = (await call("", "GET", "/projects", null, false)).data;
const P = projects.find((p) => p.name === "Leader project").id;
const S = (await call("", "GET", `/projects/${P}/snapshots`, null, false)).data[0].id;
const M = `/projects/${P}/snapshots/${S}/manuscript`;

// 1. map each research question to a Results subsection (the human step the editor offers)
const bp = (await call("", "GET", `${M}/blueprint`, null, false)).data;
const content = structuredClone(bp.revision.content);
const results = content.sections.find((s) => s.key === "results");
results.subsections.forEach((sub, i) => {
  const rq = `rq${i + 1}`;
  sub.rqIds = [rq];
  content.coverage.find((c) => c.rqId === rq).subsectionIds = [sub.id];
});
const saved = await call("leader maps RQ coverage (PUT blueprint)", "PUT", `${M}/blueprint`, { baseVersion: bp.revision.version, content });
const bp2 = (await call("", "GET", `${M}/blueprint`, null, false)).data;
console.log("version", bp2.revision.version, "approvable:", bp2.approvable, "issues:", bp2.issues.map((i) => i.code + ":" + i.severity).join(","));
await call("leader approves H1", "POST", `${M}/blueprint/approve`, { version: bp2.revision.version });

// 2. plans
await call("leader: paragraph plans", "POST", `${M}/paragraph-plans`, {});
const pv = (await call("", "GET", `${M}/paragraph-plans`, null, false)).data;
const bySection = {};
for (const p of pv.revision.content.plans) { bySection[p.sectionKey] ??= { total: 0, ready: 0 }; bySection[p.sectionKey].total++; if (p.status === "READY_TO_DRAFT") bySection[p.sectionKey].ready++; }
console.log("plans by section:", JSON.stringify(bySection), "| issues:", pv.issues.length, [...new Set(pv.issues.map((i) => i.code))].join(","));

// 3. draft every section that has ready paragraphs
const sections = Object.entries(bySection).filter(([, v]) => v.ready > 0).map(([k]) => k);
for (const k of sections) await call(`leader drafts ${k}`, "POST", `${M}/sections/${k}/draft`, {});

// 4. verification
const ver = await call("leader runs verification", "POST", `${M}/verification/run`, {});
const rep = ver.data?.report;
console.log("verification:", rep?.status, JSON.stringify(rep?.summary));
console.log("gates:", Object.entries(rep?.gates ?? {}).map(([g, r]) => `${g}:${r.status}`).join(" "));
for (const i of (rep?.issues ?? []).slice(0, 6)) console.log("  issue", i.gateId, i.severity, i.sectionKey, "-", i.message.slice(0, 120));

// 5. H2 for all required sections, H3, export
const status0 = (await call("", "GET", `${M}/final/status`, null, false)).data;
console.log("required:", status0.requiredSections, "omitted:", status0.omittedSections);
for (const k of status0.requiredSections) await call(`leader approves H2 ${k}`, "POST", `${M}/sections/${k}/approve`, { version: 1 });
const st = (await call("", "GET", `${M}/final/status`, null, false)).data;
console.log("H3 canApprove:", st.canApprove, "reasons:", st.blockingReasons);
if (st.canApprove) {
  await call("leader approves H3", "POST", `${M}/final/approve`, {});
  const ex = await call("leader exports package", "POST", `${M}/export`, {});
  console.log("export files:", ex.data?.manifest?.map((f) => `${f.filename}(${f.sizeBytes})`).join(", "));
  const lin = (await call("", "GET", `${M}/lineage`, null, false)).data;
  console.log("lineage paragraphs:", lin.count, "with evidence:", lin.lineage.filter((l) => l.evidence.length).length);
}
process.exit(0);

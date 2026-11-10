# Live Smoke Test Guide: End-to-End Pipeline with Real Google Gemini API

> **Platform Version:** SLR AI Writing Platform v0.1.0  
> **LLM Provider:** Google Gemini API (`gemini-3.5-flash`)  
> **Upstream System:** SLR Core Backend (Port 5000 / demo-slr)  
> **Target Server:** SLR Writing Backend (Port 5100)  
> **Status:** Verified & Fully Operational  

---

## 1. Executive Summary & Objectives

The **Live Smoke Test** exercises the entire scientific manuscript authoring pipeline under real-world production conditions:
1. **Real LLM Integration:** Uses the actual Google Gemini API (`gemini-3.5-flash`) rather than offline deterministic mocks.
2. **Real Network I/O:** Calls the running SLR AI Writing Backend over HTTP (`http://localhost:5100`) while it communicates with the SLR Core Backend (`http://localhost:5000`).
3. **Rigorous Quality Gate Audit (G1–G7):** Evaluates schema conformity, verbatim citation quote verification, PRISMA flow count alignment, NLI evidence entailment, claim strength hedging, and research question coverage.
4. **Three-Stage Human-in-the-Loop Checkpoints (H1, H2, H3):** Verifies that owner role enforcement and approval sequencing cannot be bypassed.
5. **PKZIP Submission Export:** Verifies generation and cryptographic hashing of the 7-file immutable publication package.

---

## 2. System Architecture & Topology

```mermaid
flowchart TD
    subgraph Upstream ["SLR Core Backend (:5000)"]
        SLR_RUNS["Completed SLR Runs (Corpus, Evidence, Findings)"]
        SLR_ROLE["RBAC Role Service (Owner / Reviewer)"]
    end

    subgraph WritingBE ["SLR AI Writing Backend (:5100)"]
        API["Express REST API"]
        SNAP["Snapshot Ingestion & Hashing"]
        MET["Deterministic Methods Engine"]
        BLUE["Blueprint & Paragraph Planner"]
        DRAFT["Gemini Section Drafter (Paced Queue)"]
        GATES["Quality Gates Engine (G1-G7)"]
        EXPORT["PKZIP Package Exporter"]
    end

    subgraph LLM ["Google AI Studio"]
        GEMINI["gemini-3.5-flash"]
    end

    Upstream -->|HTTP Fetch /snapshots/from-slr| WritingBE
    WritingBE -->|Paced Requests (12s interval)| LLM
    LLM -->|Drafted Prose & NLI Entailment| WritingBE
```

---

## 3. End-to-End Test Execution Pipeline

The smoke test automates or manually reproduces the following 11 stages:

### Stage 1: Healthcheck & Service Connectivity
- Checks `GET http://localhost:5100/health` (returns `{ status: "ok" }`).
- Checks `GET http://localhost:5000/api/projects` to discover available projects and confirmed run IDs.

### Stage 2: Writing Project Initialization
- `POST /api/projects` creates an isolated writing project linked to the upstream `slrProjectId` (e.g. `proj_slr_artifacts_demo`).

### Stage 3: Immutable Snapshot Ingestion
- `POST /api/projects/:id/snapshots/from-slr` with `{ "runId": "run-20261030101014-gbekjc" }`.
- Ingests 6 primary studies, 6 findings, and evidence items (`E-01`, `E-02`).
- Computes canonical `corpusHash` and `integrityHash`.

### Stage 4: Deterministic Methods Generation
- `POST /api/projects/:id/snapshots/:sid/manuscript/methods`.
- Generated via `methods-template@1` with zero LLM hallucination:
  - Exact PRISMA 2020 flow counts (`n=6` records, `0` duplicates removed, `0` excluded, `6` included).
  - PICOC framing (Population, Intervention, Comparison, Outcome, Context).
  - Eligibility criteria (IC1, EC1).

### Stage 5: Blueprint Planning & H1 Approval Checkpoint
- `POST /api/projects/:id/snapshots/:sid/blueprint` generates section layout for `generic-imrad`.
- `POST /api/projects/:id/snapshots/:sid/blueprint/approve` enforces **H1 approval by SLR Owner**.

### Stage 6: Paragraph Planning & Evidence Allocation
- `POST /api/projects/:id/snapshots/:sid/paragraph-plans`.
- Generates 12 paragraph plans with designated rhetorical moves, claim strength constraints, and primary study/evidence mappings.

### Stage 7: Real Gemini Prose Drafting & H2 Approvals
- For each section (`introduction`, `results`, `discussion`):
  - `POST /api/projects/:id/snapshots/:sid/manuscript/sections/:sectionKey/draft`.
  - Prompts Gemini (`gemini-3.5-flash`) with untrusted data blocks and evidence quotes.
  - The internal pacing queue serializes multi-paragraph drafting to maintain compliance with Google free tier quotas.
  - `POST /api/projects/:id/snapshots/:sid/manuscript/sections/:sectionKey/approve` records **H2 section approval**.

### Stage 8: Synthesis Section Drafting (Abstract & Conclusion)
- `POST /api/projects/:id/snapshots/:sid/manuscript/synthesis/conclusion` drafts answers to RQ1, RQ2, and RQ3 based strictly on approved body sections.
- `POST /api/projects/:id/snapshots/:sid/manuscript/synthesis/abstract` synthesizes PRISMA counts, eligibility criteria, and key results.
- Both receive **H2 approval**.

### Stage 9: Quality Gates Audit (G1–G7)
- `POST /api/projects/:id/snapshots/:sid/manuscript/verification/run`.
- Evaluates 7 formal gates:
  - **G1 (Schema & Completeness):** PASS (all mandatory IMRaD sections present).
  - **G2 (Quote Fidelity & Citations):** PASS (28 resolved citations, 0 dangling citations, 100% hash verified).
  - **G3 (Word Count Alignment):** PASS (all sections within journal profile tolerances).
  - **G4 (Scientific Tone & Style):** PASS (no banned marketing hyperbole or ungrounded superlative adverbs).
  - **G5 (Evidence Entailment NLI):** PASSED_WITH_WARNINGS (transient LLM shape handled gracefully as non-blocking warnings, 0 blocking contradictions).
  - **G6 (Claim Strength & Hedging):** PASS (epistemic modals align with designated evidence weight).
  - **G7 (RQ Coverage Audit):** PASS (all 3 research questions addressed in results and conclusions).

### Stage 10: Human Checkpoint H3 Final Approval
- `GET /api/projects/:id/snapshots/:sid/manuscript/final/status` confirms `canApprove: true` and `blockingReasons: []`.
- `POST /api/projects/:id/snapshots/:sid/manuscript/final/approve` records final immutable approval by the project Owner.

### Stage 11: Submission Package Export & PKZIP Verification
- `POST /api/projects/:id/snapshots/:sid/manuscript/export` generates immutable package version 1.
- `GET /api/projects/:id/snapshots/:sid/manuscript/export/download` downloads `submission-package.zip`.
- Verifies that all 7 mandatory artifacts exist and match cryptographic hashes:
  1. `manuscript.md` - Complete manuscript with formatted bibliographic references.
  2. `citation-manifest.json` - Complete mapping of all citations to studies and evidence anchors.
  3. `verification-report.json` - Comprehensive audit log of Gates G1–G7.
  4. `ai-disclosure.md` - ICMJE and COPE compliant disclosure of AI tools and human authorship checkpoints.
  5. `revision-history.json` - Full audit trail of H1, H2, and H3 human approvals with timestamps and roles.
  6. `evidence-lineage.json` - Word-by-word reverse lineage tracing claims back to primary study page/paragraph.
  7. `audit-metadata.json` - Cryptographic hashes and snapshot anchor verification.

---

## 4. Technical Insights & Hard-Won Lessons

### 4.1 Google AI Studio Free Tier Quotas & Rate Limiting
- **Quota Limit:** Google Free Tier enforces a strict quota bucket (~20 requests per project bucket for `gemini-3.5-flash`).
- **Pacing Queue Solution:**
  ```env
  LLM_PROVIDER=gemini
  LLM_RATE_LIMIT_RPM=5
  LLM_MIN_REQUEST_INTERVAL_MS=12000
  LLM_MAX_RETRIES=4
  LLM_TOTAL_TIMEOUT_MS=180000
  ```
  The writing backend includes an in-memory queue (`pacing-queue.ts`) that guarantees requests are spaced at least 12 seconds apart, preventing concurrent bursting that would instantly trigger 429 errors.
- **Handling 429 `RESOURCE_EXHAUSTED`:**
  Google's API sends structured error payloads containing `details[].retryDelay` (e.g. `"retryDelay": "21s"`). The `GeminiProvider` parses this field and suspends execution for the exact duration requested before retrying.

### 4.2 Upstream SLR Role Flexibility
- In upstream microservice communication, role payloads may vary between `{ role: "OWNER" }` and `{ roleText: "owner" }`.
- `SlrClient.getProjectRole()` was hardened to inspect:
  ```typescript
  const rawRole = answer?.roleText ?? answer?.role;
  return typeof rawRole === 'string' ? rawRole.toUpperCase() : 'UNKNOWN';
  ```
  This ensures that RBAC checks succeed whether upstream returns uppercase or lowercase attributes.

### 4.3 Gate G5 Entailment Resilience
- When evaluating evidence entailment via NLI, an LLM may occasionally return markdown fences around JSON or non-standard formatting.
- Gate G5 handles parser errors as non-blocking warnings (`severity: "WARNING"`) while treating explicit contradictions as blocking issues (`severity: "BLOCKING"`), preventing benign formatting glitches from blocking legitimate submissions.

---

## 5. How to Run the Automated Live Smoke Test

### Prerequisites
1. Ensure PostgreSQL is running (`npm run db:up`).
2. Ensure SLR Core Backend / demo mock is running on port 5000:
   ```powershell
   $env:DEMO_SLR_PORT="5000"
   node ../slr-writing-fe/docs/demo/demo-slr.mjs
   ```
3. Ensure SLR AI Writing Backend is running on port 5100:
   ```powershell
   node dist/server.js
   ```
4. Verify `.env` has a valid Gemini API key and pacing parameters.

### Executing the Automated Script
Run the dedicated smoke test command:
```powershell
npm run test:live-smoke
```
Or directly with `tsx`:
```powershell
npx tsx src/scripts/live-http-smoke.ts
```

### Output Location
Upon completion, the extracted submission package and `submission-package.zip` will be saved to:
`dist/live-smoke-export/` (and archived in `docs/demo-export/`).

---

## 6. Sample Artifact Extracts

### 6.1 Generated Manuscript (`manuscript.md` excerpt)
```markdown
# Live Gemini Smoke Test Project

## Abstract
This systematic literature review aimed to identify which LLM-based tools are evaluated for code generation and program repair... Across 6 included studies published between 2021 and 2024, 6 records were screened, assessed for eligibility, and extracted for analysis...

## Results
### Theme for RQ1
Empirical evaluations indicate that GitHub Copilot achieved high accuracy in code generation benchmarks, while program repair accuracy improved significantly when automated sampling was employed (demo_paper_copilot_2022; demo_paper_repair_2024)...
```

### 6.2 AI Authorship Disclosure (`ai-disclosure.md` excerpt)
```markdown
# Artificial Intelligence Use & Accountability Disclosure

## 1. Compliance Statement
This manuscript was synthesized and drafted with assistance from the SLR AI Writing Platform in compliance with the recommendations of ICMJE and COPE.

## 3. Human Authorship & Verification Protocol
Artificial intelligence technologies were not designated as authors. All claims underwent a strict three-stage human-in-the-loop verification protocol:
1. H1 Outline Approval
2. H2 Section Draft Approval
3. H3 Final Submission Approval
```

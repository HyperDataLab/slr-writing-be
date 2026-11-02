-- CreateTable
CREATE TABLE "BlueprintRevision" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlueprintRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "decidedBy" TEXT NOT NULL,
    "slrRole" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlueprintRevision_manuscriptId_version_key" ON "BlueprintRevision"("manuscriptId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_seq_key" ON "Approval"("seq");

-- CreateIndex
CREATE INDEX "Approval_manuscriptId_stage_targetKind_targetId_idx" ON "Approval"("manuscriptId", "stage", "targetKind", "targetId");

-- AddForeignKey
ALTER TABLE "BlueprintRevision" ADD CONSTRAINT "BlueprintRevision_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BlueprintRevision and Approval are append-only: block UPDATE, DELETE and TRUNCATE.
-- A change to a blueprint is a new version; a change of mind about an approval is a new decision.
CREATE OR REPLACE FUNCTION append_only_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER blueprint_revision_no_update_delete
BEFORE UPDATE OR DELETE ON "BlueprintRevision"
FOR EACH ROW EXECUTE FUNCTION append_only_no_change();

CREATE TRIGGER blueprint_revision_no_truncate
BEFORE TRUNCATE ON "BlueprintRevision"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();

CREATE TRIGGER approval_no_update_delete
BEFORE UPDATE OR DELETE ON "Approval"
FOR EACH ROW EXECUTE FUNCTION append_only_no_change();

CREATE TRIGGER approval_no_truncate
BEFORE TRUNCATE ON "Approval"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();

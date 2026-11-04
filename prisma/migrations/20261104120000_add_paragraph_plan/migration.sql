-- CreateTable
CREATE TABLE "ParagraphPlanRevision" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "blueprintRevisionId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "totalParagraphs" INTEGER NOT NULL,
    "readyParagraphs" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParagraphPlanRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ParagraphPlanRevision_manuscriptId_version_key" ON "ParagraphPlanRevision"("manuscriptId", "version");

-- CreateIndex
CREATE INDEX "ParagraphPlanRevision_manuscriptId_blueprintRevisionId_idx" ON "ParagraphPlanRevision"("manuscriptId", "blueprintRevisionId");

-- AddForeignKey
ALTER TABLE "ParagraphPlanRevision" ADD CONSTRAINT "ParagraphPlanRevision_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParagraphPlanRevision" ADD CONSTRAINT "ParagraphPlanRevision_blueprintRevisionId_fkey" FOREIGN KEY ("blueprintRevisionId") REFERENCES "BlueprintRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ParagraphPlanRevision is append-only: block UPDATE, DELETE and TRUNCATE.
-- A change to a paragraph plan creates a new version.
CREATE TRIGGER paragraph_plan_revision_no_update_delete
BEFORE UPDATE OR DELETE ON "ParagraphPlanRevision"
FOR EACH ROW EXECUTE FUNCTION append_only_no_change();

CREATE TRIGGER paragraph_plan_revision_no_truncate
BEFORE TRUNCATE ON "ParagraphPlanRevision"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();


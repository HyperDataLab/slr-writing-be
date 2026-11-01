-- CreateTable
CREATE TABLE "Manuscript" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Manuscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManuscriptSection" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManuscriptSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SectionRevision" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "generator" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SectionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Manuscript_snapshotId_key" ON "Manuscript"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "ManuscriptSection_manuscriptId_sectionKey_key" ON "ManuscriptSection"("manuscriptId", "sectionKey");

-- CreateIndex
CREATE UNIQUE INDEX "SectionRevision_sectionId_version_key" ON "SectionRevision"("sectionId", "version");

-- AddForeignKey
ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Manuscript" ADD CONSTRAINT "Manuscript_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ReviewSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManuscriptSection" ADD CONSTRAINT "ManuscriptSection_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SectionRevision" ADD CONSTRAINT "SectionRevision_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "ManuscriptSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- SectionRevision is append-only: block UPDATE and DELETE. A change in content is a new version.
CREATE OR REPLACE FUNCTION section_revision_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'SectionRevision is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER section_revision_no_update_delete
BEFORE UPDATE OR DELETE ON "SectionRevision"
FOR EACH ROW EXECUTE FUNCTION section_revision_append_only();

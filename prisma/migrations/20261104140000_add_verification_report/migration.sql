-- CreateTable
CREATE TABLE "VerificationReport" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "gates" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "summary" JSONB NOT NULL,
    "runBy" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationReport_manuscriptId_version_key" ON "VerificationReport"("manuscriptId", "version");

-- CreateIndex
CREATE INDEX "VerificationReport_manuscriptId_status_idx" ON "VerificationReport"("manuscriptId", "status");

-- AddForeignKey
ALTER TABLE "VerificationReport" ADD CONSTRAINT "VerificationReport_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- VerificationReport is append-only: block UPDATE, DELETE and TRUNCATE.
-- A new verification run creates a new version.
CREATE TRIGGER verification_report_no_update_delete
BEFORE UPDATE OR DELETE ON "VerificationReport"
FOR EACH ROW EXECUTE FUNCTION append_only_no_change();

CREATE TRIGGER verification_report_no_truncate
BEFORE TRUNCATE ON "VerificationReport"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();


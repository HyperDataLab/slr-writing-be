-- CreateTable
CREATE TABLE "ExportPackage" (
    "id" TEXT NOT NULL,
    "manuscriptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "h3ApprovalId" TEXT NOT NULL,
    "verificationReportId" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "bundle" JSONB NOT NULL,
    "exportedBy" TEXT NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExportPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportPackage_manuscriptId_packageHash_idx" ON "ExportPackage"("manuscriptId", "packageHash");

-- CreateIndex
CREATE UNIQUE INDEX "ExportPackage_manuscriptId_version_key" ON "ExportPackage"("manuscriptId", "version");

-- AddForeignKey
ALTER TABLE "ExportPackage" ADD CONSTRAINT "ExportPackage_manuscriptId_fkey" FOREIGN KEY ("manuscriptId") REFERENCES "Manuscript"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportPackage" ADD CONSTRAINT "ExportPackage_h3ApprovalId_fkey" FOREIGN KEY ("h3ApprovalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportPackage" ADD CONSTRAINT "ExportPackage_verificationReportId_fkey" FOREIGN KEY ("verificationReportId") REFERENCES "VerificationReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ExportPackage is append-only: block UPDATE, DELETE and TRUNCATE.
-- A new export creates a new version.
CREATE TRIGGER export_package_no_update_delete
BEFORE UPDATE OR DELETE ON "ExportPackage"
FOR EACH ROW EXECUTE FUNCTION append_only_no_change();

CREATE TRIGGER export_package_no_truncate
BEFORE TRUNCATE ON "ExportPackage"
FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate();


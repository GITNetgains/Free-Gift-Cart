CREATE TABLE "HelpDeskImageScan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "attachmentId" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "overallVerdict" TEXT,
  "overallConfidence" REAL,
  "contentHash" TEXT,
  "perceptualHash" TEXT,
  "duplicateOfAttachmentId" TEXT,
  "c2paResult" TEXT,
  "watermarkResult" TEXT,
  "exifResult" TEXT,
  "hashResult" TEXT,
  "classifierResult" TEXT,
  "editResult" TEXT,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "HelpDeskImageScan_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "HelpDeskAttachment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HelpDeskImageScan_attachmentId_key" ON "HelpDeskImageScan"("attachmentId");
CREATE INDEX "HelpDeskImageScan_shop_contentHash_idx" ON "HelpDeskImageScan"("shop", "contentHash");
CREATE INDEX "HelpDeskImageScan_status_updatedAt_idx" ON "HelpDeskImageScan"("status", "updatedAt");
ALTER TABLE "HelpDeskSettings" ADD COLUMN "aiDetectionEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "aiDetectorMode" TEXT NOT NULL DEFAULT 'suspicious';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "aiDetectionProvider" TEXT NOT NULL DEFAULT 'sightengine';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "sightengineUser" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "sightengineSecret" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "truthscanKey" TEXT NOT NULL DEFAULT ''

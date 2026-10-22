ALTER TABLE "HelpDeskTicket" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'form';
ALTER TABLE "HelpDeskTicket" ADD COLUMN "staffReadAt" DATETIME;
ALTER TABLE "HelpDeskAttachment" ADD COLUMN "messageId" TEXT;
CREATE INDEX "HelpDeskAttachment_messageId_idx" ON "HelpDeskAttachment"("messageId");
ALTER TABLE "HelpDeskSettings" ADD COLUMN "statusEmails" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "chatEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "chatGreeting" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HelpDeskSettings" ADD COLUMN "faqsSeeded" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "HelpDeskFaq" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "keywords" TEXT NOT NULL DEFAULT '',
  "answer" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HelpDeskFaq_shop_idx" ON "HelpDeskFaq"("shop");
CREATE TABLE "HelpDeskBotQuestion" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "faqId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "HelpDeskBotQuestion_shop_createdAt_idx" ON "HelpDeskBotQuestion"("shop", "createdAt");
CREATE TABLE "HelpDeskEmail" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "messageId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT NOT NULL DEFAULT '',
  "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HelpDeskEmail_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HelpDeskTicket" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HelpDeskEmail_status_nextAttemptAt_idx" ON "HelpDeskEmail"("status", "nextAttemptAt");
CREATE INDEX "HelpDeskEmail_ticketId_idx" ON "HelpDeskEmail"("ticketId")

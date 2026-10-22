ALTER TABLE "HelpDeskSettings" ADD COLUMN "formLastSeenAt" DATETIME;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "chatLastSeenAt" DATETIME;
ALTER TABLE "HelpDeskSettings" ADD COLUMN "faqsReviewed" BOOLEAN NOT NULL DEFAULT false

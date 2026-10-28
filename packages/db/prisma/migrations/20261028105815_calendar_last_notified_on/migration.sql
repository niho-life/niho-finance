-- Calendar reminders (S8, docs/ops/deploy.md §6): the day the last reminder mail went out, so
-- the daily job sends the 7-days-before and the on/after-due-date mail once each.

-- AlterTable
ALTER TABLE "calendar_item" ADD COLUMN     "last_notified_on" DATE;

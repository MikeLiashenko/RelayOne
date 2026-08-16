ALTER TABLE "space_channels" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "space_channels" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "space_channels" ALTER COLUMN "kind" SET DEFAULT 'text';--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "space_channels" ADD COLUMN "category" text DEFAULT 'Channels' NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "banner_url" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_handle_lower_unique" ON "spaces" USING btree (lower("handle")) WHERE "spaces"."handle" is not null;--> statement-breakpoint
DROP TYPE "public"."space_channel_kind";--> statement-breakpoint
DROP TYPE "public"."space_role";

CREATE TABLE IF NOT EXISTS "space_event_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"channel_id" uuid,
	"notified_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "space_event_rsvps" ADD CONSTRAINT "space_event_rsvps_event_id_space_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."space_events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "space_event_rsvps" ADD CONSTRAINT "space_event_rsvps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "space_events" ADD CONSTRAINT "space_events_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "space_events" ADD CONSTRAINT "space_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "space_events" ADD CONSTRAINT "space_events_channel_id_space_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."space_channels"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "space_event_rsvps_unique" ON "space_event_rsvps" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_event_rsvps_event_idx" ON "space_event_rsvps" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_events_space_starts_idx" ON "space_events" USING btree ("space_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_events_starts_idx" ON "space_events" USING btree ("starts_at");
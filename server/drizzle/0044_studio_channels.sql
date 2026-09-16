CREATE TABLE IF NOT EXISTS "studio_channels" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "channel_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "member_bot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_bot_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_channel_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "studio_channel_id" text NOT NULL,
  "from_bot_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_channels" ADD CONSTRAINT "studio_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_channel_messages" ADD CONSTRAINT "studio_channel_messages_studio_channel_id_studio_channels_id_fk" FOREIGN KEY ("studio_channel_id") REFERENCES "public"."studio_channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_channel_messages" ADD CONSTRAINT "studio_channel_messages_from_bot_id_agents_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_channel_messages_room_idx" ON "studio_channel_messages" ("studio_channel_id","created_at");

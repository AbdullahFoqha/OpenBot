CREATE TABLE IF NOT EXISTS "studio_channel_chat_models" (
  "user_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "provider" text NOT NULL,
  "model_id" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id","channel_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_channel_chat_models" ADD CONSTRAINT "studio_channel_chat_models_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_channel_chat_models" ADD CONSTRAINT "studio_channel_chat_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "studio_skill_packs" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "studio_skill_pack_attachments" (
  "pack_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "studio_skill_pack_attachments_pack_id_bot_id_pk" PRIMARY KEY("pack_id","bot_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_skill_pack_attachments" ADD CONSTRAINT "studio_skill_pack_attachments_pack_id_studio_skill_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."studio_skill_packs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "studio_skill_pack_attachments" ADD CONSTRAINT "studio_skill_pack_attachments_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_skill_pack_attachments_bot_idx" ON "studio_skill_pack_attachments" ("bot_id");

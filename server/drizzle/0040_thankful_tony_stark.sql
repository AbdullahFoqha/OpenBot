CREATE TABLE "studio_evidence" (
	"task_id" text PRIMARY KEY NOT NULL,
	"backend" text,
	"requested_model" text,
	"reported_model" text,
	"session_id" text,
	"worktree_path" text,
	"changed_files" text[] DEFAULT '{}' NOT NULL,
	"diff" text,
	"check_before" jsonb,
	"check_after" jsonb,
	"ok" boolean,
	"blocker" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_products" ADD COLUMN "local_path" text;--> statement-breakpoint
ALTER TABLE "studio_products" ADD COLUMN "queue_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_tasks" ADD COLUMN "goal" text;--> statement-breakpoint
ALTER TABLE "studio_tasks" ADD COLUMN "acceptance_criteria" text;--> statement-breakpoint
ALTER TABLE "studio_evidence" ADD CONSTRAINT "studio_evidence_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;
CREATE TYPE "public"."studio_review_verdict" AS ENUM('approved', 'changes_required', 'blocked');--> statement-breakpoint
CREATE TABLE "studio_acceptance" (
	"task_id" text PRIMARY KEY NOT NULL,
	"criteria" jsonb NOT NULL,
	"required_reviewers" text[] DEFAULT '{}' NOT NULL,
	"requires_native_verification" boolean DEFAULT false NOT NULL,
	"requires_design_approval" boolean DEFAULT false NOT NULL,
	"design_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_branches" (
	"task_id" text PRIMARY KEY NOT NULL,
	"branch" text NOT NULL,
	"base_commit" text NOT NULL,
	"base_branch" text NOT NULL,
	"worktree_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_pull_requests" (
	"task_id" text PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"number" integer,
	"url" text,
	"base_branch" text NOT NULL,
	"head_branch" text NOT NULL,
	"draft" boolean DEFAULT true NOT NULL,
	"pending_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"commit" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"author_id" text NOT NULL,
	"verdict" "studio_review_verdict" NOT NULL,
	"findings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_acceptance" ADD CONSTRAINT "studio_acceptance_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_branches" ADD CONSTRAINT "studio_branches_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_pull_requests" ADD CONSTRAINT "studio_pull_requests_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_reviews" ADD CONSTRAINT "studio_reviews_task_id_studio_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."studio_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_branches_base_idx" ON "studio_branches" USING btree ("base_branch");--> statement-breakpoint
CREATE INDEX "studio_pull_requests_repo_idx" ON "studio_pull_requests" USING btree ("repository");--> statement-breakpoint
CREATE INDEX "studio_reviews_task_commit_idx" ON "studio_reviews" USING btree ("task_id","commit");
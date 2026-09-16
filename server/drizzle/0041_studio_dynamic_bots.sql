CREATE TABLE IF NOT EXISTS studio_dynamic_bots (
  id text PRIMARY KEY,
  name text NOT NULL,
  title text,
  system_prompt text NOT NULL,
  avatar_seed text,
  template_role_id text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

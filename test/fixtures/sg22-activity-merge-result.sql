CREATE TABLE te_activity_merge_candidate (
 tenant_id varchar(64) NOT NULL,version_id varchar(64) NOT NULL,candidate_snapshot_id varchar(64) NOT NULL,
 created_by varchar(64) NOT NULL,snapshot_json text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version_id,candidate_snapshot_id)
);
-- SG22 editor migration: apply once through the approved release process.
-- Local integration applies this only to the task-owned synthetic PostgreSQL.
CREATE TABLE te_activity_merge_submission (
 tenant_id varchar(64) NOT NULL, version_id varchar(64) NOT NULL, submission_id varchar(64) NOT NULL,
 acknowledged boolean NOT NULL DEFAULT false, request_json text NOT NULL, created_by varchar(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,version_id,submission_id)
);
CREATE TABLE te_activity_merge_outcome (
 tenant_id varchar(64) NOT NULL, version_id varchar(64) NOT NULL, submission_id varchar(64) NOT NULL,
 group_key varchar(128) NOT NULL, activity_name text NOT NULL, selected_ids text NOT NULL,
 status varchar(16) NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED')),
 PRIMARY KEY (tenant_id,version_id,submission_id,group_key),
 FOREIGN KEY (tenant_id,version_id,submission_id) REFERENCES te_activity_merge_submission
);
CREATE INDEX ix_activity_merge_pending ON te_activity_merge_outcome(tenant_id,version_id,status);

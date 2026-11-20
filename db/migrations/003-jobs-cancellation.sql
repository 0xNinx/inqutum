-- Migration 003: Add 'cancelled' status to jobs table
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'succeeded', 'dead', 'cancelled'));

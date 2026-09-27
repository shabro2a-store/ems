-- Security #7: AuditLog is meant to be append-only. The REVOKE in
-- 20260709232637_add_constraints only reaches a role named ems_app, and the app
-- connects as the database owner, which no REVOKE touches - so the record could
-- be rewritten by the very code it records. A trigger binds every role.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only: % refused', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

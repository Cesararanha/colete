begin;

-- Constraint triggers execute in the role active when the triggering statement
-- commits. The identity RPCs are entered as service_role, which deliberately
-- has no USAGE on private, so this trigger function must use its postgres owner
-- without widening the administrative role's privileges.
alter function private.enforce_idempotency_conclusion()
  security definer;

comment on function private.enforce_idempotency_conclusion() is
  'Enforces completed idempotency state at the real commit boundary. SECURITY DEFINER is required because the deferred trigger fires under the caller role, while service_role deliberately has no access to private.';

commit;

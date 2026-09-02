begin;

-- Settles the row level security debt that migration 0002 left behind.
-- Sources: docs/14-convencoes-app.md section 5.2; docs/16-roadmap.md section 3,
-- slice 9; docs/20-operacao-m0-b.md; docs/21-operacao-m1-a.md.
--
-- private.app_limits and private.allowed_proof_mime_types were created with
-- enable + force row level security and zero policies. That predates the M0-B
-- finding that produced the rule in docs/14 section 5.2: a service table that
-- no client role reads belongs in private, without RLS, protected by the
-- absence of USAGE on the schema and the absence of any grant.
--
-- force applies RLS to the table owner too. With zero policies, the only thing
-- these two tables' RLS can still do is return zero rows to a legitimate
-- server-side reader that lacks BYPASSRLS. For a table read as configuration
-- that is not extra safety, it is a silent wrong answer: a limit that reads as
-- absent instead of as its real value. Nothing is lost by removing it, because
-- RLS was never the barrier here.
--
-- Append-only, like every other change in this repository: 0002 is not
-- rewritten. Only these two tables are touched.

alter table private.app_limits no force row level security;
alter table private.app_limits disable row level security;

alter table private.allowed_proof_mime_types no force row level security;
alter table private.allowed_proof_mime_types disable row level security;

comment on table private.app_limits is
  'Operational calibration values. No personal data; classified in docs/17-mapa-dados-lgpd.md. Protected by the absence of USAGE on the private schema and the absence of any grant, not by RLS.';
comment on table private.allowed_proof_mime_types is
  'Allowlist of proof upload media types, from docs/13-contratos-funcoes.md section 2.1. Protected by schema and table privilege, not by RLS.';

commit;

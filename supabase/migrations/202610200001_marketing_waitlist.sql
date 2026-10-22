-- Early-access emails are server-only. No anonymous/authenticated client can
-- insert, enumerate, update or delete addresses. Existing consent is immutable
-- through the signup endpoint: duplicate email inserts use DO NOTHING.
create table public.peekalo_waitlist (
  email text primary key check (
    octet_length(email) between 3 and 254
    and email = lower(btrim(email))
    and email !~ '[[:space:][:cntrl:]]'
    and email ~ '^[^@]+@[^@]+\.[^@]+$'
  ),
  consent_version text not null check (consent_version = 'early-access-v1'),
  consented_at timestamptz not null default now()
);

alter table public.peekalo_waitlist enable row level security;
revoke all on public.peekalo_waitlist from public, anon, authenticated, service_role;
grant insert on public.peekalo_waitlist to service_role;
-- PostgreSQL requires SELECT on the conflict target for ON CONFLICT(email).
grant select(email) on public.peekalo_waitlist to service_role;

create table users (email text);
create unique index i on public.users (email);
create schema audit;
create table audit.users (email text);
create index i on audit.users (email);

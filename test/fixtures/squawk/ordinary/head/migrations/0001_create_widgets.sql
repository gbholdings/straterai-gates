create table widgets (
    id bigserial primary key,
    name text not null,
    created_at timestamptz not null default now()
);

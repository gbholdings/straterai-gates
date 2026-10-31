create table users (id int, email text, name text);
create index u on users (name);
do $$ begin drop index u; create unique index u on users (email); end $$;

create table users (id bigint primary key, email text, name text);
create unique index u on users (email);

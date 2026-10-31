drop index u;
insert into users (id, email) values (2, 'a@x'), (3, 'a@x');
create unique index u2 on users (email);

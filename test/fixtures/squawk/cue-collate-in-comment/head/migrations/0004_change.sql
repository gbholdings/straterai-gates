-- we considered: alter table widgets alter column name type text collate "C";
create table gadgets (id bigint generated always as identity primary key, label text collate "C");

create table parted (id int) partition by range (id);
create unique index u on parted (id);

alter type "Status" rename to "Status_old";
create type "Status" as enum ('active', 'archived');
alter table widgets alter column status type "Status" using (status::text::"Status");
drop type "Status_old";

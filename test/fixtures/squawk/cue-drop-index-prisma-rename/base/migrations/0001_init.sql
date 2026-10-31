create table widgets (id bigint primary key, name text, tenant_id bigint);
create unique index widgets_name_key on widgets (name);
create index idx_widgets_name on widgets (name);

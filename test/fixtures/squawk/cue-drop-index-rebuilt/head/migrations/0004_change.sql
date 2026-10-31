-- squawk-ignore require-concurrent-index-deletion
drop index idx_widgets_name;
-- squawk-ignore require-concurrent-index-creation
create index idx_widgets_name on widgets (name, id);

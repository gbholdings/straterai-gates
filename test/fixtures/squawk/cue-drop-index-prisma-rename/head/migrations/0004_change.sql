-- squawk-ignore require-concurrent-index-deletion
drop index widgets_name_key;
-- squawk-ignore require-concurrent-index-creation
create unique index widgets_label_key on widgets (name);

select
    orders.order_id,
    orders.status as order_status,
    coalesce(payments.amount, 0) as paid_amount
from {{ ref('stg_orders') }} as orders
left join {{ ref('stg_payments') }} as payments
    on orders.order_id = payments.order_id

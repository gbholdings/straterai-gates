select {{ cols() }} from {{ source("raw", "events") }}

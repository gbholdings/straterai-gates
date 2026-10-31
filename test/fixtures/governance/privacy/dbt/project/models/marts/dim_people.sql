select person_id, email, tax_id from {{ ref('people_seed') }}

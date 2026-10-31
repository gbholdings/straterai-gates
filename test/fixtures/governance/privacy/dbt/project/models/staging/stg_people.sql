select person_id, email from {{ ref('people_seed') }}

-- Citizenship is an eligibility statement for applicants, not a blocking form or draw control.
UPDATE special_events
SET requires_russian_citizenship = 0,
    updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE slug = 'amber-combine-jewelry-excursion';

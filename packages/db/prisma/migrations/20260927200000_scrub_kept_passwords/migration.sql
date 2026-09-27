-- Security #4: the answer to "create a person" carried their password, and it
-- was kept here in plain text as the Idempotency-Key replay. The route no
-- longer sends it; this removes the copies already kept.
UPDATE "IdempotencyKey"
SET "response_json" = "response_json" #- '{data,temp_password}'
WHERE "response_json" #> '{data,temp_password}' IS NOT NULL;

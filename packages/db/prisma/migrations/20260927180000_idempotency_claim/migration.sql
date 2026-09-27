-- An idempotency key is now claimed BEFORE the work it guards, not recorded
-- after it: the claiming insert is what stops two requests with one key both
-- doing the work. A claim holds no answer yet (status_code 0, response_json
-- NULL) until the request stores one. `scope` is the route the key was used
-- on, so a key cannot replay one endpoint's answer to another. Existing rows
-- keep an empty scope, which matches any route, as they always did.
ALTER TABLE "IdempotencyKey" ALTER COLUMN "response_json" DROP NOT NULL;
ALTER TABLE "IdempotencyKey" ALTER COLUMN "status_code" SET DEFAULT 0;
ALTER TABLE "IdempotencyKey" ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';

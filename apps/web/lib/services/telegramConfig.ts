/**
 * The value docker-compose.yml used to fill in when TELEGRAM_WEBHOOK_SECRET was
 * unset. It is published in the repo, so it guards nothing; still refused in
 * case a server's .env copied it.
 */
const PUBLISHED_FALLBACK = 'dev_webhook_secret_change_in_prod';

export function webhookSecretUsable(secret: string): boolean {
  return secret.length > 0 && secret !== PUBLISHED_FALLBACK;
}

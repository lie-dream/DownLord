export function generateSecret(crypto: typeof import('crypto')): string {
  return crypto.randomBytes(32).toString('hex')
}

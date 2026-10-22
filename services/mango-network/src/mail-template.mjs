const HEADER_BREAK = /[\r\n]/;

export function assertSafeHeader(value, field = 'header') {
  if (typeof value !== 'string' || value.length === 0 || HEADER_BREAK.test(value)) {
    throw new TypeError(`${field} must be a non-empty single-line string`);
  }
  return value;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatExpiry(expiresAt) {
  if (expiresAt === undefined || expiresAt === null) return null;
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw new TypeError('expiresAt must be a valid date');
  return date.toISOString();
}

/**
 * Build both representations of an email-verification message. This function
 * is pure and deliberately performs no logging so the one-time code is not
 * accidentally copied into application logs.
 */
export function createVerificationMail({ code, expiresAt, productName = 'Mango Network' }) {
  if (typeof code !== 'string' || code.length < 4 || code.length > 128 || /[\r\n]/.test(code)) {
    throw new TypeError('code must be a single-line string between 4 and 128 characters');
  }
  assertSafeHeader(productName, 'productName');

  const expiry = formatExpiry(expiresAt);
  const subject = `${productName} email verification`;
  const expiryText = expiry ? `\nThis code expires at ${expiry}.` : '';
  const text = `Your ${productName} verification code is:\n\n${code}\n${expiryText}\n\nIf you did not request this code, ignore this email.`;
  const htmlExpiry = expiry ? `<p>This code expires at <time datetime="${escapeHtml(expiry)}">${escapeHtml(expiry)}</time>.</p>` : '';
  const html = `<!doctype html><html><body><h1>${escapeHtml(productName)} email verification</h1><p>Your verification code is:</p><p><strong>${escapeHtml(code)}</strong></p>${htmlExpiry}<p>If you did not request this code, ignore this email.</p></body></html>`;

  return { subject, text, html };
}

import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import type { OtpPurpose } from '../../models/Otp.js';
import { AppError } from '../../utils/errors.js';

function otpEmailCopy(purpose: OtpPurpose): {
  title: string;
  headline: string;
  preview: (code: string, expiresMinutes: number) => string;
  lead: string;
  subject: (code: string) => string;
  textLine: (code: string) => string;
} {
  if (purpose === 'delete_account') {
    return {
      title: 'Knowra account deletion code',
      headline: 'Confirm account deletion',
      preview: (code, expiresMinutes) =>
        `Your Knowra account deletion code is ${code}. Expires in ${expiresMinutes} minutes.`,
      lead: 'Use this one-time code to permanently delete your Knowra account. It expires in',
      subject: (code) => `${code} is your Knowra account deletion code`,
      textLine: (code) => `Your account deletion code is ${code}.`,
    };
  }
  if (purpose === 'delete_files') {
    return {
      title: 'Knowra file deletion code',
      headline: 'Confirm delete all files',
      preview: (code, expiresMinutes) =>
        `Your Knowra file deletion code is ${code}. Expires in ${expiresMinutes} minutes.`,
      lead: 'Use this one-time code to permanently delete all files in your Knowra account. It expires in',
      subject: (code) => `${code} is your Knowra file deletion code`,
      textLine: (code) => `Your file deletion code is ${code}.`,
    };
  }
  return {
    title: 'Knowra sign-in code',
    headline: 'Your sign-in code',
    preview: (code, expiresMinutes) =>
      `Your Knowra sign-in code is ${code}. Expires in ${expiresMinutes} minutes.`,
    lead: 'Use this one-time code to sign in to Knowra. It expires in',
    subject: (code) => `${code} is your Knowra sign-in code`,
    textLine: (code) => `Your sign-in code is ${code}.`,
  };
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      jsonTransport: true,
    });
    return transporter;
  }

  // `family: 4` forces IPv4 when SMTP is allowed (local / paid hosts).
  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    family: 4,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    auth: env.SMTP_USER
      ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        }
      : undefined,
  } as Parameters<typeof nodemailer.createTransport>[0]);

  return transporter;
}

/** Bump when the public mark changes so inbox image caches fetch the new file. */
const LOGO_VERSION = '2';

/**
 * Hosted HTTPS logo only — never attach files.
 * Gmail always shows CID/inline MIME parts as an attachment chip in the inbox.
 */
function getLogoSrc(): string {
  const explicit = env.EMAIL_LOGO_URL.trim();
  if (explicit.startsWith('https://')) return withLogoVersion(explicit);

  for (const raw of env.CLIENT_ORIGIN.split(',')) {
    const origin = raw.trim().replace(/\/$/, '');
    if (origin.startsWith('https://')) return withLogoVersion(`${origin}/logo.png`);
  }

  return '';
}

function withLogoVersion(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', LOGO_VERSION);
    return parsed.toString();
  } catch {
    return url;
  }
}

function buildLogoCell(logoSrc: string): string {
  if (logoSrc) {
    return `<img src="${logoSrc}" alt="Knowra" width="40" height="40" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;border-radius:10px;" />`;
  }

  // HTML mark — no file, so no Gmail attachment chip.
  return `<span style="display:inline-block;width:40px;height:40px;background:#121212;border-radius:10px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:40px;color:#dcb35a;">&#10022;</span>`;
}

function buildOtpEmailHtml(
  code: string,
  expiresMinutes: number,
  purpose: OtpPurpose = 'login',
): string {
  const digits = code.split('').map(
    (d) =>
      `<td style="width:44px;height:54px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.14);border-radius:12px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:22px;font-weight:700;color:#f5f5f5;letter-spacing:0;">${d}</td>`,
  );

  const digitRow = digits.join(
    '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>',
  );

  const logoCell = buildLogoCell(getLogoSrc());
  const copy = otpEmailCopy(purpose);
  const title = copy.title;
  const headline = copy.headline;
  const preview = copy.preview(code, expiresMinutes);
  const lead = copy.lead;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark light" />
  <meta name="supported-color-schemes" content="dark light" />
  <title>${title}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent;">
    ${preview}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#141414;border:1px solid rgba(255,255,255,0.12);border-radius:22px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid rgba(255,255,255,0.10);">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;width:40px;">
                    ${logoCell}
                  </td>
                  <td style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
                  <td style="vertical-align:middle;">
                    <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;color:#f5f5f5;letter-spacing:-0.02em;line-height:1.1;">Knowra</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#a3a3a3;letter-spacing:0.01em;">Ask. Explore. Understand.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 10px;font-size:22px;font-weight:600;color:#f5f5f5;line-height:1.3;letter-spacing:-0.01em;">${headline}</h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#a3a3a3;">
                ${lead}
                <strong style="color:#f5f5f5;">${expiresMinutes} minutes</strong>.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px;">
                <tr>
                  ${digitRow}
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#737373;text-align:center;text-transform:uppercase;letter-spacing:0.08em;">
                Or copy the full code
              </p>
              <p style="margin:0 0 28px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:0.35em;color:#f5f5f5;">
                ${code}
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1a1a;border:1px solid rgba(255,255,255,0.10);border-radius:14px;">
                <tr>
                  <td style="padding:14px 16px;font-size:13px;line-height:1.55;color:#a3a3a3;">
                    If you didn’t request this code, you can safely ignore this email. Someone else may have typed your address by mistake.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0;padding-top:20px;border-top:1px solid rgba(255,255,255,0.10);font-size:12px;line-height:1.5;color:#737373;text-align:center;">
                Sent by Knowra · AI document exploration
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOtpText(
  code: string,
  expiresMinutes: number,
  purpose: OtpPurpose = 'login',
): string {
  const line = otpEmailCopy(purpose).textLine(code);
  return [
    'Knowra — Ask. Explore. Understand.',
    '',
    line,
    `It expires in ${expiresMinutes} minutes.`,
    '',
    'If you didn’t request this code, you can ignore this email.',
  ].join('\n');
}

/** HTTPS email API — useful when SMTP ports are blocked on the host. */
async function sendViaResend(
  email: string,
  code: string,
  purpose: OtpPurpose,
): Promise<void> {
  const expiresMinutes = env.OTP_EXPIRY_MINUTES;
  const subject = otpEmailCopy(purpose).subject(code);
  const body = {
    from: env.SMTP_FROM,
    to: [email],
    subject,
    html: buildOtpEmailHtml(code, expiresMinutes, purpose),
    text: buildOtpText(code, expiresMinutes, purpose),
  };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error('Resend API error', response.status, errBody);
    throw new Error(`Resend failed: ${response.status}`);
  }
}

async function sendViaSmtp(
  email: string,
  code: string,
  purpose: OtpPurpose,
): Promise<void> {
  const expiresMinutes = env.OTP_EXPIRY_MINUTES;
  const subject = otpEmailCopy(purpose).subject(code);
  const info = await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject,
    text: buildOtpText(code, expiresMinutes, purpose),
    html: buildOtpEmailHtml(code, expiresMinutes, purpose),
  });

  if (!env.SMTP_HOST && env.NODE_ENV === 'development') {
    console.log('[dev] OTP email (no SMTP configured):', info.message?.toString?.() ?? info);
    console.log(`[dev] OTP (${purpose}) for ${email}: ${code}`);
  }
}

export async function sendOtpEmail(
  email: string,
  code: string,
  purpose: OtpPurpose = 'login',
): Promise<void> {
  try {
    if (env.RESEND_API_KEY) {
      await sendViaResend(email, code, purpose);
      return;
    }
    await sendViaSmtp(email, code, purpose);
  } catch (err) {
    console.error('Failed to send OTP email', err);
    throw new AppError(
      'Could not send verification email. Please try again in a moment.',
      502,
    );
  }
}

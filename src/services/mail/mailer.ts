import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

const LOGO_CID = 'knowra-logo';

let transporter: Transporter | null = null;
let cachedLogo: { path: string; content: Buffer } | null | undefined;

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

function getPublicLogoUrl(): string {
  const origin = env.CLIENT_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '') ?? '';
  return origin ? `${origin}/logo.png` : '';
}

function getLogoFile(): { path: string; content: Buffer } | null {
  if (cachedLogo !== undefined) return cachedLogo;

  const candidates = [
    path.join(process.cwd(), 'assets', 'logo.png'),
    path.join(process.cwd(), 'logo.png'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedLogo = { path: candidate, content: readFileSync(candidate) };
      return cachedLogo;
    }
  }

  cachedLogo = null;
  return null;
}

function buildOtpEmailHtml(code: string, expiresMinutes: number): string {
  const digits = code.split('').map(
    (d) =>
      `<td style="width:42px;height:52px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.14);border-radius:12px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:22px;font-weight:700;color:#f5f5f5;letter-spacing:0;">${d}</td>`,
  );

  const digitRow = digits.join(
    '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>',
  );

  const publicLogo = getPublicLogoUrl();
  const hasFileLogo = Boolean(getLogoFile());
  // Prefer hosted logo URL (works in most clients); CID when no public app origin.
  const logoSrc = publicLogo || (hasFileLogo ? `cid:${LOGO_CID}` : '');

  const logoCell = logoSrc
    ? `<img src="${logoSrc}" alt="Knowra" width="40" height="40" style="display:block;width:40px;height:40px;border-radius:10px;border:0;" />`
    : `<span style="display:inline-block;width:40px;height:40px;background:#f5f0e8;border-radius:10px;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;color:#0a0a0a;line-height:40px;">K</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>Knowra sign-in code</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    Your Knowra sign-in code is ${code}. Expires in ${expiresMinutes} minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#141414;border:1px solid rgba(255,255,255,0.12);border-radius:22px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid rgba(255,255,255,0.10);">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    ${logoCell}
                  </td>
                  <td style="width:12px;font-size:0;">&nbsp;</td>
                  <td style="vertical-align:middle;">
                    <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#f5f5f5;letter-spacing:-0.02em;line-height:1.1;">Knowra</p>
                    <p style="margin:4px 0 0;font-size:12px;color:#a3a3a3;letter-spacing:0.01em;">Ask. Explore. Understand.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 10px;font-size:22px;font-weight:600;color:#f5f5f5;line-height:1.3;letter-spacing:-0.01em;">Your sign-in code</h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#a3a3a3;">
                Use this one-time code to sign in to Knowra. It expires in
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

function buildOtpText(code: string, expiresMinutes: number): string {
  return [
    'Knowra — Ask. Explore. Understand.',
    '',
    `Your sign-in code is ${code}.`,
    `It expires in ${expiresMinutes} minutes.`,
    '',
    'If you didn’t request this code, you can ignore this email.',
  ].join('\n');
}

function logoAttachment() {
  const logo = getLogoFile();
  if (!logo) return null;
  return {
    filename: 'logo.png',
    content: logo.content,
    contentType: 'image/png',
    cid: LOGO_CID,
    contentDisposition: 'inline' as const,
  };
}

/** HTTPS email API — works on Render free (SMTP ports are blocked). */
async function sendViaResend(email: string, code: string): Promise<void> {
  const expiresMinutes = env.OTP_EXPIRY_MINUTES;
  const logo = getLogoFile();
  const body: Record<string, unknown> = {
    from: env.SMTP_FROM,
    to: [email],
    subject: `${code} is your Knowra sign-in code`,
    html: buildOtpEmailHtml(code, expiresMinutes),
    text: buildOtpText(code, expiresMinutes),
  };

  if (logo) {
    body.attachments = [
      {
        filename: 'logo.png',
        content: logo.content.toString('base64'),
        content_id: LOGO_CID,
        content_type: 'image/png',
      },
    ];
  }

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

async function sendViaSmtp(email: string, code: string): Promise<void> {
  const expiresMinutes = env.OTP_EXPIRY_MINUTES;
  const attachment = logoAttachment();
  const info = await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject: `${code} is your Knowra sign-in code`,
    text: buildOtpText(code, expiresMinutes),
    html: buildOtpEmailHtml(code, expiresMinutes),
    attachments: attachment ? [attachment] : undefined,
  });

  if (!env.SMTP_HOST && env.NODE_ENV === 'development') {
    console.log('[dev] OTP email (no SMTP configured):', info.message?.toString?.() ?? info);
    console.log(`[dev] OTP for ${email}: ${code}`);
  }
}

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  try {
    if (env.RESEND_API_KEY) {
      await sendViaResend(email, code);
      return;
    }
    await sendViaSmtp(email, code);
  } catch (err) {
    console.error('Failed to send OTP email', err);
    throw new AppError(
      'Could not send verification email. Please try again in a moment.',
      502,
    );
  }
}

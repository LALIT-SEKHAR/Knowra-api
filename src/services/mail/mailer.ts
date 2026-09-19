import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      jsonTransport: true,
    });
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER
      ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        }
      : undefined,
  });

  return transporter;
}

function buildOtpEmailHtml(code: string, expiresMinutes: number): string {
  const digits = code.split('').map(
    (d) =>
      `<td style="width:42px;height:52px;background:#1a1a1a;border:1px solid rgba(255,255,255,0.14);border-radius:12px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:22px;font-weight:700;color:#f5f5f5;letter-spacing:0;">${d}</td>`,
  );

  const digitRow = digits.join(
    '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>',
  );

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
  <!-- Preheader -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    Your Knowra sign-in code is ${code}. Expires in ${expiresMinutes} minutes.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#141414;border:1px solid rgba(255,255,255,0.12);border-radius:22px;overflow:hidden;">
          <!-- Brand header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid rgba(255,255,255,0.10);">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="width:36px;height:36px;background:#f5f5f5;border-radius:10px;text-align:center;vertical-align:middle;">
                    <span style="font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:700;color:#0a0a0a;line-height:36px;">K</span>
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

          <!-- Body -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 10px;font-size:22px;font-weight:600;color:#f5f5f5;line-height:1.3;letter-spacing:-0.01em;">Your sign-in code</h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.55;color:#a3a3a3;">
                Use this one-time code to sign in to Knowra. It expires in
                <strong style="color:#f5f5f5;">${expiresMinutes} minutes</strong>.
              </p>

              <!-- Digit cards -->
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

              <!-- Notice -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1a1a1a;border:1px solid rgba(255,255,255,0.10);border-radius:14px;">
                <tr>
                  <td style="padding:14px 16px;font-size:13px;line-height:1.55;color:#a3a3a3;">
                    If you didn’t request this code, you can safely ignore this email. Someone else may have typed your address by mistake.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
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

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const expiresMinutes = env.OTP_EXPIRY_MINUTES;
  const info = await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: email,
    subject: `${code} is your Knowra sign-in code`,
    text: [
      'Knowra — Ask. Explore. Understand.',
      '',
      `Your sign-in code is ${code}.`,
      `It expires in ${expiresMinutes} minutes.`,
      '',
      'If you didn’t request this code, you can ignore this email.',
    ].join('\n'),
    html: buildOtpEmailHtml(code, expiresMinutes),
  });

  if (!env.SMTP_HOST && env.NODE_ENV === 'development') {
    console.log('[dev] OTP email (no SMTP configured):', info.message?.toString?.() ?? info);
    console.log(`[dev] OTP for ${email}: ${code}`);
  }
}

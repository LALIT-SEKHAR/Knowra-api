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
      `<td style="width:40px;height:48px;background:#ffffff;border:1px solid #d8d2c4;border-radius:8px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:22px;font-weight:700;color:#14201b;letter-spacing:0;">${d}</td>`,
  );

  const digitRow = digits.join(
    '<td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>',
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>Knowra sign-in code</title>
</head>
<body style="margin:0;padding:0;background:#e8e4da;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e4da;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#faf8f3;border:1px solid #d8d2c4;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:#0f6e56;padding:28px 32px;">
              <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#faf8f3;letter-spacing:-0.02em;">Knowra</p>
              <p style="margin:6px 0 0;font-size:13px;color:#d8efe6;">Ask. Explore. Understand.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#14201b;line-height:1.3;">Your sign-in code</h1>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#4a5c54;">
                Use this one-time code to sign in to Knowra. It expires in
                <strong style="color:#14201b;">${expiresMinutes} minutes</strong>.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
                <tr>
                  ${digitRow}
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#4a5c54;text-align:center;">
                Or enter this code manually:
              </p>
              <p style="margin:0 0 28px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:0.35em;color:#0f6e56;">
                ${code}
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#d8efe6;border-radius:10px;">
                <tr>
                  <td style="padding:14px 16px;font-size:13px;line-height:1.5;color:#14201b;">
                    If you didn’t request this code, you can safely ignore this email. Someone else may have typed your address by mistake.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0;padding-top:20px;border-top:1px solid #d8d2c4;font-size:12px;line-height:1.5;color:#4a5c54;text-align:center;">
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

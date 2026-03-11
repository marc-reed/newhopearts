const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
});

const getClientIp = (event) => {
  const forwardedFor = event.headers?.['x-forwarded-for'] || event.headers?.['X-Forwarded-For'];
  if (!forwardedFor) return '';

  return forwardedFor.split(',')[0].trim();
};

const escapeHtml = (value) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isValidEmail = (value) => {
  if (typeof value !== 'string') return false;
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue);
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  }

  if (!process.env.CAPTCHA_SECRET_KEY) {
    return jsonResponse(500, { ok: false, message: 'CAPTCHA secret key is missing.' });
  }

  if (!process.env.SMTP2GO_API_KEY) {
    return jsonResponse(500, { ok: false, message: 'SMTP2GO API key is missing.' });
  }

  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { ok: false, message: 'Invalid request payload.' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const comments = typeof body.comments === 'string' ? body.comments.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const state = typeof body.state === 'string' ? body.state.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const rawSubject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const formType = typeof body.formType === 'string' ? body.formType.trim().toLowerCase() : '';
  const recaptchaToken = typeof body.recaptchaToken === 'string' ? body.recaptchaToken.trim() : '';

  if (!name || !email || !comments) {
    return jsonResponse(400, { ok: false, message: 'Please fill out required fields.' });
  }

  if (!recaptchaToken) {
    return jsonResponse(400, { ok: false, message: 'Missing reCAPTCHA token.' });
  }

  const verificationRequestBody = new URLSearchParams({
    secret: process.env.CAPTCHA_SECRET_KEY,
    response: recaptchaToken,
    remoteip: getClientIp(event)
  });

  let captchaResult;

  try {
    const verificationResponse = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: verificationRequestBody.toString()
    });

    captchaResult = await verificationResponse.json();
  } catch {
    return jsonResponse(502, { ok: false, message: 'Unable to verify reCAPTCHA right now.' });
  }

  const minimumScore = Number(process.env.CAPTCHA_MIN_SCORE || 0.5);
  const isValidAction = captchaResult.action === 'mail_form_submit';
  const isValidScore = typeof captchaResult.score === 'number' && captchaResult.score >= minimumScore;

  if (!captchaResult.success || !isValidAction || !isValidScore) {
    return jsonResponse(403, {
      ok: false,
      message: 'reCAPTCHA check failed. Please try again.',
      details: {
        action: captchaResult.action,
        score: captchaResult.score,
        errors: captchaResult['error-codes']
      }
    });
  }

  if (formType === 'waystogive' && !process.env.SMTP2GO_WAYSTOGIVE_EMAIL) {
    return jsonResponse(500, {
      ok: false,
      message: 'Recipient email for this form is not configured.'
    });
  }

  const receiver =
    (formType === 'waystogive' ? process.env.SMTP2GO_WAYSTOGIVE_EMAIL : '') ||
    process.env.SMTP2GO_RECEIVER_EMAIL ||
    'marc@marcreed.com';

  const sender = process.env.SMTP2GO_SENDER_EMAIL || 'no-reply@newhopearts.org';
  const subject = rawSubject || 'Contact Form';
  const textBody = [
    `${subject}`,
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone || '(not provided)'}`,
    `City: ${city || '(not provided)'}`,
    `State: ${state || '(not provided)'}`,
    '',
    'Comments:',
    comments
  ].join('\n');

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone || '(not provided)');
  const safeCity = escapeHtml(city || '(not provided)');
  const safeState = escapeHtml(state || '(not provided)');
  const safeComments = escapeHtml(comments).replace(/\n/g, '<br>');
  const replyToValue = isValidEmail(email) ? email : sender;

  const htmlBody = `
    <h2>${subject} form submission</h2>
    <p><strong>Name:</strong> ${safeName}</p>
    <p><strong>Email:</strong> ${safeEmail}</p>
    <p><strong>Phone:</strong> ${safePhone}</p>
    <p><strong>City:</strong> ${safeCity}</p>
    <p><strong>State:</strong> ${safeState}</p>
    <p><strong>Comments:</strong></p>
    <p>${safeComments}</p>
  `;

  const smtpPayload = {
    api_key: process.env.SMTP2GO_API_KEY,
    sender,
    to: [receiver],
    subject,
    text_body: textBody,
    html_body: htmlBody,
    custom_headers: [
      {
        header: 'Reply-To',
        value: replyToValue
      }
    ]
  };

  let smtpResponseBody;

  try {
    const smtpResponse = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(smtpPayload)
    });

    smtpResponseBody = await smtpResponse.json();

    const emailAccepted = smtpResponse.ok && smtpResponseBody?.data?.succeeded > 0;
    if (!emailAccepted) {
      return jsonResponse(502, {
        ok: false,
        message: 'Could not send email right now. Please try again.'
      });
    }
  } catch {
    return jsonResponse(502, {
      ok: false,
      message: 'Could not send email right now. Please try again.'
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: 'Message sent successfully. Thank you!'
  });
};

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

const isValidEmail = (value) => {
  if (typeof value !== 'string') return false;
  const trimmedValue = value.trim();
  if (!trimmedValue || trimmedValue.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedValue);
};

const getEnvValue = (key, fallback = '') => {
  const value = process.env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

let cachedAccessToken = '';
let cachedAccessTokenExpiresAt = 0;

const getConstantContactAccessToken = async ({ clientId, clientSecret, refreshToken }) => {
  const now = Date.now();
  const refreshBufferMs = 60 * 1000;

  if (cachedAccessToken && cachedAccessTokenExpiresAt - refreshBufferMs > now) {
    return cachedAccessToken;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const requestBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const tokenResponse = await fetch('https://authz.constantcontact.com/oauth2/default/v1/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: requestBody.toString()
  });

  const tokenPayload = await tokenResponse.json().catch(() => ({}));

  if (!tokenResponse.ok || !tokenPayload?.access_token) {
    throw new Error('Unable to refresh Constant Contact access token.');
  }

  const expiresInSeconds = Number(tokenPayload.expires_in || 0);
  cachedAccessToken = tokenPayload.access_token;
  cachedAccessTokenExpiresAt = now + (Number.isFinite(expiresInSeconds) ? expiresInSeconds * 1000 : 0);

  if (tokenPayload.refresh_token && tokenPayload.refresh_token !== refreshToken) {
    console.warn('Constant Contact returned a new refresh token. Update CC_REFRESH_TOKEN in environment variables.');
  }

  return cachedAccessToken;
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, message: 'Method not allowed.' });
  }

  if (!process.env.CAPTCHA_SECRET_KEY) {
    return jsonResponse(500, { ok: false, message: 'CAPTCHA secret key is missing.' });
  }

  const constantContactClientId = getEnvValue('CC_CLIENT_ID', 'ff5ce0f9-e3d2-4518-8af9-f500f6c528ca');
  const constantContactClientSecret = getEnvValue('CC_CLIENT_SECRET');
  const constantContactRefreshToken = getEnvValue('CC_REFRESH_TOKEN');
  if (!constantContactClientSecret || !constantContactRefreshToken) {
    return jsonResponse(500, {
      ok: false,
      message: 'Constant Contact credentials are missing.'
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { ok: false, message: 'Invalid request payload.' });
  }

  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const listId = typeof body.listId === 'string' ? body.listId.trim() : '';
  const recaptchaToken = typeof body.recaptchaToken === 'string' ? body.recaptchaToken.trim() : '';

  if (!firstName || !lastName || !email || !listId) {
    return jsonResponse(400, {
      ok: false,
      message: 'Please fill out First Name, Last Name, Email, and list id.'
    });
  }

  if (!isValidEmail(email)) {
    return jsonResponse(400, {
      ok: false,
      message: 'Please enter a valid email address.'
    });
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
  const isValidAction = captchaResult.action === 'join_mailing_list_submit';
  const isValidScore = typeof captchaResult.score === 'number' && captchaResult.score >= minimumScore;

  if (!captchaResult.success || !isValidAction || !isValidScore) {
    return jsonResponse(403, {
      ok: false,
      message: 'reCAPTCHA check failed. Please try again.'
    });
  }

  const payload = {
    email_address: email,
    first_name: firstName,
    last_name: lastName,
    list_memberships: [listId]
  };

  const fallbackPayload = {
    email_address: {
      address: email,
      permission_to_send: 'implicit'
    },
    first_name: firstName,
    last_name: lastName,
    list_memberships: [listId]
  };

  let constantContactAccessToken;

  try {
    constantContactAccessToken = await getConstantContactAccessToken({
      clientId: constantContactClientId,
      clientSecret: constantContactClientSecret,
      refreshToken: constantContactRefreshToken
    });
  } catch {
    return jsonResponse(502, {
      ok: false,
      message: 'Unable to authorize with Constant Contact. Please try again.'
    });
  }

  let ccResponse;

  try {
    ccResponse = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${constantContactAccessToken}`,
        'x-api-key': constantContactClientId
      },
      body: JSON.stringify(payload)
    });

    if (!ccResponse.ok) {
      const firstErrorBody = await ccResponse.json().catch(() => ({}));
      const isEmailValidationError =
        Array.isArray(firstErrorBody) &&
        firstErrorBody.some(
          (item) =>
            item &&
            item.error_key === 'contacts.api.validation.error' &&
            typeof item.error_message === 'string' &&
            item.error_message.toLowerCase().includes('email_address')
        );

      if (isEmailValidationError) {
        ccResponse = await fetch('https://api.cc.email/v3/contacts/sign_up_form', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${constantContactAccessToken}`,
            'x-api-key': constantContactClientId
          },
          body: JSON.stringify(fallbackPayload)
        });
      } else {
        return jsonResponse(ccResponse.status || 502, {
          ok: false,
          message: 'Unable to add contact to mailing list.',
          details: firstErrorBody
        });
      }
    }
  } catch {
    return jsonResponse(502, {
      ok: false,
      message: 'Could not reach Constant Contact. Please try again.'
    });
  }

  if (!ccResponse.ok) {
    const errorBody = await ccResponse.json().catch(() => ({}));
    return jsonResponse(ccResponse.status || 502, {
      ok: false,
      message: 'Unable to add contact to mailing list.',
      details: errorBody
    });
  }

  return jsonResponse(200, {
    ok: true,
    message: 'You have been added to the mailing list.'
  });
};

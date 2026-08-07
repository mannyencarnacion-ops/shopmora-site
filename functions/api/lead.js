/**
 * ShopMora lead handler — Cloudflare Pages Function
 * Route: /api/lead (both site forms POST here)
 *
 * Replaces FormSubmit, which returned a cheerful "Thanks!" page while silently
 * discarding leads. The rule here is simple: NEVER fake success. Every failure
 * returns a real error page, sets an X-Lead-Error header, and logs. A lost lead
 * must be loud.
 *
 * Delivery: Resend, and only Resend.
 *
 *   2026-08-07 — the FormSubmit fallback was REMOVED, and the reason matters.
 *   The old code fell back to FormSubmit whenever RESEND_API_KEY was unset, and
 *   the selftest route ALWAYS exercised FormSubmit regardless of which provider
 *   production actually used. So `?selftest=1` reported "FormSubmit refused"
 *   on a site whose real leads were delivering through Resend perfectly well.
 *   A diagnostic that tests a path production does not use is worse than no
 *   diagnostic: it manufactures false alarms and hides real ones. There is now
 *   exactly one delivery path, and the selftest exercises that same path.
 *
 * !! Cloudflare edge trap: a Pages Function returning any 5xx has its body and
 * headers REPLACED by Cloudflare's own generic error page. Our branded error
 * page and X-Lead-Error header both vanish — the exact opposite of failing
 * loudly. So backend failures return 424 (Failed Dependency): 4xx passes
 * through untouched, and it honestly means "our upstream mail provider failed".
 * Never use 5xx here.
 *
 * Env (Cloudflare Pages > Settings > Variables and secrets) — ALL THREE REQUIRED.
 * Env binds only on a new build, so redeploy after changing any of them:
 *   RESEND_API_KEY (Secret), LEAD_TO, LEAD_FROM
 */

const ORIGIN = 'https://shopmorastore.com';

const FORMS = {
  audit: {
    subject: 'New audit request from the /audit landing page',
    thankYou: '/thank-you',
    required: ['name', 'email', 'website'],
    autoSubject: 'We got your audit request - ShopMora',
    autoBody: (d) =>
      'Hi ' + d.name + ',\n\n' +
      "Thanks for requesting a free website & SEO audit. I've got your details and I'm reviewing " +
      d.website + ' by hand - the site itself, your search rankings, and your Google presence.\n\n' +
      "You'll have your audit within 2 business days. No pitch attached: it's yours to keep " +
      'whether we work together or not.\n\n- Manny, ShopMora\nshopmorastore.com'
  },
  contact: {
    subject: 'New contact form message from shopmorastore.com',
    thankYou: '/contact-thank-you',
    required: ['name', 'email', 'message'],
    autoSubject: 'We got your message - ShopMora',
    autoBody: (d) =>
      'Hi ' + d.name + ',\n\n' +
      "Thanks for reaching out to ShopMora. We've got your message and we'll review your " +
      'website, SEO, and social presence.\n\n' +
      'Expect a reply within one business day - from a real person, not a template.\n\n' +
      '- Manny, ShopMora\nshopmorastore.com'
  }
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s == null ? '' : s).trim());
}

function errorPage(msg, status, detail) {
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Something went wrong - ShopMora</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Lato:wght@400;700&display=swap" rel="stylesheet">' +
    '<style>body{font-family:Lato,system-ui,sans-serif;background:#ede4d8;color:#2a170a;' +
    'display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;line-height:1.6}' +
    '.box{max-width:520px;text-align:center}h1{font-family:"Cormorant Garamond",Georgia,serif;' +
    'font-size:2.4rem;margin:0 0 12px;line-height:1.1}p{color:#5a4636;margin:0 0 22px}' +
    'a.btn{display:inline-block;background:#2a170a;color:#ede4d8;padding:14px 28px;' +
    'border-radius:6px;text-decoration:none;font-weight:700}' +
    'a.inline{color:#9b5c38;font-weight:700}</style></head><body><div class="box">' +
    '<h1>That didn&rsquo;t send.</h1><p>' + esc(msg) + '</p>' +
    '<p>Nothing reached us, so please email <a class="inline" href="mailto:manny.encarnacion@shopmorastore.com">' +
    'manny.encarnacion@shopmorastore.com</a> or call <strong>508-966-8309</strong> ' +
    'and we&rsquo;ll pick it up from there.</p>' +
    '<a class="btn" href="' + ORIGIN + '/audit">Back to the form</a></div></body></html>';

  const headers = { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' };
  if (detail) {
    headers['X-Lead-Error'] = String(detail).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }
  return new Response(html, { status: status, headers: headers });
}

function redirectTo(path) {
  return new Response(null, {
    status: 303,
    headers: { Location: ORIGIN + path, 'Cache-Control': 'no-store' }
  });
}

/** Which env vars are missing. Names only — never the values. */
function missingEnv(env) {
  return ['RESEND_API_KEY', 'LEAD_TO', 'LEAD_FROM'].filter(function (k) {
    return !String(env[k] == null ? '' : env[k]).trim();
  });
}

async function sendViaResend(env, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + text.slice(0, 200));
  return text;
}

export async function onRequestPost(context) {
  // Top-level guard: nothing escapes as an opaque platform 502.
  try {
    const request = context.request;
    const env = context.env || {};

    // No provider, no silent fallback. Fail loudly and show the human a phone number.
    const missingVars = missingEnv(env);
    if (missingVars.length) {
      return errorPage(
        'Our form is misconfigured on our end.',
        424,
        'missing env: ' + missingVars.join(', ')
      );
    }

    let data;
    try {
      const ct = request.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        data = await request.json();
      } else {
        data = Object.fromEntries(await request.formData());
      }
    } catch (e) {
      return errorPage('We could not read that submission.', 400, 'parse: ' + e.message);
    }

    const form = FORMS[data._form] || FORMS.contact;

    const missing = form.required.filter(function (f) {
      return !String(data[f] == null ? '' : data[f]).trim();
    });
    if (missing.length) {
      return errorPage('Please fill in: ' + missing.join(', ') + '.', 400, 'missing: ' + missing.join(','));
    }
    if (!isEmail(data.email)) {
      return errorPage('That email address does not look right.', 400, 'bad email');
    }

    const clean = {};
    Object.keys(data).forEach(function (k) {
      if (k.charAt(0) !== '_') clean[k] = data[k];
    });

    // --- the notification IS the lead ---
    try {
      const rows = Object.keys(clean).map(function (k) {
        return '<tr><td style="padding:8px 14px;border:1px solid #ddd0c0;font-weight:700;text-transform:capitalize">' +
          esc(k) + '</td><td style="padding:8px 14px;border:1px solid #ddd0c0">' + esc(clean[k]) + '</td></tr>';
      }).join('');
      await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [env.LEAD_TO],
        reply_to: String(data.email).trim(),
        subject: form.subject,
        html: '<div style="font-family:system-ui,sans-serif;color:#2a170a">' +
          '<h2>New ' + esc(data._form || 'contact') + ' lead</h2>' +
          '<table style="border-collapse:collapse;margin:16px 0">' + rows + '</table>' +
          '<p style="color:#5a4636;font-size:12px">' + esc(new Date().toISOString()) + '</p></div>'
      });
    } catch (e) {
      console.error('lead: NOTIFICATION FAILED', e && e.message);
      return errorPage('We could not deliver your message just now.', 424, e && e.message);
    }

    // --- autoresponse: courtesy only, never blocks the lead ---
    try {
      await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [String(data.email).trim()],
        reply_to: env.LEAD_TO,
        subject: form.autoSubject,
        text: form.autoBody(data)
      });
    } catch (e) {
      console.error('lead: AUTORESPONSE FAILED (lead still captured)', e && e.message);
    }

    return redirectTo(form.thankYou);
  } catch (e) {
    console.error('lead: UNHANDLED', e && e.stack);
    return errorPage('Something broke on our end.', 424, 'unhandled: ' + (e && e.message));
  }
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);

  // /api/lead?selftest=1 — exercises THE SAME delivery path production uses and
  // reports the raw upstream result as plain text. Diagnosable without digging
  // through logs, and it cannot pass while real leads fail, or fail while they work.
  if (url.searchParams.get('selftest') === '1') {
    const env = context.env || {};
    const started = Date.now();

    const missingVars = missingEnv(env);
    if (missingVars.length) {
      return new Response(
        'SELFTEST FAILED: missing env vars: ' + missingVars.join(', ') + '\n' +
        'Set them in Cloudflare Pages > Settings > Variables and secrets, then REDEPLOY.\n' +
        'Env binds only on a new build.',
        { status: 424, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }
      );
    }

    try {
      const raw = await sendViaResend(env, {
        from: env.LEAD_FROM,
        to: [env.LEAD_TO],
        subject: 'ShopMora selftest (/api/lead?selftest=1)',
        text:
          'This is the /api/lead selftest. It used the same Resend path a real lead uses.\n' +
          'If you are reading this in your inbox, lead delivery is working end to end.\n' +
          'Sent ' + new Date().toISOString()
      });
      return new Response(
        'SELFTEST OK in ' + (Date.now() - started) + 'ms\n' +
        'provider: resend\n' +
        'to: ' + env.LEAD_TO + '\n' +
        raw,
        { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }
      );
    } catch (e) {
      return new Response(
        'SELFTEST FAILED after ' + (Date.now() - started) + 'ms\n' +
        'provider: resend\n' +
        (e && e.message),
        { status: 424, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }
      );
    }
  }

  return new Response('ShopMora lead endpoint is alive. POST only.', {
    status: 405,
    headers: { 'Content-Type': 'text/plain', Allow: 'POST' }
  });
}

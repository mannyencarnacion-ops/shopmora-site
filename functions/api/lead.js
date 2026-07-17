/**
 * ShopMora lead handler — Cloudflare Pages Function
 * Route: POST /api/lead   (both site forms post here)
 *
 * Replaces FormSubmit, which silently dropped leads while returning a
 * success page. Design rule here: NEVER fake success. If mail fails, the
 * user sees an error and we log it. A lost lead must be loud.
 *
 * Required env vars (Cloudflare Pages > Settings > Variables):
 *   RESEND_API_KEY  - secret, from resend.com
 *   LEAD_TO         - where notifications go (manny.encarnacion@shopmorastore.com)
 *   LEAD_FROM       - verified Resend sender, e.g. "ShopMora <leads@send.shopmorastore.com>"
 */

const ORIGIN = 'https://shopmorastore.com';

const FORMS = {
  audit: {
    subject: 'New audit request from the /audit landing page',
    thankYou: '/thank-you',
    required: ['name', 'email', 'website'],
    autoSubject: 'We got your audit request — ShopMora',
    autoBody: (d) =>
      `Hi ${d.name},\n\n` +
      `Thanks for requesting a free website & SEO audit. I've got your details and I'm reviewing ` +
      `${d.website} by hand — the site itself, your search rankings, and your Google presence.\n\n` +
      `You'll have your audit within 2 business days. No pitch attached: it's yours to keep whether ` +
      `we work together or not.\n\n` +
      `— Manny, ShopMora\nshopmorastore.com`
  },
  contact: {
    subject: 'New contact form message from shopmorastore.com',
    thankYou: '/contact-thank-you',
    required: ['name', 'email', 'message'],
    autoSubject: 'We got your message — ShopMora',
    autoBody: (d) =>
      `Hi ${d.name},\n\n` +
      `Thanks for reaching out to ShopMora. We've got your message and we'll review your website, ` +
      `SEO, and social presence.\n\n` +
      `Expect a reply within one business day — from a real person, not a template.\n\n` +
      `— Manny, ShopMora\nshopmorastore.com`
  }
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

function errorPage(msg, status) {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Something went wrong — ShopMora</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>
body{font-family:Lato,system-ui,sans-serif;background:#ede4d8;color:#2a170a;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;line-height:1.6}
.box{max-width:520px;text-align:center}
h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:2.4rem;margin:0 0 12px;line-height:1.1}
p{color:#5a4636;margin:0 0 22px}
a{display:inline-block;background:#2a170a;color:#ede4d8;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700}
code{background:#f6efe6;padding:2px 6px;border-radius:4px;font-size:.85rem}
</style></head><body><div class="box">
<h1>That didn&rsquo;t send.</h1>
<p>${esc(msg)}</p>
<p>Nothing was lost on your end — but nothing reached us either, so please email
<a href="mailto:manny.encarnacion@shopmorastore.com" style="background:none;color:#9b5c38;padding:0;text-decoration:underline;font-weight:700">manny.encarnacion@shopmorastore.com</a>
or call <strong>508-966-8309</strong> and we&rsquo;ll pick it up from there.</p>
<a href="${ORIGIN}/audit">Back to the form</a>
</div></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
}

async function sendMail(env, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text || '{}');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Fail loudly on misconfiguration rather than pretending to succeed.
  for (const k of ['RESEND_API_KEY', 'LEAD_TO', 'LEAD_FROM']) {
    if (!env[k]) {
      console.error(`lead: missing env var ${k}`);
      return errorPage('Our form is misconfigured on our end. This is our fault, not yours.', 500);
    }
  }

  let data;
  try {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await request.json();
    } else {
      data = Object.fromEntries(await request.formData());
    }
  } catch (err) {
    return errorPage('We could not read that submission.', 400);
  }

  const form = FORMS[data._form] || FORMS.contact;

  // Validation — reject clearly instead of silently binning.
  const missing = form.required.filter((f) => !String(data[f] || '').trim());
  if (missing.length) return errorPage(`Please fill in: ${missing.join(', ')}.`, 400);
  if (!isEmail(data.email)) return errorPage('That email address does not look right.', 400);

  const rows = Object.entries(data)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `<tr><td style="padding:8px 14px;border:1px solid #ddd0c0;font-weight:700;text-transform:capitalize">${esc(k)}</td><td style="padding:8px 14px;border:1px solid #ddd0c0">${esc(v)}</td></tr>`)
    .join('');

  const meta = {
    page: data._form || 'contact',
    ip: request.headers.get('cf-connecting-ip') || 'unknown',
    country: request.cf?.country || 'unknown',
    at: new Date().toISOString()
  };

  const notify = {
    from: env.LEAD_FROM,
    to: [env.LEAD_TO],
    reply_to: String(data.email).trim(),
    subject: form.subject,
    html: `<div style="font-family:system-ui,sans-serif;color:#2a170a">
      <h2 style="font-family:Georgia,serif">New ${esc(meta.page)} lead</h2>
      <table style="border-collapse:collapse;margin:16px 0">${rows}</table>
      <p style="color:#5a4636;font-size:12px">${esc(meta.at)} · ${esc(meta.country)} · ${esc(meta.ip)}</p>
    </div>`
  };

  // The notification is the lead. If it fails, tell the user.
  try {
    await sendMail(env, notify);
  } catch (err) {
    console.error('lead: notification failed', err.message);
    return errorPage('We could not deliver your message just now.', 502);
  }

  // The autoresponse is a courtesy. If it fails, still count the lead —
  // but log it loudly so it gets noticed.
  try {
    await sendMail(env, {
      from: env.LEAD_FROM,
      to: [String(data.email).trim()],
      reply_to: env.LEAD_TO,
      subject: form.autoSubject,
      text: form.autoBody(data)
    });
  } catch (err) {
    console.error('lead: AUTORESPONSE FAILED (lead still captured)', err.message);
  }

  return Response.redirect(ORIGIN + form.thankYou, 303);
}

// A GET to /api/lead should not 404 silently — make it obvious it's alive.
export async function onRequestGet() {
  return new Response('ShopMora lead endpoint is alive. POST only.', {
    status: 405,
    headers: { 'Content-Type': 'text/plain', Allow: 'POST' }
  });
}

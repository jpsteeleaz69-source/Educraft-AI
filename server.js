// EduCraft AI — Backend Server
// Stack: Node.js + Express + Supabase (auth/db) + Stripe + Anthropic API
// Run: npm install && node server.js

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL }));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── MIDDLEWARE: Verify Supabase JWT ──────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ── MIDDLEWARE: Check plan limits ─────────────────────────────────────────────
async function checkPlanLimit(req, res, next) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, plans_used, plans_reset_at')
    .eq('id', req.user.id)
    .single();

  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Pro/School users have unlimited generation
  if (profile.plan === 'pro' || profile.plan === 'school') {
    req.profile = profile;
    return next();
  }

  // Free trial: 10 plans total
  if (profile.plans_used >= 10) {
    return res.status(403).json({
      error: 'Plan limit reached',
      message: 'You have used all 10 free lesson plans. Upgrade to Pro for unlimited generation.',
      upgradeUrl: `${process.env.FRONTEND_URL}/upgrade`
    });
  }

  req.profile = profile;
  next();
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });

  // Create profile + start 14-day trial
  await supabase.from('profiles').insert({
    id: data.user.id,
    name,
    email,
    plan: 'trial',
    plans_used: 0,
    trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
  });

  res.json({ user: data.user, session: data.session });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ user: data.user, session: data.session });
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  res.json({ user: req.user, profile });
});

// ── STANDARDS ROUTES ──────────────────────────────────────────────────────────

// GET /api/standards?state=Texas&subject=Mathematics&grade=Grade+5
// In production: connect to a real standards API (e.g. Academic Benchmarks, Common Core API)
app.get('/api/standards', requireAuth, async (req, res) => {
  const { state, subject, grade } = req.query;
  if (!state || !subject || !grade) {
    return res.status(400).json({ error: 'state, subject, and grade are required' });
  }

  // Check cache first
  const cacheKey = `${state}:${subject}:${grade}`;
  const { data: cached } = await supabase
    .from('standards_cache')
    .select('standards, updated_at')
    .eq('cache_key', cacheKey)
    .single();

  // Return cache if fresh (< 30 days old)
  if (cached && new Date(cached.updated_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)) {
    return res.json({ standards: cached.standards, source: 'cache' });
  }

  // Fetch from Academic Benchmarks API (or use built-in dataset)
  // In production replace this with: await fetchFromAcademicBenchmarks(state, subject, grade)
  const standards = await generateStandardsWithAI(state, subject, grade);

  // Cache the result
  await supabase.from('standards_cache').upsert({
    cache_key: cacheKey,
    state, subject, grade,
    standards,
    updated_at: new Date().toISOString()
  });

  res.json({ standards, source: 'generated' });
});

async function generateStandardsWithAI(state, subject, grade) {
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Generate 8 realistic, specific academic standards for:
State: ${state}
Subject: ${subject}
Grade: ${grade}

Return ONLY a JSON array. Each object: { "code": "standard code", "text": "full standard description" }
Base these on actual Common Core, NGSS, TEKS, or state frameworks. Be specific and accurate.`
    }]
  });
  const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── LESSON GENERATION ROUTE ───────────────────────────────────────────────────

// POST /api/generate
app.post('/api/generate', requireAuth, checkPlanLimit, async (req, res) => {
  const { standard, bloomLevels, plansPerLevel, subject, grade, state, classLevel } = req.body;

  if (!standard || !bloomLevels?.length) {
    return res.status(400).json({ error: 'standard and bloomLevels are required' });
  }

  const total = bloomLevels.length * plansPerLevel;
  const diffLabel = {
    mixed: 'a mixed ability classroom',
    below: 'students who are below grade level',
    on: 'students on grade level',
    above: 'gifted and above-grade-level students',
    ell: 'English language learners',
    sped: 'students with IEPs and special learning needs'
  }[classLevel] || 'a mixed ability classroom';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are an expert curriculum designer. Generate ${plansPerLevel} lesson plan(s) for EACH Bloom's level: ${bloomLevels.join(', ')}.

STANDARD: ${standard.code} — ${standard.text}
SUBJECT: ${subject} | GRADE: ${grade} | STATE: ${state}
TARGET STUDENTS: ${diffLabel}

Return ONLY a JSON array. Each object:
{
  "bloomLevel": "level",
  "title": "creative title",
  "duration": "e.g. 50 minutes",
  "objective": "measurable objective with Bloom's verb",
  "gradeAdaptation": "how this is adapted for ${diffLabel}",
  "warmUp": "engaging warm-up description",
  "mainActivity": "detailed main activity description",
  "materials": ["item1", "item2", "item3", "item4"],
  "assessment": "how student mastery is measured",
  "differentiation": "tip for supporting struggling learners",
  "extension": "extension activity for advanced students",
  "bloomRationale": "why this targets the Bloom's level"
}

Generate exactly ${plansPerLevel} plan(s) × ${bloomLevels.length} levels = ${total} total. Return ONLY JSON.`
      }]
    });

    const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
    const plans = JSON.parse(raw);

    // Increment usage counter
    await supabase.from('profiles')
      .update({ plans_used: supabase.raw(`plans_used + ${plans.length}`) })
      .eq('id', req.user.id);

    // Save to lesson history
    await supabase.from('lessons').insert(plans.map(p => ({
      user_id: req.user.id,
      standard_code: standard.code,
      standard_text: standard.text,
      subject, grade, state,
      bloom_level: p.bloomLevel,
      title: p.title,
      plan_json: p,
      created_at: new Date().toISOString()
    })));

    res.json({ plans, plansGenerated: plans.length });

  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({ error: 'Failed to generate lesson plans. Please try again.' });
  }
});

// ── LIBRARY ROUTES ─────────────────────────────────────────────────────────────

// GET /api/lessons — user's saved lessons
app.get('/api/lessons', requireAuth, async (req, res) => {
  const { page = 1, limit = 20, subject, grade } = req.query;
  let query = supabase.from('lessons').select('*', { count: 'exact' })
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (subject) query = query.eq('subject', subject);
  if (grade) query = query.eq('grade', grade);
  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ lessons: data, total: count, page: +page, pages: Math.ceil(count / limit) });
});

// POST /api/lessons/:id/publish — share to community
app.post('/api/lessons/:id/publish', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('lessons')
    .update({ published: true, published_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(404).json({ error: 'Lesson not found' });
  res.json({ lesson: data });
});

// GET /api/community — browse published lessons
app.get('/api/community', requireAuth, async (req, res) => {
  const { subject, grade, bloomLevel, page = 1, limit = 20, search } = req.query;
  let query = supabase.from('lessons').select('*, profiles(name)', { count: 'exact' })
    .eq('published', true)
    .order('published_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  if (subject) query = query.eq('subject', subject);
  if (grade) query = query.eq('grade', grade);
  if (bloomLevel) query = query.eq('bloom_level', bloomLevel);
  if (search) query = query.ilike('title', `%${search}%`);
  const { data, count } = await query;
  res.json({ lessons: data, total: count });
});

// ── STRIPE / BILLING ROUTES ───────────────────────────────────────────────────

// POST /api/billing/create-checkout — start subscription
app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  const { plan } = req.body; // 'pro' or 'school'

  const priceIds = {
    pro: process.env.STRIPE_PRICE_PRO,
    school: process.env.STRIPE_PRICE_SCHOOL
  };

  if (!priceIds[plan]) return res.status(400).json({ error: 'Invalid plan' });

  const { data: profile } = await supabase.from('profiles').select('stripe_customer_id, email').eq('id', req.user.id).single();

  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: profile.email, metadata: { userId: req.user.id } });
    customerId = customer.id;
    await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceIds[plan], quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/app?upgraded=true`,
    cancel_url: `${process.env.FRONTEND_URL}/pricing`,
    subscription_data: { metadata: { userId: req.user.id, plan } }
  });

  res.json({ url: session.url });
});

// POST /api/billing/portal — manage subscription
app.post('/api/billing/portal', requireAuth, async (req, res) => {
  const { data: profile } = await supabase.from('profiles').select('stripe_customer_id').eq('id', req.user.id).single();
  if (!profile?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });
  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.FRONTEND_URL}/app`
  });
  res.json({ url: session.url });
});

// POST /api/webhooks/stripe — handle Stripe events
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const plan = sub.metadata.plan || 'pro';
    await supabase.from('profiles')
      .update({ plan, stripe_subscription_id: sub.id, subscription_status: sub.status })
      .eq('stripe_customer_id', sub.customer);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supabase.from('profiles')
      .update({ plan: 'free', stripe_subscription_id: null, subscription_status: 'cancelled' })
      .eq('stripe_customer_id', sub.customer);
  }

  res.json({ received: true });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`EduCraft AI backend running on port ${PORT}`));

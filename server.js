// EduCraft AI — Simplified Backend
// Just AI generation — no Supabase or Stripe needed to get started
// Run: npm install && node server.js

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'EduCraft AI backend is running!' });
});

// ── GENERATE LESSON PLANS ────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const {
    standard,
    bloomLevels,
    plansPerLevel,
    subject,
    grade,
    state,
    classLevel,
    curriculumNotes,
    differentiationNeeds
  } = req.body;

  if (!standard || !bloomLevels?.length) {
    return res.status(400).json({ error: 'standard and bloomLevels are required' });
  }

  const total = bloomLevels.length * (plansPerLevel || 1);

  const diffLabel = {
    mixed: 'a mixed ability classroom',
    below: 'students who are below grade level',
    on: 'students on grade level',
    above: 'gifted and above-grade-level students',
    ell: 'English language learners (ELL students)',
    sped: 'students with IEPs and special learning needs'
  }[classLevel] || 'a mixed ability classroom';

  const curriculumContext = curriculumNotes
    ? `\nTEACHER CURRICULUM NOTES: ${curriculumNotes}`
    : '';

  const differentiationContext = differentiationNeeds
    ? `\nSPECIFIC DIFFERENTIATION NEEDS: ${differentiationNeeds}`
    : '';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are an expert curriculum designer specializing in differentiated instruction and Universal Design for Learning (UDL). Generate ${plansPerLevel || 1} complete lesson plan(s) for EACH Bloom's Taxonomy level: ${bloomLevels.join(', ')}.

STANDARD: ${standard.code} — ${standard.text}
SUBJECT: ${subject} | GRADE: ${grade} | STATE: ${state}
TARGET STUDENTS: ${diffLabel}${curriculumContext}${differentiationContext}

Each lesson plan must deeply incorporate differentiated learning strategies. Return ONLY a valid JSON array with no markdown or backticks. Each object must have:
{
  "bloomLevel": "level name lowercase",
  "title": "creative engaging lesson title",
  "duration": "e.g. 50 minutes",
  "objective": "one measurable learning objective using a Bloom's verb for that level",
  "gradeAdaptation": "how this lesson is specifically adapted for ${diffLabel}",
  "warmUp": "2-3 sentence engaging warm-up that activates prior knowledge",
  "mainActivity": "3-4 sentence detailed main activity description",
  "materials": ["material 1", "material 2", "material 3", "material 4"],
  "assessment": "2 sentences on how student mastery is measured at this Bloom's level",
  "differentiatedStrategies": {
    "visual": "strategy for visual learners",
    "auditory": "strategy for auditory learners",
    "kinesthetic": "strategy for hands-on learners",
    "advanced": "extension for advanced students",
    "struggling": "support strategy for struggling students",
    "ell": "language support strategy for ELL students"
  },
  "curriculumConnections": "how this lesson connects to broader curriculum themes or units",
  "teacherNotes": "2-3 practical tips for delivering this lesson effectively",
  "bloomRationale": "one sentence explaining how this lesson targets the Bloom's level"
}

Generate exactly ${plansPerLevel || 1} plan(s) per level × ${bloomLevels.length} levels = ${total} total plans. Order from lowest to highest Bloom's level. Return ONLY the JSON array.`
      }]
    });

    const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
    const plans = JSON.parse(raw);
    res.json({ plans, total: plans.length });

  } catch (err) {
    console.error('Generation error:', err);
    res.status(500).json({
      error: 'Failed to generate lesson plans.',
      details: err.message
    });
  }
});

// ── GENERATE STANDARDS ───────────────────────────────────────────────────────
app.post('/api/standards', async (req, res) => {
  const { state, subject, grade } = req.body;

  if (!state || !subject || !grade) {
    return res.status(400).json({ error: 'state, subject, and grade are required' });
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Generate 8 accurate, specific academic standards for:
State: ${state}
Subject: ${subject}  
Grade: ${grade}

Base these on real frameworks: Common Core (Math/ELA), NGSS (Science), or state-specific standards like TEKS (Texas), NGSSS (Florida), etc.

Return ONLY a JSON array, no markdown, no backticks:
[
  { "code": "standard code", "text": "full standard description" }
]

Be specific, accurate, and use the correct coding system for that state and subject.`
      }]
    });

    const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
    const standards = JSON.parse(raw);
    res.json({ standards });

  } catch (err) {
    console.error('Standards error:', err);
    res.status(500).json({ error: 'Failed to fetch standards.', details: err.message });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`EduCraft AI backend running on port ${PORT}`);
  console.log(`Anthropic API key: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'MISSING'}`);
});

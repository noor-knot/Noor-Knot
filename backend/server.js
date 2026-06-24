require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const SYSTEM_PROMPT = `You are Noor, a luxury bridal beauty AI consultant for Noor & Knot, Delhi.

Available studios:
- Jean-Claude Biguine (South Extension) — French luxury, ₹85k-1.5L
- Lakmé Salon (Hauz Khas) — Dewy, natural, ₹45k-80k
- Studio 11 (Greater Kailash) — Editorial, ₹90k-1.8L
- VLCC Wellness (Saket) — Complete packages, ₹35k-65k
- Naturals Salon (Lajpat Nagar) — South Indian, ₹30k-55k
- Enrich Salon (Punjabi Bagh) — Celebrity style, punjabi, ₹70k-1.2L

STRICT RESPONSE RULES — YOU MUST FOLLOW THESE EXACTLY.
You must ALWAYS respond with a valid JSON object. No exceptions. No plain text. No markdown. No backticks.

Case 1 — Normal conversation:
{"action":"message","text":"your response here (max 3 sentences, warm, sophisticated)"}

Case 2 — User confirms they want to book (words like yes book it, i want to book, confirm, proceed, lets book):
{"action":"show_booking_card","studio":"exact studio name from list","text":"your warm confirmation message"}

Case 3 — User provides date/time for booking:
{"action":"confirm_booking","studio":"exact studio name","trialDate":"date and time or null","weddingDate":"date and time or null","text":"your confirmation summary"}

Matching rules:
- Match budget precisely
- Match look: dewy/glow = Lakmé, traditional = Jean-Claude or Enrich, editorial = Studio 11, budget = VLCC or Naturals
- Never recommend airbrush for dewy/natural requests
- Never mention studios outside the list above`;

app.post('/noor', async (req, res) => {
  try {
    const { message, history = [], session_id } = req.body;

    const historyContents = history.map(m => ({
      role: m.role,
      parts: [{ text: m.text }]
    }));

    const contents = [
      ...historyContents,
      { role: 'user', parts: [{ text: message }] }
    ];

    const response = await fetch(
      
       `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:generateContent?key=${process.env.GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            responseMimeType: "application/json"
          },
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', data);
      return res.status(500).json({ action: 'message', text: 'Noor is unavailable right now.' });
    }

    const raw = data.candidates[0].content.parts[0].text;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('JSON parse failed, raw was:', raw);
      parsed = { action: 'message', text: raw };
    }

    if (!parsed.action) parsed.action = 'message';

    // Save the exchange to chat_messages, if a session_id was provided
    if (session_id) {
      const { error: saveError } = await supabase.from('chat_messages').insert([
        { session_id, role: 'user', content: message },
        { session_id, role: 'assistant', content: parsed.text || '' }
      ]);
      if (saveError) console.error('Failed to save chat_messages:', saveError);
    }

    res.json(parsed);

  } catch (err) {
    console.error(err);
    res.status(500).json({ action: 'message', text: 'Noor is unavailable right now.' });
  }
});

// List past conversations for the sidebar — one entry per session_id,
// using the first user message as the title and the latest timestamp for sorting
app.get('/conversations', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('session_id, role, content, created_at')
      .order('created_at', { ascending: true });

    if (error) throw error;

    const sessions = {};
    for (const row of data) {
      if (!sessions[row.session_id]) {
        sessions[row.session_id] = {
          session_id: row.session_id,
          title: null,
          last_message_at: row.created_at
        };
      }
      if (!sessions[row.session_id].title && row.role === 'user') {
        sessions[row.session_id].title = row.content.slice(0, 60);
      }
      sessions[row.session_id].last_message_at = row.created_at;
    }

    const list = Object.values(sessions)
      .filter(s => s.title)
      .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));

    res.json(list);
  } catch (err) {
    console.error('CONVERSATIONS ERROR:', err);
    res.status(500).json({ error: err.message || err });
  }
});

// Load all messages for one conversation, to restore it in the chat window
app.get('/conversations/:session_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('role, content, created_at')
      .eq('session_id', req.params.session_id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('CONVERSATION LOAD ERROR:', err);
    res.status(500).json({ error: err.message || err });
  }
});

app.get('/salons', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('salons')
      .select('*');

    if (error) throw error;

    res.json(data);
  } catch (err) {
  console.error('SALONS ERROR:', err);

  res.status(500).json({
    error: err.message || err
  });
}
});

app.post('/bookings', async (req, res) => {
  try {
    const {
      salon_id,
      salon_name,
      trial_date,
      wedding_date,
      user_message
    } = req.body;

    const { data, error } = await supabase
      .from('bookings')
      .insert([
        {
          salon_id,
          salon_name,
          trial_date,
          wedding_date,
          user_message
        }
      ])
      .select();

    if (error) throw error;

    res.json({
      success: true,
      booking: data[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      error: 'Booking failed'
    });
  }
});

app.listen(process.env.PORT || 3002, () => console.log('Noor backend live on port', process.env.PORT || 3002));

const ALLOWED_ORIGINS = [
  'https://fitness-app-2eb.pages.dev',
  'https://hzfit.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
];

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ── AI COACH PROMPTS ──
const COACH_SYSTEM = `You are a personal fitness AI assistant built into hz.fit — a calorie deficit and body composition tracking app.

You have access to the user's real data: their TDEE, calorie targets, what they've eaten today, their weight trend, workout history, and body composition from their smart scale.

Rules:
- Always use their real numbers in your response
- Be direct. No preamble, no filler.
- Maximum 4 sentences. Be concise.
- Use plain numbers. Say "680 calories" not "a moderate amount."
- If today is already a surplus, pivot to weekly recovery math.
- Tone: honest coach, not cheerleader.
- Never recommend eating below 1,200 cal/day for women or 1,500 for men.`;

function buildCoachPrompt(type, ctx) {
  const tdee = ctx.tdee || 2000;
  const target = ctx.target_calories || tdee - 500;
  const calsToday = ctx.calories_today || 0;
  const remaining = target - calsToday;
  const weekDeficit = ctx.week_deficit || 0;
  const weekTarget = ctx.week_target || 3500;
  const weekRemaining = weekTarget - weekDeficit;
  const daysLeft = ctx.days_left_in_week || 3;
  const weightTrend = ctx.weight_trend || 'unknown';
  const lastWorkout = ctx.last_workout || 'unknown';
  const streak = ctx.streak || 0;
  const bodyFat = ctx.body_fat_pct;
  const muscleMass = ctx.muscle_mass;

  const contextBlock = `
USER STATS:
- TDEE: ${tdee} cal/day
- Daily calorie target: ${target} cal
- Calories eaten today: ${calsToday} cal
- Calories remaining today: ${remaining} cal
- Weekly deficit so far: ${weekDeficit} cal (target: ${weekTarget} cal)
- Days left this week: ${daysLeft}
- Weekly deficit still needed: ${weekRemaining} cal
- Weight trend: ${weightTrend}
- Last workout: ${lastWorkout}
- Current streak: ${streak} days
${bodyFat ? `- Body fat: ${bodyFat}%` : ''}
${muscleMass ? `- Muscle mass: ${muscleMass} lbs` : ''}
`.trim();

  if (type === 'brief') {
    return `${contextBlock}

Give the user their daily brief. Cover:
1. Where they stand on today's deficit (on track / behind / ahead)
2. One specific action for today
3. One observation from their weight trend or streak

Max 3 sentences. Start directly with the insight, no greeting.`;
  }

  if (type === 'meal_rescue') {
    const userMessage = ctx.user_message || '';
    return `${contextBlock}

User message: "${userMessage}"

The user has eaten ${calsToday} calories today. Their target is ${target}.
${remaining >= 0
  ? `They have ${remaining} calories left today.`
  : `They are ${Math.abs(remaining)} calories over today's target.`}

Weekly deficit so far: ${weekDeficit} of ${weekTarget} cal. Days left: ${daysLeft}.

Give specific meal suggestions that fit their remaining budget. If over for the day, show weekly recovery math. Name actual foods and calorie amounts. Max 4 sentences.`;
  }

  if (type === 'workout') {
    return `${contextBlock}

The user is asking whether they should work out today and what to do.

Consider last workout (${lastWorkout}), streak (${streak} days), weekly deficit gap (${weekRemaining} cal in ${daysLeft} days). A 45-min moderate workout burns ~300-400 cal.

Tell them: yes or no on training today, what type/duration, how it affects their weekly deficit. Max 3 sentences.`;
  }

  if (type === 'weekly_analysis') {
    const extra = `
ADDITIONAL WEEKLY DATA:
- Workouts this week: ${ctx.week_workouts || 0}
- Average steps/day: ${ctx.avg_steps || 'not tracked'}
- Steps target: ${ctx.steps_target || 10000}
- Average fasting hours: ${ctx.avg_fast_hrs || 'not tracked'}
- Protein hit rate: ${ctx.protein_hit_rate !== null ? ctx.protein_hit_rate + '%' : 'unknown'}
- Protein target: ${ctx.protein_target || 0}g/day
- Month projected loss: ${ctx.month_projected_lbs || 0} lbs
- Key signals: ${ctx.signals_summary || 'none'}`;

    return `${contextBlock}
${extra}

The user wants a comprehensive weekly review and action plan.

Provide:
1. A honest assessment of this week (2-3 sentences) — what worked, what didn't
2. The single most important thing to fix next week
3. Three specific, actionable recommendations for next week (numbered)

Be direct and data-driven. Use their actual numbers. Max 200 words total.`;
  }

  return `${contextBlock}\n\nUser: ${ctx.user_message || 'Give me advice.'}\n\nRespond with specific, data-driven advice. Max 4 sentences.`;
}

// ── FOOD ANALYSIS PROMPT ──
const FOOD_SYSTEM = `You are a nutrition expert AI. When shown a photo of food, you estimate the nutritional content as accurately as possible.

Rules:
- Be specific about what you see
- Give realistic portion estimates based on visual cues (plate size, serving utensils, etc.)
- If multiple items are visible, estimate each separately then give totals
- Always respond with valid JSON only — no markdown, no explanation outside the JSON
- If you cannot identify the food clearly, still give your best estimate with lower confidence
- Err on the side of slightly overestimating calories (people tend to underestimate)`;

const FOOD_PROMPT = `Analyze this food photo and estimate the nutritional content.

Respond with ONLY this JSON structure, no other text:
{
  "description": "brief description of what you see",
  "items": [
    {"name": "food item", "calories": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}
  ],
  "totals": {
    "calories": 0,
    "protein_g": 0,
    "carbs_g": 0,
    "fat_g": 0
  },
  "confidence": "high|medium|low",
  "notes": "any important caveats about portion size or identification"
}`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    const url = new URL(request.url);

    // ── Route: /ai (coach) ──
    if (url.pathname === '/ai') {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }

      const { type, context } = body;
      if (!type || !context) {
        return new Response(JSON.stringify({ error: 'Missing type or context' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: type === 'weekly_analysis' ? 600 : 300,
            system: COACH_SYSTEM,
            messages: [{ role: 'user', content: buildCoachPrompt(type, context) }],
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          return new Response(JSON.stringify({ error: err.error?.message || 'Claude API error' }), {
            status: 502, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }

        const data = await response.json();
        const text = data.content?.[0]?.text || '';
        return new Response(JSON.stringify({ response: text }), {
          status: 200, headers: { ...headers, 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── Route: /analyze-food (photo → macros) ──
    if (url.pathname === '/analyze-food') {
      let body;
      try { body = await request.json(); } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }

      const { image, mediaType } = body;
      if (!image) {
        return new Response(JSON.stringify({ error: 'Missing image data' }), {
          status: 400, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }

      try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            system: FOOD_SYSTEM,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType || 'image/jpeg',
                    data: image,
                  }
                },
                {
                  type: 'text',
                  text: FOOD_PROMPT
                }
              ]
            }],
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          return new Response(JSON.stringify({ error: err.error?.message || 'Claude API error' }), {
            status: 502, headers: { ...headers, 'Content-Type': 'application/json' }
          });
        }

        const data = await response.json();
        const text = data.content?.[0]?.text || '{}';

        // Parse JSON from response
        let result;
        try {
          const clean = text.replace(/```json|```/g, '').trim();
          result = JSON.parse(clean);
        } catch {
          result = { error: 'Could not parse food analysis', raw: text };
        }

        return new Response(JSON.stringify(result), {
          status: 200, headers: { ...headers, 'Content-Type': 'application/json' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...headers, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers });
  }
};

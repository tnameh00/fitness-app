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

const SYSTEM_PROMPT = `You are a personal fitness AI assistant built into hz.fit — a calorie deficit and body composition tracking app.

You have access to the user's real data: their TDEE, calorie targets, what they've eaten today, their weight trend, workout history, and body composition from their smart scale.

Your job is to give SHORT, SPECIFIC, ACTIONABLE advice based on their actual numbers — not generic fitness tips.

Rules:
- Always use their real numbers in your response (calories remaining, deficit gap, etc.)
- Be direct. No preamble, no "Great question!", no filler.
- Maximum 4 sentences for brief/rescue responses. Be concise.
- Use plain numbers. Say "680 calories" not "a moderate amount."
- If today is already a surplus, pivot to weekly recovery math.
- Tone: honest coach, not cheerleader. Encouraging but real.
- Never recommend eating below 1,200 cal/day for women or 1,500 for men.`;

function buildPrompt(type, ctx) {
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
2. One specific action for today (eat X more cal, do a workout, rest day)
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

Their weekly deficit so far is ${weekDeficit} of ${weekTarget} cal. They have ${daysLeft} days left this week.

Give specific meal suggestions for what to eat next (or for the rest of the day) that fits within their remaining budget. If they're over for the day, show them the weekly recovery math — how many fewer calories per day for the remaining days gets them back on track.

Be specific: name actual foods and calorie amounts. Max 4 sentences.`;
  }

  if (type === 'workout') {
    return `${contextBlock}

The user is asking whether they should work out today and what to do.

Consider:
- How long since their last workout (${lastWorkout})
- Their current streak (${streak} days)
- Their weekly deficit gap (${weekRemaining} cal still needed in ${daysLeft} days)
- A 45-min moderate workout burns ~300-400 cal, which helps close the deficit

Tell them: yes or no on training today, what type/duration, and how it affects their weekly deficit. Max 3 sentences. Be direct.`;
  }

  return `${contextBlock}\n\nUser: ${ctx.user_message || 'Give me advice.'}\n\nRespond with specific, data-driven advice based on the stats above. Max 4 sentences.`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ai') {
      return new Response('Not found', { status: 404, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
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

    const prompt = buildPrompt(type, context);

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
          max_tokens: 300,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
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
};

/**
 * src/agents/practice.js
 * =======================
 * Frontend calls to the Practice Agent.
 *
 * callPractice()         — generates a scenario. If a free-text `topic` is
 *                           given, the scenario is built dynamically around
 *                           it (no predefined list). If topic is omitted,
 *                           the backend falls back to targeting the
 *                           learner's weakest module (legacy behaviour).
 * validateUnderstanding() — RAG-grounded scoring of the learner's own typed
 *                           explanation of a scenario, powering the
 *                           "Validate My Understanding" flow.
 */

const BACKEND = import.meta.env?.VITE_BACKEND_URL || '';

/**
 * Generate a practice scenario.
 *
 * @param {object} context
 *   {
 *     learner_name:   string,
 *     track:          string,
 *     topic:           string,   // free-text topic the learner typed (optional)
 *     is_cross_skill:  boolean,  // true when practising outside the home track
 *     conf_scores:     object,   // {moduleId: score}   — legacy fallback only
 *     modules:         Array,    // [{id, title}]        — legacy fallback only
 *     done_modules:    Array,    // [id, ...]             — legacy fallback only
 *     module_id:       number,   // optional: force a specific module
 *     module_title:    string,   // optional: force a specific module
 *   }
 * @returns {Promise<{scenario, weakModuleTitle, validationOk, meta}>}
 *
 * scenario shape:
 *   { title, module_targeted, business_context, problem_statement,
 *     constraints[], aep_products_involved[], expected_deliverable,
 *     hints[], estimated_minutes }
 */
export async function callPractice(context = {}) {
  const res = await fetch(`${BACKEND}/api/agents/practice`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [],
      profile: { name: context.learner_name || '' },
      track:   context.track || 'rtcdp',
      extra: {
        topic:          context.topic || '',
        is_cross_skill: !!context.is_cross_skill,
        conf_scores:    context.conf_scores  || {},
        modules:        context.modules      || [],
        done_modules:   context.done_modules || [],
        module_id:      context.module_id,
        module_title:   context.module_title || '',
      },
    }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || `Practice agent error ${res.status}`);
  }
  const data = await res.json();
  return {
    scenario:        data.scenario         || {},
    weakModuleTitle: data.weak_module_title || '',
    weakModuleId:    data.weak_module_id,
    validationOk:    data.validation_ok    ?? true,
    meta: data.meta || {
      type:           'agent',
      name:           'practice',
      steps_executed: 4,
    },
  };
}

/**
 * Validate My Understanding — score the learner's own explanation of a
 * scenario against the scenario itself, grounded in retrieved documentation.
 *
 * @param {object} context
 *   {
 *     scenario:               object,  // the scenario object shown to the learner
 *     learner_understanding:  string,  // learner's own written explanation
 *     topic:                  string,  // scenario topic (for doc retrieval)
 *   }
 * @returns {Promise<{confidence, verdict, matchedPoints, missedPoints, guidance, meta}>}
 *   verdict is "pass" when confidence > 60, else "review".
 */
export async function validateUnderstanding(context = {}) {
  const res = await fetch(`${BACKEND}/api/agents/practice/validate`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [],
      profile: {},
      extra: {
        scenario:              context.scenario || {},
        learner_understanding: context.learner_understanding || '',
        topic:                 context.topic || '',
      },
    }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || `Validation agent error ${res.status}`);
  }
  const data = await res.json();
  return {
    confidence:    data.confidence ?? 0,
    verdict:       data.verdict || (data.confidence > 60 ? 'pass' : 'review'),
    matchedPoints: data.matched_points || [],
    missedPoints:  data.missed_points  || [],
    guidance:      data.guidance || '',
    meta: data.meta || { type: 'agent', name: 'practice_validate' },
  };
}
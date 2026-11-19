// Pure (database-free) examination logic for Jupiter's parent-examination / paper architecture.
// Everything here is deterministic and unit-testable; routes and stores call into it.

export const TARGET_FIELDS = ['academicYearId', 'departmentId', 'courseId', 'semesterId', 'classId', 'sectionId', 'batchId'];
// Keys that legacy (pre-parent) examinations used when matching students.
export const LEGACY_TARGET_FIELDS = ['departmentId', 'courseId', 'classId', 'sectionId', 'batchId'];
export const EXAM_TYPES = ['unit_test', 'quiz', 'midterm', 'term', 'final', 'mock', 'practical', 'other'];
export const RESULT_POLICY_MODES = ['each_paper', 'aggregate', 'none'];
export const NEGATIVE_MARKING_VALUES = [0, 0.25, 1 / 3, 0.5];
export const PAPER_STATES = ['upcoming', 'available', 'in_progress', 'completed', 'expired', 'not_published', 'locked', 'offline'];

export const toMs = value => {
  if (value === undefined || value === null || value === '') return NaN;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
};
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
export const asArray = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : typeof v === 'string' && v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
export const questionIdsOf = paper => asArray(paper?.questionIds).map(String);
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

export function attemptLimit(paper) {
  if (paper?.maxAttempts === 'unlimited') return Infinity;
  return Math.max(1, Math.floor(Number(paper?.maxAttempts) || 1));
}

export function defaultResultPolicy() {
  return { mode: 'each_paper', overallPassPercentage: 40, attemptSelection: 'best' };
}

export function normalizeResultPolicy(input = {}) {
  const errors = [];
  const base = defaultResultPolicy();
  const mode = input.mode === undefined ? base.mode : String(input.mode);
  if (!RESULT_POLICY_MODES.includes(mode)) errors.push('Overall result policy must be each_paper, aggregate or none.');
  const pct = input.overallPassPercentage === undefined ? base.overallPassPercentage : Number(input.overallPassPercentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.push('Overall pass percentage must be between 0 and 100.');
  const sel = input.attemptSelection === undefined ? base.attemptSelection : String(input.attemptSelection);
  if (!['best', 'latest'].includes(sel)) errors.push('Attempt selection must be best or latest.');
  return { value: { mode, overallPassPercentage: pct, attemptSelection: sel }, errors };
}

// ---------- Parent examination ----------
export function normalizeExaminationInput(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = k => body[k] !== undefined;
  if (!partial || has('name')) {
    const name = clean(body.name, 150);
    if (name.length < 2) errors.push('Enter an examination name (at least 2 characters).');
    out.name = name;
  }
  if (has('description')) out.description = clean(body.description, 2000);
  if (has('instructions')) out.instructions = clean(body.instructions, 5000);
  if (!partial || has('examType')) {
    const type = clean(body.examType || 'other', 40).toLowerCase();
    if (!EXAM_TYPES.includes(type)) errors.push(`Examination type must be one of: ${EXAM_TYPES.join(', ')}.`);
    out.examType = type;
  }
  for (const f of TARGET_FIELDS) if (has(f)) out[f] = clean(body[f], 120);
  if (has('eligibleStudentIds')) {
    const ids = [...new Set(asArray(body.eligibleStudentIds).map(x => clean(x, 120)).filter(Boolean))];
    if (ids.length > 5000) errors.push('Too many eligible students selected.');
    out.eligibleStudentIds = ids;
  }
  if (has('resultPolicy')) {
    const p = normalizeResultPolicy(body.resultPolicy || {});
    errors.push(...p.errors);
    out.resultPolicy = p.value;
  }
  return { value: out, errors };
}

// ---------- Paper ----------
export function computePaperTotal(paper, questionDocs = {}) {
  if ((paper.examMode || 'online') === 'offline') return round2(paper.totalMarks);
  return round2(questionIdsOf(paper).reduce((sum, id) => sum + (Number(paper.questionMarks?.[id] ?? questionDocs[id]?.marks) || 0), 0));
}

// Structural validation of a paper payload. Database-dependent checks (subject, questions) happen in routes.
export function normalizePaperInput(body = {}, { existing = null, now = Date.now() } = {}) {
  const errors = [];
  const merged = { ...(existing || {}), ...body };
  const out = {};
  const has = k => body[k] !== undefined;

  if (!existing || has('paperName')) {
    const n = clean(body.paperName, 120);
    if (n.length < 1) errors.push('Enter a paper name.');
    out.paperName = n;
  }
  if (!existing || has('subjectId')) {
    out.subjectId = clean(body.subjectId, 120);
    if (!out.subjectId) errors.push('Select a subject for the paper.');
  }
  if (has('description')) out.description = clean(body.description, 2000);
  if (has('paperInstructions')) out.paperInstructions = clean(body.paperInstructions, 5000);
  if (has('locked')) out.locked = body.locked === true;

  const mode = clean(merged.examMode || 'online', 10);
  if (!['online', 'offline'].includes(mode)) errors.push('Paper mode must be online or offline.');
  out.examMode = mode;

  const minutes = Number(merged.durationMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) errors.push('Duration must be between 1 and 1440 minutes.');
  else out.durationMinutes = Math.floor(minutes);

  const start = toMs(merged.startAt);
  if (!Number.isFinite(start)) errors.push('Enter a valid paper start date and time.');
  let end = toMs(merged.endAt);
  if (Number.isFinite(start) && Number.isFinite(minutes) && minutes > 0) {
    if (!Number.isFinite(end)) end = start + minutes * 60000;
    if (end <= start) errors.push('Paper end time must be after its start time.');
    else if (mode === 'online' && end - start < minutes * 60000) errors.push('The paper window (start to end) is shorter than its duration.');
  }
  if (Number.isFinite(start)) out.startAt = new Date(start).toISOString();
  if (Number.isFinite(end)) out.endAt = new Date(end).toISOString();

  if (has('maxAttempts') || !existing) {
    const raw = merged.maxAttempts === undefined || merged.maxAttempts === '' ? 1 : merged.maxAttempts;
    if (raw === 'unlimited') out.maxAttempts = 'unlimited';
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 100) errors.push('Maximum attempts must be a whole number from 1 to 100, or "unlimited".');
      else out.maxAttempts = n;
    }
  }
  if (mode === 'online' && (has('negativeMarking') || !existing)) {
    const neg = Number(merged.negativeMarking ?? 0);
    if (!NEGATIVE_MARKING_VALUES.some(v => Math.abs(v - neg) < 0.002)) errors.push('Negative marking must be 0, 1/4, 1/3 or 1/2.');
    else out.negativeMarking = neg;
  }
  const passing = Number(merged.passingMarks ?? 0);
  if (!Number.isFinite(passing) || passing < 0) errors.push('Passing marks must be zero or more.');
  else out.passingMarks = passing;

  if (mode === 'offline') {
    const total = Number(merged.totalMarks);
    if (!Number.isFinite(total) || total <= 0) errors.push('Offline papers need positive maximum marks.');
    else out.totalMarks = total;
    out.questionIds = [];
    out.questionMarks = {};
  } else if (has('questionIds') || has('questionMarks') || !existing) {
    const ids = [...new Set(questionIdsOf({ questionIds: body.questionIds }))];
    const marks = {};
    const given = body.questionMarks && typeof body.questionMarks === 'object' ? body.questionMarks : {};
    for (const id of ids) {
      if (given[id] !== undefined) {
        const m = Number(given[id]);
        if (!(m > 0) || !Number.isFinite(m)) errors.push(`Enter positive marks for question ${id}.`);
        else marks[id] = round2(m);
      }
    }
    out.questionIds = ids;
    out.questionMarks = marks;
  }
  return { value: out, errors };
}

// Publication-time validation of a fully resolved paper. `questions` maps id -> question doc (or undefined).
export function validatePaperForPublish(paper, questions = {}, { now = Date.now() } = {}) {
  const errors = [];
  const mode = paper.examMode || 'online';
  let total = 0;
  if (mode === 'online') {
    const ids = questionIdsOf(paper);
    if (!ids.length) errors.push('Add at least one question.');
    for (const id of ids) {
      const q = questions[id];
      if (!q) { errors.push(`Question ${id} no longer exists.`); continue; }
      const type = q.questionType || 'mcq';
      const marks = Number(paper.questionMarks?.[id] ?? q.marks);
      if (!(marks > 0)) errors.push(`Question ${id} needs positive marks.`);
      total += marks || 0;
      if (!['mcq', 'short', 'long'].includes(type)) errors.push(`Question ${id} has an unsupported type.`);
      if (type === 'mcq') {
        const opts = ['optionA', 'optionB', 'optionC', 'optionD', 'optionE', 'optionF'].filter(k => String(q[k] || '').trim());
        const key = String(q.correctOption || '').toUpperCase();
        if (opts.length < 2 || !String(q[`option${key}`] || '').trim()) errors.push(`MCQ ${id} needs 2–6 options and a valid correct answer.`);
      } else if (!String(q.name || '').trim()) errors.push(`Question ${id} has no text.`);
    }
    if (!(Number(paper.durationMinutes) > 0)) errors.push('Duration must be greater than zero.');
    const end = toMs(paper.endAt);
    if (Number.isFinite(end) && end <= now) errors.push('The paper end time has already passed.');
  } else total = Number(paper.totalMarks) || 0;
  total = round2(total);
  if (!(total > 0)) errors.push('Maximum marks must be greater than zero.');
  if (Number(paper.passingMarks) > total) errors.push('Passing marks cannot exceed maximum marks.');
  const start = toMs(paper.startAt), end = toMs(paper.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) errors.push('Paper schedule is invalid.');
  return { errors, total };
}

// ---------- Availability ----------
// attempts: this student's attempts for the paper (already swept for expiry).
export function computePaperAccess({ parent, paper, attempts = [], now }) {
  const limit = attemptLimit(paper);
  const used = attempts.length;
  const active = attempts.find(a => a.status === 'in_progress' && toMs(a.expiresAt) > now) || null;
  const start = toMs(paper.startAt), end = toMs(paper.endAt);
  const base = {
    attemptsUsed: used,
    attemptsAllowed: limit === Infinity ? 'unlimited' : limit,
    attemptsRemaining: limit === Infinity ? null : Math.max(0, limit - used),
    activeAttemptId: active?.id || null,
    startsInMs: null,
    endsInMs: Number.isFinite(end) ? Math.max(0, end - now) : null,
  };
  const out = (state, canStart, reason = '') => ({ ...base, state, canStart, reason });
  if (parent.status !== 'published' || paper.status !== 'published') return out('not_published', false, 'This paper is not published.');
  if ((paper.examMode || 'online') === 'offline') return out('offline', false, 'This paper is conducted offline. Marks are entered by your institute.');
  if (active) return out('in_progress', true, 'Resume your attempt.');
  if (paper.locked === true) return out('locked', false, 'This paper is locked by your institute.');
  if (Number.isFinite(start) && now < start) return { ...out('upcoming', false, 'This paper has not started yet.'), startsInMs: start - now };
  const closed = Number.isFinite(end) && now > end;
  const exhausted = limit !== Infinity && used >= limit;
  if (used > 0 && (exhausted || closed)) return out('completed', false, exhausted ? 'All attempts have been used.' : 'The paper window has closed.');
  if (closed) return out('expired', false, 'The paper window has closed.');
  if (exhausted) return out('completed', false, 'All attempts have been used.');
  return out('available', true);
}

// Roll-up status of a whole examination for a student list card.
export function summarizeExaminationStates(states) {
  const count = s => states.filter(x => x === s).length;
  const counts = Object.fromEntries(PAPER_STATES.map(s => [s, count(s)]));
  const live = states.filter(s => !['not_published', 'offline'].includes(s));
  let status = 'not_published';
  if (counts.in_progress) status = 'in_progress';
  else if (counts.available) status = 'available';
  else if (counts.upcoming) status = 'upcoming';
  else if (counts.locked) status = 'locked';
  else if (live.length && live.every(s => s === 'completed')) status = 'completed';
  else if (live.length) status = counts.completed ? 'completed' : 'expired';
  return { status, counts };
}

// ---------- Scoring ----------
export function scoreAttempt(snapshot, answers) {
  let score = 0, correct = 0, wrong = 0, unanswered = 0, manualPending = 0;
  const questionResults = [];
  for (const q of snapshot.questions || []) {
    const answer = answers?.[q.id];
    const hasAnswer = answer !== undefined && answer !== null && String(answer).trim() !== '';
    let awarded = 0, status = 'unanswered';
    if (hasAnswer && q.questionType === 'mcq') {
      if (answer === q.correctOption) { awarded = Number(q.marks) || 0; correct++; status = 'correct'; }
      else { awarded = -((Number(q.marks) || 0) * (Number(snapshot.negativeMarking) || 0)); wrong++; status = 'incorrect'; }
      score += awarded;
    } else if (hasAnswer) { manualPending++; status = 'manual_pending'; }
    else unanswered++;
    questionResults.push({
      questionId: q.id, questionType: q.questionType || 'mcq', question: q.text,
      answer: hasAnswer ? answer : '', maximumMarks: Number(q.marks) || 0,
      awardedMarks: q.questionType === 'mcq' || !hasAnswer ? Math.max(0, awarded) : null, status,
    });
  }
  score = Math.max(0, round2(score));
  return {
    score, totalMarks: snapshot.totalMarks,
    percentage: snapshot.totalMarks ? Math.round(score / snapshot.totalMarks * 10000) / 100 : 0,
    correct, wrong, unanswered, manualPending,
    evaluationStatus: manualPending ? 'manual_pending' : 'evaluated', questionResults,
  };
}

export function buildResultRecord({ attempt, evaluated, paper, parent, submittedAt }) {
  const s = attempt.snapshot || {};
  const pick = k => paper?.[k] || s[k] || null;
  const passing = Number(s.passingMarks) || 0;
  return {
    id: attempt.id,
    examId: attempt.examId, // legacy name: the paper id
    examinationId: attempt.examinationId || paper?.examinationId || s.examinationId || null,
    paperId: attempt.examId,
    paperName: s.paperName || paper?.paperName || '',
    attemptNumber: attempt.attemptNumber || 1,
    examName: s.examName, examinationName: s.examinationName || parent?.name || s.examName,
    subjectName: s.subjectName || '',
    examGroupId: s.examGroupId || '', examGroupName: s.examGroupName || '',
    paperOrder: s.paperOrder || paper?.paperOrder || 1, paperCount: s.paperCount || 1,
    studentUid: attempt.studentUid, studentRecordId: attempt.studentRecordId || attempt.studentUid, studentName: attempt.studentName,
    score: evaluated.score, totalMarks: evaluated.totalMarks, percentage: evaluated.percentage,
    correct: evaluated.correct, wrong: evaluated.wrong, unanswered: evaluated.unanswered,
    status: 'evaluated', evaluationStatus: evaluated.evaluationStatus, questionResults: evaluated.questionResults,
    publicationStatus: 'unpublished',
    academicYearId: pick('academicYearId'), departmentId: pick('departmentId'), courseId: pick('courseId'), semesterId: pick('semesterId'),
    subjectId: pick('subjectId'), classId: pick('classId'), sectionId: pick('sectionId'), batchId: pick('batchId'),
    passingMarks: passing, passStatus: evaluated.score >= passing ? 'pass' : 'fail', submittedAt,
  };
}

// ---------- Overall examination result ----------
// resultsByPaper: Map/obj paperId -> array of that student's result records for the paper.
export function selectPaperResult(results = [], attemptSelection = 'best') {
  const usable = results.filter(Boolean);
  if (!usable.length) return null;
  if (attemptSelection === 'latest') return [...usable].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0];
  return [...usable].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0) || (b.submittedAt || 0) - (a.submittedAt || 0))[0];
}

export function computeOverallResult({ parent, papers, resultsByPaper }) {
  const policy = { ...defaultResultPolicy(), ...(parent?.resultPolicy || {}) };
  const rows = papers.map(p => {
    const list = resultsByPaper instanceof Map ? resultsByPaper.get(p.id) : resultsByPaper?.[p.id];
    const r = selectPaperResult(list || [], policy.attemptSelection);
    return {
      paperId: p.id, paperName: p.paperName || p.name, subjectName: p.subjectName || '',
      maximumMarks: r ? Number(r.totalMarks) || 0 : Number(p.totalMarks) || 0,
      obtainedMarks: r ? Number(r.score) || 0 : 0,
      passStatus: r ? r.passStatus : 'not_attempted', attempted: !!r, resultId: r?.id || null,
      publicationStatus: r?.publicationStatus || null,
    };
  });
  const totalMax = round2(rows.reduce((s, r) => s + r.maximumMarks, 0));
  const totalObtained = round2(rows.reduce((s, r) => s + r.obtainedMarks, 0));
  const percentage = totalMax ? Math.round(totalObtained / totalMax * 10000) / 100 : 0;
  const complete = rows.length > 0 && rows.every(r => r.attempted);
  let status = 'incomplete';
  if (policy.mode === 'none') status = 'not_applicable';
  else if (complete) {
    status = policy.mode === 'aggregate'
      ? (percentage >= policy.overallPassPercentage ? 'pass' : 'fail')
      : (rows.every(r => r.passStatus === 'pass') ? 'pass' : 'fail');
  }
  return { policy, rows, totalMaximumMarks: totalMax, totalObtainedMarks: totalObtained, percentage, complete, status };
}

// ---------- Staff statistics ----------
export function summarizePaperStats({ paper, attempts = [], results = [], eligibleCount = null }) {
  const submitted = attempts.filter(a => a.status === 'submitted');
  const inProgress = attempts.filter(a => a.status === 'in_progress');
  const participants = new Set(attempts.map(a => a.studentUid));
  const evaluated = results.filter(r => (r.evaluationStatus || r.status) === 'evaluated');
  const avg = evaluated.length ? round2(evaluated.reduce((s, r) => s + (Number(r.score) || 0), 0) / evaluated.length) : null;
  return {
    paperId: paper.id, participants: participants.size, totalAttempts: attempts.length,
    completedAttempts: submitted.length, pendingAttempts: inProgress.length,
    pendingEvaluation: submitted.length - evaluated.length,
    averageMarks: avg, passed: evaluated.filter(r => r.passStatus === 'pass').length,
    failed: evaluated.filter(r => r.passStatus === 'fail').length, eligibleStudents: eligibleCount,
  };
}

// ---------- Legacy grouping / migration planning ----------
const legacyTargetKeys = TARGET_FIELDS;
const sameTargets = (a, b) => legacyTargetKeys.every(k => String(a[k] || '') === String(b[k] || ''));

export const legacyParentId = paperId => `exm_${paperId}`;

// Pure plan. `exams` is the raw institutes/{iid}/exams object.
export function planExaminationMigration(exams = {}, existingParents = {}) {
  const entries = Object.entries(exams || {}).filter(([, e]) => e && typeof e === 'object');
  const todo = entries.filter(([, e]) => !e.examinationId);
  const report = { alreadyMigrated: entries.length - todo.length, grouped: [], single: [], ambiguous: [], suggestions: [], orphans: [] };
  const parents = {}, paperUpdates = {};

  for (const [id, e] of entries) {
    if (e.examinationId && !existingParents[e.examinationId] && !parents[e.examinationId]) report.orphans.push({ paperId: id, examinationId: e.examinationId });
  }

  const groups = new Map();
  const singles = [];
  for (const [id, e] of todo) {
    if (e.examGroupId) { if (!groups.has(e.examGroupId)) groups.set(e.examGroupId, []); groups.get(e.examGroupId).push([id, e]); }
    else singles.push([id, e]);
  }
  const order = list => [...list].sort(([ia, a], [ib, b]) => (Number(a.paperOrder) || 999) - (Number(b.paperOrder) || 999) || (a.createdAt || 0) - (b.createdAt || 0) || ia.localeCompare(ib));

  const makeParent = (parentId, list, extra = {}) => {
    const sorted = order(list);
    const first = sorted[0][1];
    const statuses = sorted.map(([, e]) => e.status || 'draft');
    const live = statuses.filter(s => s !== 'archived');
    const status = !live.length ? 'archived' : live.some(s => s === 'published') ? 'published' : 'draft';
    const parent = {
      id: parentId, name: first.examGroupName || first.name, description: '', instructions: '', examType: 'other',
      ...Object.fromEntries(legacyTargetKeys.map(k => [k, first[k] || ''])),
      eligibleStudentIds: [], resultPolicy: defaultResultPolicy(), status,
      paperIds: sorted.map(([id]) => id), createdBy: first.createdBy || null,
      createdAt: Math.min(...sorted.map(([, e]) => e.createdAt || Date.now())), updatedAt: Date.now(),
      publishedAt: status === 'published' ? Math.min(...sorted.map(([, e]) => e.publishedAt || Infinity).filter(Number.isFinite), Date.now()) : null,
      schemaVersion: 2, legacy: true, migratedAt: Date.now(), ...extra,
    };
    parents[parentId] = parent;
    sorted.forEach(([id, e], i) => {
      paperUpdates[id] = {
        examinationId: parentId, paperId: id, paperOrder: i + 1,
        paperName: e.paperName || e.subjectName || String(e.name || '').split('—').pop().trim() || `Paper ${i + 1}`,
        ...(extra.legacyGroupId ? { legacyGroupId: extra.legacyGroupId } : {}),
      };
    });
    return sorted.map(([id]) => id);
  };

  for (const [gid, list] of groups) {
    const consistent = list.every(([, e]) => sameTargets(e, list[0][1]) && (e.examMode || 'online') === (list[0][1].examMode || 'online'));
    const orders = list.map(([, e]) => Number(e.paperOrder) || 0).filter(Boolean);
    const dupOrder = new Set(orders).size !== orders.length;
    const existing = existingParents[gid];
    if (existing && existing.legacy !== true) { report.ambiguous.push({ groupId: gid, reason: 'A non-legacy examination already uses this id.', paperIds: list.map(([id]) => id) }); continue; }
    if (!consistent || dupOrder) {
      report.ambiguous.push({ groupId: gid, reason: !consistent ? 'Papers in this group disagree on academic target or mode.' : 'Duplicate paper order values.', paperIds: list.map(([id]) => id) });
      // Never guess: keep each paper as its own parent; remember the legacy group for manual reconciliation.
      for (const [id, e] of list) { makeParent(legacyParentId(id), [[id, e]], { legacyGroupId: gid }); report.single.push(id); }
      continue;
    }
    const ids = makeParent(gid, list, { legacyGroupId: gid });
    report.grouped.push({ examinationId: gid, name: parents[gid].name, paperIds: ids });
  }
  for (const [id, e] of singles) { makeParent(legacyParentId(id), [[id, e]]); report.single.push(id); }

  // Informational only: same "Name — Subject" prefix and target, but never auto-merged.
  const byPrefix = new Map();
  for (const sid of report.single) {
    const e = exams[sid];
    const parts = String(e.name || '').split('—');
    if (parts.length < 2) continue;
    const key = `${parts[0].trim().toLowerCase()}|${legacyTargetKeys.map(k => e[k] || '').join('|')}`;
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(sid);
  }
  for (const ids of byPrefix.values()) if (ids.length > 1) report.suggestions.push({ paperIds: ids, note: 'Similar names and identical academic target; merge manually if they are one examination.' });
  return { parents, paperUpdates, report };
}

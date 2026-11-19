import { Router } from 'express';
import { validateStudentAcademicRelationships } from '../services/academicRules.js';
import { base } from '../services/examStore.js';
import {
  TARGET_FIELDS, asArray, attemptLimit, buildResultRecord, computeOverallResult, computePaperAccess, computePaperTotal,
  normalizeExaminationInput, normalizePaperInput, questionIdsOf, round2, selectPaperResult, summarizeExaminationStates,
  summarizePaperStats, toMs, validatePaperForPublish, defaultResultPolicy,
} from '../services/examEngine.js';

const err = (status, message, details) => Object.assign(new Error(message), { status, ...(details ? { details } : {}) });
const refCollections = { academicYearId: 'academicYears', departmentId: 'departments', courseId: 'courses', semesterId: 'semesters', classId: 'classes', sectionId: 'sections', batchId: 'batches' };
const OPTION_KEYS = ['optionA', 'optionB', 'optionC', 'optionD', 'optionE', 'optionF'];

export function createExaminationsRouter({ db, store, requireAuth, allow, can, assertScope, inTeacherScope, isInstituteOwner }) {
  const r = Router();
  r.use(requireAuth);
  const staffOnly = allow('institute_owner', 'institute_admin', 'teacher');
  const perm = (module, action) => (req, res, next) => (can(req.user, module, action) ? next() : res.status(403).json({ message: `${module === 'results' ? 'Result' : 'Examination'} ${action} permission is required.` }));
  const audit = (iid, req, action, recordId, extra = {}) => ({ [`institutes/${iid}/auditLogs/${db.key()}`]: { actorUid: req.user.uid, action, recordId, at: Date.now(), ...extra } });
  const targetOf = rec => Object.fromEntries(TARGET_FIELDS.map(k => [k, rec?.[k] || '']));
  const canManage = (user, parent) => isInstituteOwner(user) || (user.role === 'teacher' && parent.createdBy === user.uid);

  async function requireParent(req, { manage = false } = {}) {
    const iid = req.user.instituteId;
    if (!iid) throw err(403, 'Join an institute before managing examinations.');
    await store.ensureMigrated(iid);
    const parent = await store.loadExamination(iid, req.params.id);
    if (!parent) throw err(404, 'Examination not found.');
    const papers = await store.loadPapers(iid, parent.id);
    if (req.user.role === 'teacher') {
      const visible = parent.createdBy === req.user.uid || papers.some(p => inTeacherScope(req.user, p, 'exams'));
      if (!visible) throw err(403, 'This examination is outside your assigned scope.');
      if (manage && !canManage(req.user, parent)) throw err(403, 'Teachers can manage only examinations they created.');
    }
    return { iid, parent, papers };
  }

  async function validateTargets(iid, target) {
    const refs = {};
    for (const [field, coll] of Object.entries(refCollections)) {
      if (!target[field]) continue;
      const rec = await db.get(base(iid, coll, target[field]));
      if (!rec || ['archived', 'inactive'].includes(rec.status)) throw err(400, `Selected ${field.replace('Id', '')} does not exist or is inactive in this institute.`);
      refs[field] = rec;
    }
    validateStudentAcademicRelationships(target, { department: refs.departmentId, course: refs.courseId, semester: refs.semesterId, academicYear: refs.academicYearId, classRecord: refs.classId, section: refs.sectionId, batch: refs.batchId });
  }

  async function resolvePaperContext(req, iid, parent, input) {
    const subject = await db.get(base(iid, 'subjects', input.subjectId));
    if (!subject || ['archived', 'inactive'].includes(subject.status)) throw err(400, 'Selected subject does not exist in this institute.');
    if (subject.courseId && parent.courseId && String(subject.courseId) !== String(parent.courseId)) throw err(400, 'The subject does not belong to the examination’s course.');
    if (subject.departmentId && parent.departmentId && String(subject.departmentId) !== String(parent.departmentId)) throw err(400, 'The subject does not belong to the examination’s department.');
    if (req.user.role === 'teacher') assertScope(req.user, { ...targetOf(parent), subjectId: input.subjectId }, 'exams');
    const docs = {};
    if ((input.examMode || 'online') === 'online') {
      const ids = questionIdsOf(input);
      const rows = await Promise.all(ids.map(id => db.get(base(iid, 'questionBanks', id))));
      ids.forEach((id, i) => {
        const q = rows[i];
        if (!q) throw err(400, `Question ${id} does not exist in this institute.`);
        if (req.user.role === 'teacher') assertScope(req.user, q, 'questionBanks');
        if (q.subjectId && String(q.subjectId) !== String(input.subjectId)) throw err(400, `Question ${id} belongs to a different subject.`);
        docs[id] = q;
      });
    }
    return { subject, docs };
  }

  function paperRecord({ parent, existing, input, subject, docs, order, siblingCount, id }) {
    const merged = { ...(existing || {}), ...input };
    const totalMarks = computePaperTotal(merged, docs.__all || docs);
    return {
      ...(existing || {}), ...input,
      id: undefined,
      examinationId: parent.id, paperId: id, paperOrder: order,
      name: `${parent.name} — ${input.paperName ?? existing?.paperName}`,
      subjectName: subject.name || '',
      ...targetOf(parent),
      examGroupId: parent.id, examGroupName: parent.name, paperCount: siblingCount,
      totalMarks, status: existing?.status || 'draft',
      createdBy: parent.createdBy, createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(),
    };
  }

  const strip = rec => { const { id, ...rest } = rec; return rest; };
  const paperHistory = (paperId, attempts, results) =>
    Object.values(attempts || {}).some(a => a.examId === paperId) || Object.values(results || {}).some(x => x.examId === paperId);

  const publicPaper = (p, attemptCounts = {}) => ({
    id: p.id, examinationId: p.examinationId, paperName: p.paperName || p.name, subjectId: p.subjectId || '', subjectName: p.subjectName || '',
    description: p.description || '', paperInstructions: p.paperInstructions || '', examMode: p.examMode || 'online',
    questionIds: questionIdsOf(p), questionMarks: p.questionMarks || {}, questionCount: questionIdsOf(p).length,
    totalMarks: p.totalMarks ?? 0, passingMarks: p.passingMarks ?? 0, durationMinutes: p.durationMinutes ?? null,
    startAt: p.startAt || null, endAt: p.endAt || null, maxAttempts: p.maxAttempts ?? 1, negativeMarking: p.negativeMarking ?? 0,
    locked: p.locked === true, status: p.status || 'draft', paperOrder: p.paperOrder || 1, publishedAt: p.publishedAt || null,
    attemptCount: attemptCounts[p.id] || 0,
  });

  const examinationSummary = (parent, papers, attemptCounts = {}) => {
    const live = papers.filter(p => p.status !== 'archived');
    return {
      id: parent.id, name: parent.name, description: parent.description || '', instructions: parent.instructions || '', examType: parent.examType || 'other',
      status: parent.status || 'draft', ...targetOf(parent), eligibleStudentIds: asArray(parent.eligibleStudentIds),
      resultPolicy: { ...defaultResultPolicy(), ...(parent.resultPolicy || {}) },
      paperCount: live.length, publishedPaperCount: live.filter(p => p.status === 'published').length,
      totalMarks: round2(live.reduce((s, p) => s + (Number(p.totalMarks) || 0), 0)),
      attemptCount: live.reduce((s, p) => s + (attemptCounts[p.id] || 0), 0),
      createdBy: parent.createdBy || null, createdAt: parent.createdAt || null, updatedAt: parent.updatedAt || null, publishedAt: parent.publishedAt || null,
      legacy: parent.legacy === true,
      papers: live.map(p => publicPaper(p, attemptCounts)),
    };
  };
  const countAttempts = attempts => { const m = {}; for (const a of Object.values(attempts || {})) m[a.examId] = (m[a.examId] || 0) + 1; return m; };

  // =============== STAFF: LIST / SUMMARY ===============
  r.get('/examinations', staffOnly, perm('examinations', 'view'), async (req, res, next) => {
    try {
      const iid = req.user.instituteId; if (!iid) return res.json({ items: [] });
      await store.ensureMigrated(iid);
      const [parents, exams, attempts] = await Promise.all([db.get(`institutes/${iid}/examinations`), db.get(`institutes/${iid}/exams`), db.get(`institutes/${iid}/examAttempts`)]);
      const counts = countAttempts(attempts);
      const byParent = {};
      for (const [id, p] of Object.entries(exams || {})) if (p?.examinationId) (byParent[p.examinationId] ||= []).push({ ...p, id });
      let items = Object.entries(parents || {}).map(([id, parent]) => {
        const papers = (byParent[id] || []).sort((a, b) => (a.paperOrder || 999) - (b.paperOrder || 999));
        return { parent: { ...parent, id }, papers };
      }).filter(x => req.query.includeArchived === '1' || x.parent.status !== 'archived');
      if (req.user.role === 'teacher') items = items.filter(x => x.parent.createdBy === req.user.uid || x.papers.some(p => inTeacherScope(req.user, p, 'exams')));
      items = items.map(x => examinationSummary(x.parent, x.papers, counts)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      res.json({ items });
    } catch (e) { next(e); }
  });

  r.get('/examinations/summary', staffOnly, perm('examinations', 'view'), async (req, res, next) => {
    try {
      const iid = req.user.instituteId; if (!iid) return res.json({ summary: {} });
      await store.ensureMigrated(iid);
      await store.sweepExpired(iid);
      const [parents, exams, attempts, results, students] = await Promise.all(['examinations', 'exams', 'examAttempts', 'results', 'students'].map(k => db.get(`institutes/${iid}/${k}`)));
      const owner = isInstituteOwner(req.user);
      const papersBy = {};
      for (const [id, p] of Object.entries(exams || {})) if (p?.examinationId) (papersBy[p.examinationId] ||= []).push({ ...p, id });
      const visible = Object.entries(parents || {}).filter(([id, p]) => p.status !== 'archived' && (owner || p.createdBy === req.user.uid || (papersBy[id] || []).some(x => inTeacherScope(req.user, x, 'exams'))));
      const perExamination = [];
      const participants = new Set();
      let totalPapers = 0, totalAttempts = 0, completed = 0, pending = 0;
      for (const [id, parent] of visible) {
        const papers = (papersBy[id] || []).filter(p => p.status !== 'archived');
        const ids = new Set(papers.map(p => p.id));
        const att = Object.values(attempts || {}).filter(a => ids.has(a.examId));
        const res2 = Object.values(results || {}).filter(x => ids.has(x.examId) && (x.evaluationStatus || x.status) === 'evaluated');
        att.forEach(a => participants.add(a.studentUid));
        totalPapers += papers.length; totalAttempts += att.length;
        const done = att.filter(a => a.status === 'submitted').length; completed += done; pending += att.length - done;
        perExamination.push({
          id, name: parent.name, status: parent.status, papers: papers.length,
          participants: new Set(att.map(a => a.studentUid)).size, attempts: att.length, completedAttempts: done, pendingAttempts: att.length - done,
          averagePercentage: res2.length ? round2(res2.reduce((s, x) => s + (Number(x.percentage) || 0), 0) / res2.length) : null,
          passed: res2.filter(x => x.passStatus === 'pass').length, failed: res2.filter(x => x.passStatus === 'fail').length,
        });
      }
      const activeStudents = Object.values(students || {}).filter(s => s && !['archived', 'inactive'].includes(s.status)).length;
      res.json({ summary: {
        totalExaminations: visible.length, totalPapers, publishedExaminations: visible.filter(([, p]) => p.status === 'published').length,
        draftExaminations: visible.filter(([, p]) => p.status === 'draft').length, totalStudents: owner ? activeStudents : null,
        participatingStudents: participants.size, totalAttempts, completedAttempts: completed, pendingAttempts: pending, perExamination,
      } });
    } catch (e) { next(e); }
  });

  // =============== STAFF: CREATE / READ / UPDATE ===============
  r.post('/examinations', staffOnly, perm('examinations', 'create'), async (req, res, next) => {
    try {
      const iid = req.user.instituteId; if (!iid) throw err(403, 'Join an institute before creating examinations.');
      await store.ensureMigrated(iid);
      const { value, errors } = normalizeExaminationInput(req.body || {});
      if (errors.length) throw err(400, errors[0], errors);
      await validateTargets(iid, value);
      if (value.eligibleStudentIds?.length) await assertStudentsExist(iid, value.eligibleStudentIds);
      const id = db.key(), now = Date.now();
      const parent = { ...value, resultPolicy: value.resultPolicy || defaultResultPolicy(), eligibleStudentIds: value.eligibleStudentIds || [], id: undefined, status: 'draft', paperIds: [], createdBy: req.user.uid, createdAt: now, updatedAt: now, schemaVersion: 2 };
      parent.id = id;
      const updates = {};
      const incoming = Array.isArray(req.body.papers) ? req.body.papers : [];
      const paperIds = [];
      const prepared = [];
      for (let i = 0; i < incoming.length; i++) {
        const { value: input, errors: pe } = normalizePaperInput(incoming[i]);
        if (pe.length) throw err(400, `Paper ${i + 1}: ${pe[0]}`, pe);
        const ctx = await resolvePaperContext(req, iid, parent, input);
        prepared.push({ input, ctx, pid: db.key() });
        paperIds.push(prepared[prepared.length - 1].pid);
      }
      parent.paperIds = paperIds;
      prepared.forEach(({ input, ctx, pid }, i) => { updates[base(iid, 'exams', pid)] = strip(paperRecord({ parent, input, subject: ctx.subject, docs: ctx.docs, order: i + 1, siblingCount: prepared.length, id: pid })); });
      updates[base(iid, 'examinations', id)] = strip(parent);
      Object.assign(updates, audit(iid, req, 'examinations.created', id, { papers: prepared.length }));
      await db.update(updates);
      const papers = await store.loadPapers(iid, id);
      res.status(201).json({ item: examinationSummary(parent, papers) });
    } catch (e) { next(e); }
  });

  async function assertStudentsExist(iid, ids) {
    const students = (await db.get(`institutes/${iid}/students`)) || {};
    const bad = ids.filter(id => !students[id] || ['archived', 'inactive'].includes(students[id].status));
    if (bad.length) throw err(400, `Some eligible students do not exist in this institute (${bad.slice(0, 3).join(', ')}).`);
  }

  r.get('/examinations/:id', staffOnly, perm('examinations', 'view'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req);
      const ids = new Set(papers.map(p => p.id));
      await store.sweepExpired(iid, a => ids.has(a.examId));
      const [attempts, results, students] = await Promise.all(['examAttempts', 'results', 'students'].map(k => db.get(`institutes/${iid}/${k}`)));
      const myAttempts = Object.entries(attempts || {}).map(([id, a]) => ({ ...a, id })).filter(a => ids.has(a.examId));
      const myResults = Object.entries(results || {}).map(([id, x]) => ({ ...x, id })).filter(x => ids.has(x.examId));
      let eligible = null;
      const explicit = asArray(parent.eligibleStudentIds);
      if (explicit.length) eligible = explicit.length;
      else {
        eligible = 0;
        for (const s of Object.values(students || {})) {
          if (!s || ['archived', 'inactive'].includes(s.status)) continue;
          if (await store.matchesStudentTarget(iid, parent, s, parent.legacy ? ['departmentId', 'courseId', 'classId', 'sectionId', 'batchId'] : TARGET_FIELDS)) eligible++;
        }
      }
      const live = papers.filter(p => p.status !== 'archived');
      const paperStats = live.map(p => summarizePaperStats({ paper: p, attempts: myAttempts.filter(a => a.examId === p.id), results: myResults.filter(x => x.examId === p.id), eligibleCount: eligible }));
      res.json({
        examination: examinationSummary(parent, papers, countAttempts(Object.fromEntries(myAttempts.map(a => [a.id, a])))),
        paperStats, canManage: canManage(req.user, parent),
        totals: { papers: live.length, totalMarks: round2(live.reduce((s, p) => s + (Number(p.totalMarks) || 0), 0)), participants: new Set(myAttempts.map(a => a.studentUid)).size, eligibleStudents: eligible },
      });
    } catch (e) { next(e); }
  });

  r.patch('/examinations/:id', staffOnly, perm('examinations', 'edit'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      if (parent.status === 'archived') throw err(409, 'Archived examinations cannot be edited.');
      const { value, errors } = normalizeExaminationInput(req.body || {}, { partial: true });
      if (errors.length) throw err(400, errors[0], errors);
      const targetChanged = TARGET_FIELDS.some(k => value[k] !== undefined && String(value[k] || '') !== String(parent[k] || ''));
      if (targetChanged) {
        const attempts = (await db.get(`institutes/${iid}/examAttempts`)) || {};
        if (papers.some(p => Object.values(attempts).some(a => a.examId === p.id))) throw err(409, 'The academic target cannot change after students have attempted a paper.');
        await validateTargets(iid, { ...targetOf(parent), ...value });
      }
      if (value.eligibleStudentIds?.length) await assertStudentsExist(iid, value.eligibleStudentIds);
      const next2 = { ...parent, ...value, updatedAt: Date.now(), updatedBy: req.user.uid };
      const updates = { [base(iid, 'examinations', parent.id)]: strip(next2) };
      for (const p of papers) {
        const patch = { ...(value.name !== undefined ? { name: `${next2.name} — ${p.paperName || p.subjectName}`, examGroupName: next2.name } : {}), ...(targetChanged ? targetOf(next2) : {}) };
        for (const [k, v] of Object.entries(patch)) updates[`${base(iid, 'exams', p.id)}/${k}`] = v;
      }
      Object.assign(updates, audit(iid, req, 'examinations.updated', parent.id, { changes: Object.keys(value) }));
      await db.update(updates);
      res.json({ item: examinationSummary(next2, papers.map(p => ({ ...p, ...(value.name !== undefined ? { name: `${next2.name} — ${p.paperName || p.subjectName}` } : {}) }))) });
    } catch (e) { next(e); }
  });

  // =============== STAFF: PAPERS ===============
  const lockedKeys = ['questionIds', 'questionMarks', 'negativeMarking', 'examMode', 'subjectId', 'totalMarks'];
  r.post('/examinations/:id/papers', staffOnly, perm('examinations', 'edit'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      if (parent.status === 'archived') throw err(409, 'Archived examinations cannot be edited.');
      const { value, errors } = normalizePaperInput(req.body || {});
      if (errors.length) throw err(400, errors[0], errors);
      const ctx = await resolvePaperContext(req, iid, parent, value);
      const live = papers.filter(p => p.status !== 'archived');
      const pid = db.key(), order = live.length + 1;
      const rec = strip(paperRecord({ parent, input: value, subject: ctx.subject, docs: ctx.docs, order, siblingCount: live.length + 1, id: pid }));
      const updates = {
        [base(iid, 'exams', pid)]: rec,
        [`${base(iid, 'examinations', parent.id)}/paperIds`]: [...asArray(parent.paperIds), pid],
        [`${base(iid, 'examinations', parent.id)}/updatedAt`]: Date.now(),
        ...audit(iid, req, 'examinations.paper_added', parent.id, { paperId: pid }),
      };
      for (const p of live) updates[`${base(iid, 'exams', p.id)}/paperCount`] = live.length + 1;
      await db.update(updates);
      res.status(201).json({ paper: publicPaper({ ...rec, id: pid }), note: parent.status === 'published' ? 'The new paper is a draft. Publish the examination to release it to students.' : undefined });
    } catch (e) { next(e); }
  });

  r.patch('/examinations/:id/papers/:paperId', staffOnly, perm('examinations', 'edit'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const paper = papers.find(p => p.id === req.params.paperId);
      if (!paper) throw err(404, 'Paper not found in this examination.');
      if (paper.status === 'archived' || parent.status === 'archived') throw err(409, 'Archived papers cannot be edited.');
      const { value, errors } = normalizePaperInput(req.body || {}, { existing: paper });
      if (errors.length) throw err(400, errors[0], errors);
      const [attempts, results] = await Promise.all([db.get(`institutes/${iid}/examAttempts`), db.get(`institutes/${iid}/results`)]);
      if (paperHistory(paper.id, attempts, results)) {
        const changed = lockedKeys.filter(k => req.body?.[k] !== undefined && JSON.stringify(req.body[k]) !== JSON.stringify(paper[k]));
        if (changed.length) throw err(409, `Students have already attempted this paper; these fields can no longer change: ${changed.join(', ')}.`);
      }
      const merged = { ...paper, ...value };
      const ctx = await resolvePaperContext(req, iid, parent, merged);
      const live = papers.filter(p => p.status !== 'archived');
      const rec = strip(paperRecord({ parent, existing: strip(paper), input: value, subject: ctx.subject, docs: ctx.docs, order: paper.paperOrder, siblingCount: live.length, id: paper.id }));
      if (paper.status === 'published') {
        const check = validatePaperForPublish({ ...rec }, await loadQuestionMap(iid, rec));
        if (check.errors.length) throw err(400, `A published paper must remain valid: ${check.errors[0]}`, check.errors);
      }
      await db.update({ [base(iid, 'exams', paper.id)]: rec, ...audit(iid, req, 'examinations.paper_updated', parent.id, { paperId: paper.id, changes: Object.keys(value) }) });
      res.json({ paper: publicPaper({ ...rec, id: paper.id }) });
    } catch (e) { next(e); }
  });

  async function loadQuestionMap(iid, paper) {
    const ids = questionIdsOf(paper), rows = await Promise.all(ids.map(id => db.get(base(iid, 'questionBanks', id))));
    return Object.fromEntries(ids.map((id, i) => [id, rows[i]]));
  }

  r.delete('/examinations/:id/papers/:paperId', staffOnly, perm('examinations', 'edit'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const paper = papers.find(p => p.id === req.params.paperId);
      if (!paper) throw err(404, 'Paper not found in this examination.');
      if (paper.status === 'published') throw err(409, 'Published papers cannot be removed. Unpublish the examination first.');
      const [attempts, results] = await Promise.all([db.get(`institutes/${iid}/examAttempts`), db.get(`institutes/${iid}/results`)]);
      if (paperHistory(paper.id, attempts, results)) throw err(409, 'This paper has student attempts or results and cannot be removed. Archive the examination instead.');
      const rest = papers.filter(p => p.id !== paper.id && p.status !== 'archived');
      const updates = {
        [base(iid, 'exams', paper.id)]: null,
        [`${base(iid, 'examinations', parent.id)}/paperIds`]: rest.map(p => p.id),
        [`${base(iid, 'examinations', parent.id)}/updatedAt`]: Date.now(),
        ...audit(iid, req, 'examinations.paper_removed', parent.id, { paperId: paper.id }),
      };
      rest.forEach((p, i) => { updates[`${base(iid, 'exams', p.id)}/paperOrder`] = i + 1; updates[`${base(iid, 'exams', p.id)}/paperCount`] = rest.length; });
      await db.update(updates);
      res.json({ removed: true });
    } catch (e) { next(e); }
  });

  r.put('/examinations/:id/papers-order', staffOnly, perm('examinations', 'edit'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const live = papers.filter(p => p.status !== 'archived');
      const order = asArray(req.body?.paperIds).map(String);
      if (order.length !== live.length || new Set(order).size !== order.length || !live.every(p => order.includes(p.id))) throw err(400, 'Provide every paper id exactly once.');
      const updates = { [`${base(iid, 'examinations', parent.id)}/paperIds`]: order, [`${base(iid, 'examinations', parent.id)}/updatedAt`]: Date.now(), ...audit(iid, req, 'examinations.papers_reordered', parent.id) };
      order.forEach((id, i) => { updates[`${base(iid, 'exams', id)}/paperOrder`] = i + 1; });
      await db.update(updates);
      res.json({ reordered: true });
    } catch (e) { next(e); }
  });

  r.get('/examinations/:id/papers/:paperId/preview', staffOnly, perm('examinations', 'view'), async (req, res, next) => {
    try {
      const { iid, papers } = await requireParent(req);
      const paper = papers.find(p => p.id === req.params.paperId);
      if (!paper) throw err(404, 'Paper not found in this examination.');
      const map = await loadQuestionMap(iid, paper);
      const questions = questionIdsOf(paper).map(id => {
        const q = map[id]; if (!q) return { id, missing: true };
        const type = q.questionType || 'mcq';
        return { id, text: q.name, questionType: type, marks: Number(paper.questionMarks?.[id] ?? q.marks) || 0,
          options: type === 'mcq' ? OPTION_KEYS.map(k => q[k]).filter(Boolean) : [],
          correctOption: type === 'mcq' ? (q[`option${String(q.correctOption || '').toUpperCase()}`] || null) : null, modelAnswer: q.modelAnswer || '' };
      });
      res.json({ paper: publicPaper(paper), questions });
    } catch (e) { next(e); }
  });

  // =============== STAFF: PUBLISH / UNPUBLISH / ARCHIVE / DELETE ===============
  async function publishExamination(req, res, next) {
    try {
      if (!can(req.user, 'examinations', 'publish')) throw err(403, 'Examination publication permission is required.');
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      if (parent.status === 'archived') throw err(409, 'Archived examinations cannot be published.');
      const live = papers.filter(p => p.status !== 'archived');
      if (!live.length) throw err(400, 'Add at least one paper before publishing.');
      const ids = live.map(p => p.id);
      if (new Set(ids).size !== ids.length) throw err(400, 'Duplicate paper ids detected.');
      const indexed = asArray(parent.paperIds).map(String);
      if (!indexed.length || ids.some(id => !indexed.includes(id)) || indexed.some(id => !papers.some(p => p.id === id))) throw err(409, 'Examination/paper relationships are inconsistent. Run the migration check or contact support.');
      const details = [];
      const totals = {};
      for (const p of live) {
        if (req.user.role === 'teacher') assertScope(req.user, p, 'exams');
        if (p.examinationId !== parent.id) { details.push({ paperId: p.id, paperName: p.paperName, errors: ['Paper does not belong to this examination.'] }); continue; }
        const check = validatePaperForPublish(p, await loadQuestionMap(iid, p));
        totals[p.id] = check.total;
        if (check.errors.length) details.push({ paperId: p.id, paperName: p.paperName || p.name, errors: check.errors });
      }
      if (details.length) throw err(400, `${details.length} paper(s) cannot be published: ${details[0].paperName} — ${details[0].errors[0]}`, details);
      if (parent.status === 'published' && live.every(p => p.status === 'published')) return res.json({ published: true, alreadyPublished: true, papers: live.length });
      const now = Date.now();
      const updates = { [`${base(iid, 'examinations', parent.id)}/status`]: 'published', [`${base(iid, 'examinations', parent.id)}/publishedAt`]: parent.publishedAt || now, [`${base(iid, 'examinations', parent.id)}/updatedAt`]: now };
      for (const p of live) {
        updates[`${base(iid, 'exams', p.id)}/totalMarks`] = totals[p.id];
        if (p.status !== 'published') { updates[`${base(iid, 'exams', p.id)}/status`] = 'published'; updates[`${base(iid, 'exams', p.id)}/publishedAt`] = now; }
      }
      Object.assign(updates, audit(iid, req, 'examinations.published', parent.id, { papers: live.length }));
      await db.update(updates);
      res.json({ published: true, papers: live.length, totalMarks: round2(Object.values(totals).reduce((a, b) => a + b, 0)) });
    } catch (e) { next(e); }
  }
  r.post('/examinations/:id/publish', staffOnly, publishExamination);
  // Legacy per-paper publish now publishes the parent so papers can never diverge.
  r.post('/exams/:id/publish', staffOnly, async (req, res, next) => {
    try {
      const iid = req.user.instituteId; await store.ensureMigrated(iid);
      const paper = iid ? await db.get(base(iid, 'exams', req.params.id)) : null;
      if (!paper?.examinationId) return res.status(404).json({ message: 'Examination not found.' });
      req.params.id = paper.examinationId;
      return publishExamination(req, res, next);
    } catch (e) { next(e); }
  });

  r.post('/examinations/:id/unpublish', staffOnly, async (req, res, next) => {
    try {
      if (!can(req.user, 'examinations', 'unpublish') && !can(req.user, 'examinations', 'publish')) throw err(403, 'Examination unpublish permission is required.');
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      if (parent.status !== 'published') throw err(409, 'The examination is not published.');
      const now = Date.now();
      const updates = { [`${base(iid, 'examinations', parent.id)}/status`]: 'draft', [`${base(iid, 'examinations', parent.id)}/unpublishedAt`]: now, [`${base(iid, 'examinations', parent.id)}/updatedAt`]: now };
      for (const p of papers.filter(x => x.status === 'published')) updates[`${base(iid, 'exams', p.id)}/status`] = 'draft';
      Object.assign(updates, audit(iid, req, 'examinations.unpublished', parent.id));
      await db.update(updates);
      res.json({ unpublished: true, note: 'Students can no longer start papers. Attempts already in progress can still be submitted; published results are unchanged.' });
    } catch (e) { next(e); }
  });

  async function archiveParent(iid, req, parent, papers) {
    const now = Date.now();
    const updates = { [`${base(iid, 'examinations', parent.id)}/status`]: 'archived', [`${base(iid, 'examinations', parent.id)}/archivedAt`]: now };
    for (const p of papers) { updates[`${base(iid, 'exams', p.id)}/status`] = 'archived'; updates[`${base(iid, 'exams', p.id)}/archivedAt`] = now; }
    Object.assign(updates, audit(iid, req, 'examinations.archived', parent.id));
    await db.update(updates);
  }
  r.post('/examinations/:id/archive', staffOnly, async (req, res, next) => {
    try {
      if (!can(req.user, 'examinations', 'archive') && !can(req.user, 'examinations', 'delete') && !can(req.user, 'examinations', 'edit')) throw err(403, 'Examination archive permission is required.');
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      await archiveParent(iid, req, parent, papers);
      res.json({ archived: true });
    } catch (e) { next(e); }
  });

  r.delete('/examinations/:id', staffOnly, async (req, res, next) => {
    try {
      if (!can(req.user, 'examinations', 'delete')) throw err(403, 'Examination delete permission is required.');
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const [attempts, results] = await Promise.all([db.get(`institutes/${iid}/examAttempts`), db.get(`institutes/${iid}/results`)]);
      if (papers.some(p => paperHistory(p.id, attempts, results))) {
        await archiveParent(iid, req, parent, papers);
        return res.json({ archived: true, deleted: false, message: 'Historical attempts or results exist, so the examination was archived instead of deleted.' });
      }
      const updates = { [base(iid, 'examinations', parent.id)]: null, ...audit(iid, req, 'examinations.deleted', parent.id) };
      for (const p of papers) { updates[base(iid, 'exams', p.id)] = null; updates[`institutes/${iid}/attemptCounts/${p.id}`] = null; }
      await db.update(updates);
      res.json({ deleted: true, archived: false });
    } catch (e) { next(e); }
  });

  // Manual reconciliation of ambiguous legacy data: move papers of other examinations into this one.
  r.post('/examinations/:id/absorb', allow('institute_owner', 'institute_admin'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const sources = [...new Set(asArray(req.body?.sourceExaminationIds).map(String))].filter(x => x !== parent.id);
      if (!sources.length) throw err(400, 'Provide sourceExaminationIds.');
      const all = (await db.get(`institutes/${iid}/exams`)) || {};
      const [attempts, results] = await Promise.all([db.get(`institutes/${iid}/examAttempts`), db.get(`institutes/${iid}/results`)]);
      const moved = [];
      const updates = {};
      let order = papers.filter(p => p.status !== 'archived').length;
      for (const sid of sources) {
        const src = await store.loadExamination(iid, sid);
        if (!src) throw err(404, `Examination ${sid} not found.`);
        if (src.status !== parent.status) throw err(409, 'Examinations must share the same publication status before they can be merged.');
        if (TARGET_FIELDS.some(k => String(src[k] || '') !== String(parent[k] || ''))) throw err(409, `Examination “${src.name}” has a different academic target and cannot be merged.`);
        const srcPapers = await store.loadPapers(iid, sid, all);
        for (const p of srcPapers) {
          order++; moved.push(p.id);
          Object.assign(updates, {
            [`${base(iid, 'exams', p.id)}/examinationId`]: parent.id, [`${base(iid, 'exams', p.id)}/paperOrder`]: order,
            [`${base(iid, 'exams', p.id)}/examGroupId`]: parent.id, [`${base(iid, 'exams', p.id)}/examGroupName`]: parent.name,
            [`${base(iid, 'exams', p.id)}/name`]: `${parent.name} — ${p.paperName || p.subjectName}`, [`${base(iid, 'exams', p.id)}/createdBy`]: parent.createdBy,
          });
          for (const [id, a] of Object.entries(attempts || {})) if (a.examId === p.id && a.examinationId) updates[`${base(iid, 'examAttempts', id)}/examinationId`] = parent.id;
          for (const [id, x] of Object.entries(results || {})) if (x.examId === p.id && x.examinationId) updates[`${base(iid, 'results', id)}/examinationId`] = parent.id;
        }
        updates[base(iid, 'examinations', sid)] = null;
      }
      const finalIds = [...papers.filter(p => p.status !== 'archived').map(p => p.id), ...moved];
      updates[`${base(iid, 'examinations', parent.id)}/paperIds`] = finalIds;
      finalIds.forEach(id => { updates[`${base(iid, 'exams', id)}/paperCount`] = finalIds.length; });
      Object.assign(updates, audit(iid, req, 'examinations.absorbed', parent.id, { moved }));
      await db.update(updates);
      res.json({ absorbed: true, movedPapers: moved.length });
    } catch (e) { next(e); }
  });

  // =============== STAFF: RESULTS ===============
  r.get('/examinations/:id/results', staffOnly, perm('results', 'view'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req);
      const live = papers.filter(p => p.status !== 'archived');
      const ids = new Set(live.map(p => p.id));
      const results = (await db.get(`institutes/${iid}/results`)) || {};
      const byStudent = new Map();
      for (const [id, x] of Object.entries(results)) {
        if (!ids.has(x.examId)) continue;
        const key = x.studentUid || x.studentRecordId;
        if (!byStudent.has(key)) byStudent.set(key, { studentUid: x.studentUid || null, studentRecordId: x.studentRecordId || null, studentName: x.studentName, byPaper: new Map() });
        const row = byStudent.get(key);
        if (!row.byPaper.has(x.examId)) row.byPaper.set(x.examId, []);
        row.byPaper.get(x.examId).push({ ...x, id });
      }
      const items = [...byStudent.values()].map(s => {
        const overall = computeOverallResult({ parent, papers: live, resultsByPaper: s.byPaper });
        const everything = [...s.byPaper.values()].flat();
        return { studentUid: s.studentUid, studentRecordId: s.studentRecordId, studentName: s.studentName, ...overall, allPublished: everything.length > 0 && everything.every(x => x.publicationStatus === 'published') };
      }).sort((a, b) => String(a.studentName).localeCompare(String(b.studentName)));
      res.json({ examination: { id: parent.id, name: parent.name, resultPolicy: { ...defaultResultPolicy(), ...(parent.resultPolicy || {}) } }, items });
    } catch (e) { next(e); }
  });

  r.post('/examinations/:id/results/publish', staffOnly, perm('results', 'publish'), async (req, res, next) => {
    try {
      const { iid, parent, papers } = await requireParent(req, { manage: true });
      const ids = new Set(papers.map(p => p.id));
      const results = (await db.get(`institutes/${iid}/results`)) || {};
      const now = Date.now(), updates = {}; let published = 0, skipped = 0;
      for (const [id, x] of Object.entries(results)) {
        if (!ids.has(x.examId) || x.publicationStatus === 'published') continue;
        if ((x.evaluationStatus || x.status) !== 'evaluated') { skipped++; continue; }
        updates[`${base(iid, 'results', id)}/publicationStatus`] = 'published'; updates[`${base(iid, 'results', id)}/publishedAt`] = now; updates[`${base(iid, 'results', id)}/publishedBy`] = req.user.uid; published++;
      }
      Object.assign(updates, audit(iid, req, 'results.bulk_published', parent.id, { published, skipped }));
      await db.update(updates);
      res.json({ published, skippedAwaitingGrading: skipped });
    } catch (e) { next(e); }
  });

  // =============== STUDENT ===============
  async function studentContext(req) {
    if (!store.isApprovedStudent(req.user)) throw err(403, 'Approved institute admission is required.');
    const iid = req.user.instituteId;
    await store.ensureMigrated(iid);
    const identity = await store.getStudentIdentity(req.user);
    const stored = await db.get(base(iid, 'students', req.user.studentRecordId || req.user.uid));
    return { iid, identity, student: stored || req.user.studentRecord || null };
  }
  const ownsRecord = (identity, x) => x.studentUid === identity.uid || identity.recordIds.has(String(x.studentRecordId || ''));

  async function studentExaminationView(ctx, parent, papers, attemptsAll, resultsAll, now) {
    const own = Object.entries(attemptsAll || {}).map(([id, a]) => ({ ...a, id })).filter(a => ownsRecord(ctx.identity, a));
    const policy = { ...defaultResultPolicy(), ...(parent.resultPolicy || {}) };
    const ownResults = Object.entries(resultsAll || {}).map(([id, x]) => ({ ...x, id })).filter(x => ownsRecord(ctx.identity, x));
    const items = papers.filter(p => p.status !== 'archived').map(p => {
      const mine = own.filter(a => a.examId === p.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      const access = computePaperAccess({ parent, paper: p, attempts: mine, now });
      const published = selectPaperResult(ownResults.filter(x => x.examId === p.id && x.publicationStatus === 'published'), policy.attemptSelection);
      return {
        id: p.id, examinationId: parent.id, paperName: p.paperName || p.name, subjectId: p.subjectId || '', subjectName: p.subjectName || '',
        description: p.description || '', instructions: p.paperInstructions || '', examMode: p.examMode || 'online', order: p.paperOrder || 1,
        totalMarks: p.totalMarks ?? 0, passingMarks: p.passingMarks ?? 0, durationMinutes: p.durationMinutes ?? null,
        startAt: p.startAt || null, endAt: p.endAt || null, negativeMarking: p.negativeMarking ?? 0,
        ...access,
        attempts: mine.map((a, i) => ({ id: a.id, attemptNumber: a.attemptNumber || i + 1, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt || null })),
        result: published ? { resultId: published.id, score: published.score, totalMarks: published.totalMarks, percentage: published.percentage, passStatus: published.passStatus } : null,
      };
    });
    return { items, ownResults, policy };
  }

  async function eligibleParents(req, ctx) {
    const iid = ctx.iid;
    const [parents, exams] = await Promise.all([db.get(`institutes/${iid}/examinations`), db.get(`institutes/${iid}/exams`)]);
    const byParent = {};
    for (const [id, p] of Object.entries(exams || {})) if (p?.examinationId) (byParent[p.examinationId] ||= []).push({ ...p, id });
    const out = [];
    for (const [id, parent0] of Object.entries(parents || {})) {
      const parent = { ...parent0, id };
      if (parent.status !== 'published') continue;
      const papers = (byParent[id] || []).filter(p => p.status === 'published').sort((a, b) => (a.paperOrder || 999) - (b.paperOrder || 999));
      if (!papers.length) continue;
      if (!papers.some(p => (p.examMode || 'online') === 'online')) continue;
      if (!(await store.studentEligible(iid, parent, papers[0], ctx.student, ctx.identity.recordIds))) continue;
      out.push({ parent, papers, allPapers: byParent[id] || [] });
    }
    return out;
  }

  const studentList = async (req, res, next) => {
    try {
      const ctx = await studentContext(req).catch(e => { if (e.status === 403) return null; throw e; });
      if (!ctx) return res.json({ items: [], serverNow: Date.now() });
      const [{ attempts }, results] = await Promise.all([store.sweepExpiredForStudent(ctx.iid, ctx.identity), store.loadStudentResults(ctx.iid, ctx.identity)]);
      const now = Date.now();
      const items = [];
      for (const { parent, papers } of await eligibleParents(req, ctx)) {
        const view = await studentExaminationView(ctx, parent, papers, attempts, results, now);
        const summary = summarizeExaminationStates(view.items.map(p => p.state));
        const upcoming = view.items.filter(p => p.state === 'upcoming').map(p => toMs(p.startAt)).filter(Number.isFinite).sort((a, b) => a - b);
        items.push({
          id: parent.id, name: parent.name, description: parent.description || '', examType: parent.examType || 'other',
          paperCount: view.items.length, status: summary.status, counts: summary.counts,
          totalMarks: round2(view.items.reduce((s, p) => s + (Number(p.totalMarks) || 0), 0)),
          nextStartAt: upcoming.length ? new Date(upcoming[0]).toISOString() : null,
          lastEndAt: view.items.map(p => p.endAt).filter(Boolean).sort().pop() || null,
          // Back-compat for older clients.
          durationMinutes: null, subjectName: '',
        });
      }
      const rank = { in_progress: 0, available: 1, upcoming: 2, locked: 3, completed: 4, expired: 5 };
      items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.name).localeCompare(b.name));
      res.json({ items, serverNow: now });
    } catch (e) { next(e); }
  };
  r.get('/student/examinations', studentList);
  r.get('/student/exams', studentList);

  r.get('/student/examinations/:id', async (req, res, next) => {
    try {
      const ctx = await studentContext(req);
      const eligible = (await eligibleParents(req, ctx)).find(x => x.parent.id === req.params.id);
      if (!eligible) throw err(404, 'Examination not found or not available to you.');
      const [{ attempts }, results] = await Promise.all([store.sweepExpiredForStudent(ctx.iid, ctx.identity), store.loadStudentResults(ctx.iid, ctx.identity)]);
      const now = Date.now();
      const view = await studentExaminationView(ctx, eligible.parent, eligible.allPapers.sort((a, b) => (a.paperOrder || 999) - (b.paperOrder || 999)), attempts, results, now);
      res.json({
        examination: { id: eligible.parent.id, name: eligible.parent.name, description: eligible.parent.description || '', instructions: eligible.parent.instructions || '', examType: eligible.parent.examType || 'other' },
        papers: view.items.filter(p => p.state !== 'not_published'), serverNow: now,
      });
    } catch (e) { next(e); }
  });

  r.get('/student/examinations/:id/results', async (req, res, next) => {
    try {
      const ctx = await studentContext(req);
      const eligible = (await eligibleParents(req, ctx)).find(x => x.parent.id === req.params.id);
      if (!eligible) throw err(404, 'Examination not found or not available to you.');
      const results = await store.loadStudentResults(ctx.iid, ctx.identity);
      const own = Object.entries(results).map(([id, x]) => ({ ...x, id })).filter(x => ownsRecord(ctx.identity, x) && eligible.papers.some(p => p.id === x.examId));
      const published = new Map(), pending = new Set();
      for (const x of own) {
        if (x.publicationStatus === 'published') { if (!published.has(x.examId)) published.set(x.examId, []); published.get(x.examId).push(x); } else pending.add(x.examId);
      }
      const overall = computeOverallResult({ parent: eligible.parent, papers: eligible.papers, resultsByPaper: published });
      overall.rows = overall.rows.map(row => (!row.attempted && pending.has(row.paperId) ? { ...row, passStatus: 'result_pending' } : row));
      res.json({ examination: { id: eligible.parent.id, name: eligible.parent.name }, ...overall });
    } catch (e) { next(e); }
  });

  r.get('/student/examinations/:id/papers/:paperId/attempts', async (req, res, next) => {
    try {
      const ctx = await studentContext(req);
      const paper = await db.get(base(ctx.iid, 'exams', req.params.paperId));
      if (!paper || paper.examinationId !== req.params.id) throw err(404, 'Paper not found.');
      const attempts = await store.loadStudentAttempts(ctx.iid, ctx.identity);
      const items = Object.entries(attempts).map(([id, a]) => ({ ...a, id })).filter(a => a.examId === paper.id && ownsRecord(ctx.identity, a))
        .map(a => ({ id: a.id, attemptNumber: a.attemptNumber || null, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt || null, autoSubmitted: a.autoSubmitted === true })).sort((a, b) => a.startedAt - b.startedAt);
      res.json({ items });
    } catch (e) { next(e); }
  });

  const publicQuestions = qs => qs.map(({ correctOption, modelAnswer, ...q }) => q);
  const attemptPayload = (a, extra = {}) => ({
    attemptId: a.id, examinationId: a.examinationId || a.snapshot?.examinationId || null, paperId: a.examId,
    examName: a.snapshot.examName, examinationName: a.snapshot.examinationName || a.snapshot.examName, paperName: a.snapshot.paperName || '',
    attemptNumber: a.attemptNumber || 1, questions: publicQuestions(a.snapshot.questions || []),
    answers: a.answers || {}, review: a.review || {}, startedAt: a.startedAt, expiresAt: a.expiresAt, serverNow: Date.now(), ...extra,
  });

  async function startPaper(req, res, next, examinationId, paperId) {
    let lockPath = null;
    try {
      const ctx = await studentContext(req);
      const { iid, identity } = ctx;
      const [parent0, paper0] = await Promise.all([db.get(base(iid, 'examinations', examinationId)), db.get(base(iid, 'exams', paperId))]);
      if (!parent0 || !paper0 || paper0.examinationId !== examinationId) throw err(404, 'Paper not found in this examination.');
      const parent = { ...parent0, id: examinationId }, paper = { ...paper0, id: paperId };
      if (parent.status !== 'published' || paper.status !== 'published') throw err(404, 'This paper is not published.');
      if ((paper.examMode || 'online') !== 'online') throw err(404, 'Online paper is unavailable.');
      if (!(await store.studentEligible(iid, parent, paper, ctx.student, identity.recordIds))) throw err(403, 'This examination is not assigned to you.');

      lockPath = `institutes/${iid}/attemptLocks/${paperId}_${req.user.uid}`;
      const lock = await db.transaction(lockPath, cur => (cur && Date.now() - Number(cur) < 15000 ? undefined : Date.now()));
      if (!lock?.committed) { lockPath = null; throw err(409, 'Your attempt is already being started. Please wait a moment.'); }

      const { attempts: all } = await store.sweepExpiredForStudent(iid, identity);
      const mine = Object.entries(all).map(([id, a]) => ({ ...a, id })).filter(a => a.examId === paperId && ownsRecord(identity, a));
      const now = Date.now();
      const access = computePaperAccess({ parent, paper, attempts: mine, now });
      if (access.activeAttemptId) {
        const active = mine.find(a => a.id === access.activeAttemptId);
        return res.json(attemptPayload(active, { resumed: true }));
      }
      if (!access.canStart) throw err(access.state === 'completed' ? 409 : 403, access.reason || 'This paper is not available.');

      const ids = questionIdsOf(paper);
      const source = await Promise.all(ids.map(id => db.get(base(iid, 'questionBanks', id))));
      if (!source.length || source.some(q => !q)) throw err(400, 'Paper questions are not configured.');
      const max = attemptLimit(paper), countPath = `institutes/${iid}/attemptCounts/${paperId}/${req.user.uid}`;
      let reserved = false, number = 0;
      await db.transaction(countPath, cur => {
        const count = Math.max(cur === null || cur === undefined ? 0 : Number(cur) || 0, mine.length);
        if (count >= max) { reserved = false; return cur === undefined ? null : cur; }
        reserved = true; number = count + 1; return count + 1;
      });
      if (!reserved) throw err(409, 'You have used all allowed attempts.');
      const questions = source.map((q, i) => {
        const type = q.questionType || 'mcq', key = String(q.correctOption || '').toUpperCase();
        return {
          id: ids[i], text: q.name, questionType: type, modelAnswer: q.modelAnswer || '',
          options: type === 'mcq' ? OPTION_KEYS.map(k => q[k]).filter(Boolean) : [],
          correctOption: type === 'mcq' ? (q[`option${key}`] || q.correctOption) : null,
          marks: Number(paper.questionMarks?.[ids[i]] ?? q.marks) || 1,
        };
      });
      const id = db.key(), duration = Math.max(1, Number(paper.durationMinutes) || 30), end = toMs(paper.endAt);
      const snapshot = {
        examinationId, examinationName: parent.name, paperId, paperName: paper.paperName || '', examName: paper.name || parent.name,
        subjectName: paper.subjectName || '', examGroupId: parent.id, examGroupName: parent.name, paperOrder: paper.paperOrder || 1, paperCount: paper.paperCount || 1,
        ...Object.fromEntries(TARGET_FIELDS.map(k => [k, paper[k] || parent[k] || ''])), subjectId: paper.subjectId || '',
        totalMarks: round2(questions.reduce((s, q) => s + q.marks, 0)), passingMarks: Number(paper.passingMarks) || 0,
        negativeMarking: Number(paper.negativeMarking) || 0, durationMinutes: duration, questions,
      };
      const attempt = {
        id, examId: paperId, examinationId, paperId, attemptNumber: number, studentUid: req.user.uid,
        studentRecordId: req.user.studentRecordId || req.user.uid, studentName: req.user.name, status: 'in_progress',
        startedAt: now, expiresAt: Number.isFinite(end) ? Math.min(now + duration * 60000, end) : now + duration * 60000, snapshot, answers: {}, createdAt: now,
      };
      try { await db.set(base(iid, 'examAttempts', id), attempt); }
      catch (saveError) { await db.transaction(countPath, cur => Math.max(0, (Number(cur) || 1) - 1)); throw saveError; }
      res.status(201).json(attemptPayload(attempt, { resumed: false }));
    } catch (e) { next(e); }
    finally { if (lockPath) await db.remove(lockPath).catch(() => {}); }
  }
  r.post('/student/examinations/:id/papers/:paperId/start', (req, res, next) => startPaper(req, res, next, req.params.id, req.params.paperId));
  // Legacy entry point (paper id only).
  r.post('/student/exams/:id/start', async (req, res, next) => {
    try {
      const iid = req.user.instituteId; await store.ensureMigrated(iid);
      const paper = iid ? await db.get(base(iid, 'exams', req.params.id)) : null;
      if (!paper?.examinationId) return res.status(404).json({ message: 'Online examination is unavailable.' });
      return startPaper(req, res, next, paper.examinationId, req.params.id);
    } catch (e) { next(e); }
  });

  async function ownAttempt(req) {
    const iid = req.user.instituteId;
    if (req.user.role !== 'student' || !iid) throw err(403, 'Student access required.');
    const identity = await store.getStudentIdentity(req.user);
    const path = base(iid, 'examAttempts', req.params.id), a = await db.get(path);
    if (!a || !ownsRecord(identity, a)) throw err(404, 'Attempt not found.');
    return { iid, path, a: { ...a, id: req.params.id } };
  }

  r.get('/student/attempts/:id', async (req, res, next) => {
    try {
      const { iid, a } = await ownAttempt(req);
      if (a.status === 'in_progress' && toMs(a.expiresAt) <= Date.now()) { await store.finalizeAttempt(iid, a); throw err(404, 'Active attempt not found.'); }
      if (a.status !== 'in_progress') throw err(404, 'Active attempt not found.');
      res.json(attemptPayload(a));
    } catch (e) { next(e); }
  });

  r.put('/student/attempts/:id/answers', async (req, res, next) => {
    try {
      const { path, a } = await ownAttempt(req);
      if (a.status !== 'in_progress') throw err(409, 'This attempt has already been submitted.');
      if (Date.now() >= toMs(a.expiresAt)) throw err(409, 'Time has expired. Submit your attempt.');
      const allowed = new Map((a.snapshot.questions || []).map(q => [q.id, q])), cleanAnswers = { ...(a.answers || {}) }, updates = {};
      for (const [id, value] of Object.entries(req.body?.answers || {})) {
        const q = allowed.get(id); if (!q) continue;
        const valid = q.questionType === 'mcq' ? (q.options || []).includes(value) : (typeof value === 'string' && value.length <= 10000);
        if (valid) { cleanAnswers[id] = value; updates[`${path}/answers/${id}`] = value; }
      }
      for (const [id, flag] of Object.entries(req.body?.review || {})) {
        if (!allowed.has(id)) continue;
        updates[`${path}/review/${id}`] = flag === true ? true : null;
      }
      if (Object.keys(updates).length) { const t = Date.now(); updates[`${path}/answersUpdatedAt`] = t; updates[`${path}/lastAnswerSavedAt`] = t; await db.update(updates); }
      res.json({ saved: true, answers: cleanAnswers, serverNow: Date.now(), expiresAt: a.expiresAt });
    } catch (e) { next(e); }
  });

  r.post('/student/attempts/:id/submit', async (req, res, next) => {
    try {
      const { iid, a } = await ownAttempt(req);
      const message = 'Your examination has been submitted. The result will be available after your institute publishes it.';
      const examinationId = a.examinationId || a.snapshot?.examinationId || null;
      if (a.status === 'submitted') { await store.repairMissingResult(iid, a); return res.json({ submitted: true, message, examinationId }); }
      await store.finalizeAttempt(iid, a);
      res.json({ submitted: true, message, examinationId });
    } catch (e) { next(e); }
  });

  // Grouped history for the student: parent examination -> papers -> attempts (+ published results only).
  r.get('/student/history', async (req, res, next) => {
    try {
      const ctx = await studentContext(req);
      const iid = ctx.iid;
      const [{ attempts }, [results, exams, parents]] = await Promise.all([store.sweepExpiredForStudent(iid, ctx.identity), Promise.all(['results', 'exams', 'examinations'].map(k => db.get(`institutes/${iid}/${k}`)))]);
      const own = Object.entries(attempts || {}).map(([id, a]) => ({ ...a, id })).filter(a => ownsRecord(ctx.identity, a)).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const publishedResults = Object.entries(results || {}).map(([id, x]) => ({ ...x, id })).filter(x => ownsRecord(ctx.identity, x) && x.publicationStatus === 'published');
      const parentOf = examId => exams?.[examId]?.examinationId || null;
      const attemptItems = own.map(a => ({
        id: a.id, examId: a.examId, examinationId: a.examinationId || parentOf(a.examId), paperId: a.examId,
        examName: a.snapshot?.examName || 'Examination', examinationName: a.snapshot?.examinationName || parents?.[parentOf(a.examId)]?.name || a.snapshot?.examName || 'Examination',
        paperName: a.snapshot?.paperName || exams?.[a.examId]?.paperName || '', attemptNumber: a.attemptNumber || null,
        subjectId: a.snapshot?.subjectId || '', subjectName: a.snapshot?.subjectName || '', examGroupId: a.snapshot?.examGroupId || '', examGroupName: a.snapshot?.examGroupName || '',
        paperOrder: a.snapshot?.paperOrder || 1, paperCount: a.snapshot?.paperCount || 1, status: a.status, startedAt: a.startedAt, submittedAt: a.submittedAt, expiresAt: a.expiresAt,
      }));
      const resultItems = publishedResults.map(x => ({
        id: x.id, examId: x.examId, examinationId: x.examinationId || parentOf(x.examId), paperId: x.examId, examName: x.examName, examinationName: x.examinationName || parents?.[parentOf(x.examId)]?.name || x.examName,
        paperName: x.paperName || exams?.[x.examId]?.paperName || '', examGroupId: x.examGroupId || '', examGroupName: x.examGroupName || '', paperOrder: x.paperOrder || 1, paperCount: x.paperCount || 1,
        subjectId: x.subjectId || '', subjectName: x.subjectName || '', score: x.score, totalMarks: x.totalMarks, percentage: x.percentage, passStatus: x.passStatus, publishedAt: x.publishedAt,
      })).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      const groups = new Map();
      for (const a of attemptItems) {
        const gid = a.examinationId || a.examId;
        if (!groups.has(gid)) groups.set(gid, { examinationId: gid, name: a.examinationName, papers: new Map() });
        const g = groups.get(gid);
        if (!g.papers.has(a.paperId)) g.papers.set(a.paperId, { paperId: a.paperId, paperName: a.paperName || a.subjectName || a.examName, subjectName: a.subjectName, order: a.paperOrder, attempts: [], result: null });
        g.papers.get(a.paperId).attempts.push(a);
      }
      for (const x of resultItems) { const g = groups.get(x.examinationId || x.examId); const p = g?.papers.get(x.paperId); if (p && (!p.result || x.score > p.result.score)) p.result = x; }
      const examinations = [...groups.values()].map(g => {
        const papers = [...g.papers.values()].sort((a, b) => (a.order || 0) - (b.order || 0));
        const parent = parents?.[g.examinationId];
        let overall = null;
        if (parent) {
          const live = Object.entries(exams || {}).filter(([, p]) => p.examinationId === g.examinationId && p.status !== 'archived').map(([id, p]) => ({ ...p, id }));
          const map = new Map(); for (const x of resultItems) if (x.examinationId === g.examinationId) { if (!map.has(x.paperId)) map.set(x.paperId, []); map.get(x.paperId).push(x); }
          overall = computeOverallResult({ parent, papers: live, resultsByPaper: map });
          if (!map.size) overall = null;
        }
        return { examinationId: g.examinationId, name: g.name, papers, overall };
      });
      res.json({ attempts: attemptItems, results: resultItems, examinations });
    } catch (e) { if (e.status === 403) return res.status(403).json({ message: e.message }); next(e); }
  });

  r.use((e, _req, res, next) => {
    if (e?.status && e.status < 500) return res.status(e.status).json({ message: e.message, ...(e.details ? { details: e.details } : {}) });
    next(e);
  });
  return r;
}

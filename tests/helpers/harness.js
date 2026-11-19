import crypto from 'node:crypto';
import express from 'express';
import { createMemoryDb } from './memoryDb.js';

// Boots the REAL Jupiter routers (auth middleware, data.js, exams.js, examinations) against an in-memory database.
export async function boot(seed) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  process.env.FIREBASE_CLIENT_EMAIL = 'test@jupiter-test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey.replace(/\n/g, '\\n');
  process.env.FIREBASE_DATABASE_URL = 'https://jupiter-test-default-rtdb.firebaseio.com';
  process.env.FIREBASE_PROJECT_ID = 'jupiter-test';
  const fb = await import('../../config/firebase.js');
  const mem = createMemoryDb(seed);
  for (const k of ['get', 'set', 'update', 'remove', 'transaction', 'key']) fb.db[k] = mem[k].bind(mem);
  fb.authAdmin.verifyIdToken = async token => { if (!token.startsWith('uid:')) throw new Error('bad token'); return { uid: token.slice(4) }; };
  const [{ default: data }, { default: exams }, { default: examinations }] = await Promise.all([
    import('../../routes/data.js'), import('../../routes/exams.js'), import('../../routes/examinations.js'),
  ]);
  (await import('../../routes/examinations.js')).examStore.resetMigrationCache();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', examinations); app.use('/api', exams); app.use('/api', data);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ message: err.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (uid, method, path, body) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer uid:${uid}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  };
  return { mem, call, apiUrl: url, close: () => new Promise(r => server.close(r)) };
}

export function baseSeed() {
  const q = (n, subjectId, correct = 'A', marks = 5) => ({ name: `Question ${n}`, subjectId, questionType: 'mcq', optionA: 'Right', optionB: 'Wrong 1', optionC: 'Wrong 2', optionD: 'Wrong 3', correctOption: correct, marks, status: 'active' });
  const user = (role, instituteId, extra = {}) => ({ role, instituteId, status: 'active', name: role, ...extra });
  return {
    users: {
      owner1: user('institute_owner', 'i1'), teacher1: user('teacher', 'i1', { permissions: { examinations: { view: true, create: true, edit: true, publish: true, unpublish: true, delete: true, archive: true, review: true }, results: { view: true, publish: true, edit: true }, questionBanks: { view: true } }, academicScope: { subjects: ['s1', 's2'], courses: ['c1'] } }),
      teacher2: user('teacher', 'i1', { permissions: { examinations: { view: true } }, academicScope: { subjects: ['s3'] } }),
      stu1: user('student', 'i1', { admissionStatus: 'approved', studentRecordId: 'st1' }), stu2: user('student', 'i1', { admissionStatus: 'approved', studentRecordId: 'st2' }),
      stuPending: user('student', 'i1', { admissionStatus: 'pending', studentRecordId: 'st3' }),
      owner2: user('institute_owner', 'i2'), stuOther: user('student', 'i2', { admissionStatus: 'approved', studentRecordId: 'sx1' }),
    },
    institutes: {
      i1: {
        profile: { id: 'i1', name: 'Test Institute', status: 'active', ownerUid: 'owner1' },
        departments: { d1: { name: 'Science', status: 'active' } },
        courses: { c1: { name: 'BSc', departmentId: 'd1', status: 'active' }, c2: { name: 'BA', status: 'active' } },
        subjects: { s1: { name: 'Mathematics', courseId: 'c1', departmentId: 'd1', status: 'active' }, s2: { name: 'Physics', courseId: 'c1', departmentId: 'd1', status: 'active' }, s3: { name: 'History', courseId: 'c2', status: 'active' } },
        questionBanks: { q1: q(1, 's1'), q2: q(2, 's1', 'B'), q3: q(3, 's2'), q4: q(4, 's2') },
        students: {
          st1: { name: 'Student A', courseId: 'c1', departmentId: 'd1', status: 'active', linkedUid: 'stu1', admissionStatus: 'approved' },
          st2: { name: 'Student B', courseId: 'c1', departmentId: 'd1', status: 'active', linkedUid: 'stu2', admissionStatus: 'approved' },
          st3: { name: 'Student C', courseId: 'c1', status: 'active', linkedUid: 'stuPending' },
        },
      },
      i2: { profile: { id: 'i2', name: 'Other Institute', status: 'active', ownerUid: 'owner2' }, students: { sx1: { name: 'Other Student', status: 'active', linkedUid: 'stuOther', admissionStatus: 'approved' } } },
    },
  };
}

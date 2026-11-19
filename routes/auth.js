import { Router } from 'express';
import crypto from 'node:crypto';
import { authAdmin, db } from '../config/firebase.js';
import { sendOtp, verifyOtp, consumeTicket } from '../services/otp.js';
import { requireAuth, allow } from '../middleware/auth.js';
import { createPhoneAuthUser, ensurePhoneAuthNumber, rollbackPhoneAuthUser } from '../services/phoneAuth.js';
const r = Router();
const normalize = v => { const s = String(v || '').replace(/[\s()-]/g, ''); if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`; if (/^\+?[1-9]\d{9,14}$/.test(s)) return s.startsWith('+') ? s : `+${s}`; return null; };
const bad = (res, msg, status = 400) => res.status(status).json({ message: msg });
const randomCode = () => `JUP-${crypto.randomInt(100000, 999999)}`;
async function claimMobile(mobile, uid) { const result = await db.transaction(`mobileLookups/${mobile}`, current => current || uid); if (!result.committed || result.snapshot.val() !== uid) { const e = new Error('This mobile number already has an account. Please log in.'); e.status = 409; throw e; } }
async function claimInstituteCode(instituteId) { for (let i = 0; i < 12; i++) { const candidate = randomCode(), result = await db.transaction(`instituteLookups/${candidate}`, current => current || instituteId); if (result.committed && result.snapshot.val() === instituteId) return candidate; } throw Object.assign(new Error('Unable to generate an institute code. Try again.'), { status: 503 }); }
r.post('/otp/send', async (req, res, next) => {
    try {
        const mobile = normalize(req.body.mobile), purpose = req.body.purpose; if (!mobile) return bad(res, 'Enter a valid mobile number.'); if (!['admin-register', 'admin-login', 'student-register', 'student-login', 'teacher-register', 'teacher-login'].includes(purpose)) return bad(res, 'Invalid verification purpose.'); const uid = await db.get(`mobileLookups/${mobile}`); if (purpose.endsWith('register') && uid) return bad(res, 'This mobile number already has an account. Please log in.', 409); if (purpose.endsWith('login') && !uid) return bad(res, 'No account found. Please register first.', 404);
        if (purpose === 'teacher-register' && uid) return bad(res, 'This mobile number already has an account. Please log in.', 409);
        if (purpose === 'teacher-login' && !uid) return bad(res, 'No teacher account found. Please create an account first.', 404);
        res.json({ ok: true, ...await sendOtp(mobile, purpose) });
    } catch (e) { next(e); }
});
r.post('/otp/verify', async (req, res, next) => { try { const mobile = normalize(req.body.mobile); if (!mobile) return bad(res, 'Invalid mobile number.'); const ticket = await verifyOtp(mobile, req.body.purpose, req.body.otp); res.json({ ticket }); } catch (e) { next(e); } });
r.post('/register/admin', async (req, res, next) => {
    let claimedMobile = null, authHandle = null, claimedCode = null, createdInstituteId = null, createdUid = null; try {
        const mobile = await consumeTicket(req.body.ticket, 'admin-register');
        const name = String(req.body.name || '').trim(), instituteName = String(req.body.instituteName || '').trim(), type = String(req.body.instituteType || 'college'), address = String(req.body.instituteAddress || '').trim().slice(0, 240), phone = String(req.body.institutePhone || '').trim().slice(0, 30), email = String(req.body.instituteEmail || '').trim().slice(0, 120);
        if (name.length < 2 || instituteName.length < 2) return bad(res, 'Name and institute name are required.');
        authHandle = await createPhoneAuthUser(mobile, name); const uid = authHandle.uid; createdUid = uid;
        await claimMobile(mobile, uid); claimedMobile = mobile;
        const instituteId = db.key(); createdInstituteId = instituteId;
        const instituteCode = await claimInstituteCode(instituteId); claimedCode = instituteCode;
        const now = Date.now(), user = { uid, role: 'institute_owner', instituteId, mobile, name, status: 'active', createdAt: now };
        const institute = { id: instituteId, name: instituteName, type, address, phone, email, code: instituteCode, ownerUid: uid, status: 'active', createdAt: now };
        await db.update({ [`users/${uid}`]: user, [`institutes/${instituteId}/profile`]: institute, [`institutes/${instituteId}/administrators/${uid}`]: { uid, name, role: 'owner', createdAt: now }, [`institutes/${instituteId}/settings`]: { allowStudentRegistration: true } });
        res.status(201).json({ customToken: await authAdmin.createCustomToken(uid, { role: user.role, instituteId }), redirect: '/admin' });
    } catch (e) { if (claimedMobile) await db.remove(`mobileLookups/${claimedMobile}`).catch(() => { }); if (claimedCode) await db.remove(`instituteLookups/${claimedCode}`).catch(() => { }); if (createdInstituteId) await db.remove(`institutes/${createdInstituteId}`).catch(() => { }); if (createdUid) await db.remove(`users/${createdUid}`).catch(() => { }); await rollbackPhoneAuthUser(authHandle); next(e); }
});
r.post('/teacher/invite', requireAuth, allow('institute_owner', 'institute_admin'), async (req, res, next) => { try { const mobile = normalize(req.body.mobile), iid = req.user.instituteId; if (!iid || !mobile) return bad(res, 'Enter a valid teacher mobile number.'); const uid = await db.get(`mobileLookups/${mobile}`), teacher = uid ? await db.get(`users/${uid}`) : null; if (!teacher || teacher.role !== 'teacher') return bad(res, 'Teacher must create their own Jupiter account first. You can only invite an existing teacher account.', 404); if (teacher.instituteId) return bad(res, 'This teacher is already connected to an institute.', 409); const previous = await db.get(`teacherInviteByUid/${uid}/${iid}`); if (previous) { const oldInvite = await db.get(`institutes/${iid}/teacherInvites/${previous.inviteId}`); if (oldInvite?.status === 'pending') return bad(res, 'A pending invitation already exists for this teacher.', 409); } const inviteId = db.key(), now = Date.now(), invite = { id: inviteId, uid, name: teacher.name, mobile, status: 'pending', createdAt: now, createdBy: req.user.uid }; await db.update({ [`institutes/${iid}/teacherInvites/${inviteId}`]: invite, [`teacherInviteByUid/${uid}/${iid}`]: { instituteId: iid, inviteId } }); res.status(201).json({ invite, message: 'Invitation sent to the existing teacher account.' }); } catch (e) { next(e); } });
r.post('/register/teacher', async (req, res, next) => { let claimedMobile = null, authHandle = null, createdUid = null; try { const mobile = await consumeTicket(req.body.ticket, 'teacher-register'), name = String(req.body.name || '').trim(); if (name.length < 2) return bad(res, 'Enter your full name.'); authHandle = await createPhoneAuthUser(mobile, name); const uid = authHandle.uid, now = Date.now(); createdUid = uid; await claimMobile(mobile, uid); claimedMobile = mobile; const user = { uid, role: 'teacher', instituteId: null, mobile, name, status: 'active', joinStatus: 'not_joined', permissions: {}, createdAt: now }; await db.set(`users/${uid}`, user); res.status(201).json({ customToken: await authAdmin.createCustomToken(uid, { role: 'teacher' }), redirect: '/teacher' }); } catch (e) { if (claimedMobile) await db.remove(`mobileLookups/${claimedMobile}`).catch(() => { }); if (createdUid) await db.remove(`users/${createdUid}`).catch(() => { }); await rollbackPhoneAuthUser(authHandle); next(e); } });
r.post('/register/student', async (req, res, next) => {
    let claimedMobile = null, authHandle = null, createdUid = null; try {
        const mobile = await consumeTicket(req.body.ticket, 'student-register'), name = String(req.body.name || '').trim(), studentId = String(req.body.studentId || '').trim().toUpperCase();
        if (name.length < 2) return bad(res, 'Enter your full name.');
        let lookup = null, record = null; if (studentId) { lookup = await db.get(`studentIdLookups/${studentId}`); if (!lookup) return bad(res, 'Student ID not found. Ask your institute to confirm the ID.', 404); record = await db.get(`institutes/${lookup.instituteId}/students/${lookup.recordId}`); const linkedInstitute = await db.get(`institutes/${lookup.instituteId}/profile`); if (!linkedInstitute || linkedInstitute.status !== 'active') return bad(res, 'The institute linked to this Student ID is unavailable.', 403); if (!record || record.status === 'archived' || record.linkedUid) return bad(res, 'This Student ID is unavailable or already linked to an account.', 409); if (!record.mobile) return bad(res, 'Your institute has not added a verified mobile number to this Student ID yet. Ask the institute to update your student record first.', 403); if (normalize(record.mobile) !== mobile) return bad(res, 'The mobile number does not match the institute student record. Contact your institute.', 403); }
        authHandle = await createPhoneAuthUser(mobile, name); const uid = authHandle.uid, now = Date.now(); createdUid = uid; await claimMobile(mobile, uid); claimedMobile = mobile;
        let profile = { uid, role: 'student', instituteId: null, mobile, name, status: 'active', admissionStatus: 'not_admitted', createdAt: now };
        if (studentId) { profile = { ...profile, ...{ name: record.name || name, instituteId: lookup.instituteId, admissionStatus: 'approved', studentRecordId: lookup.recordId } }; await db.update({ [`institutes/${lookup.instituteId}/students/${lookup.recordId}/uid`]: uid, [`institutes/${lookup.instituteId}/students/${lookup.recordId}/linkedUid`]: uid, [`institutes/${lookup.instituteId}/students/${lookup.recordId}/mobile`]: mobile, [`institutes/${lookup.instituteId}/students/${lookup.recordId}/admissionStatus`]: 'approved', [`institutes/${lookup.instituteId}/students/${lookup.recordId}/accountLinkedAt`]: now, [`users/${uid}`]: profile }); } else { await db.set(`users/${uid}`, profile); }
        res.status(201).json({ customToken: await authAdmin.createCustomToken(uid, { role: 'student' }), redirect: '/student' });
    } catch (e) { if (claimedMobile) await db.remove(`mobileLookups/${claimedMobile}`).catch(() => { }); if (createdUid) await db.remove(`users/${createdUid}`).catch(() => { }); await rollbackPhoneAuthUser(authHandle); next(e); }
});
r.post('/login', async (req, res, next) => {
    try {
        const mobile = await consumeTicket(req.body.ticket, req.body.purpose), uid = await db.get(`mobileLookups/${mobile}`), profile = uid ? await db.get(`users/${uid}`) : null;
        if (!profile || profile.status !== 'active') return bad(res, 'Account not found or inactive.', 404);
        if (!['student-login', 'teacher-login', 'admin-login'].includes(req.body.purpose)) return bad(res, 'Invalid login purpose.', 400);
        if ((req.body.purpose === 'student-login' && profile.role !== 'student') || (req.body.purpose === 'teacher-login' && profile.role !== 'teacher') || (req.body.purpose === 'admin-login' && !['institute_owner', 'institute_admin', 'teacher', 'super_admin'].includes(profile.role))) return bad(res, 'Choose the correct account type for this mobile number.', 403);
        if (profile.instituteId) { const institute = await db.get(`institutes/${profile.instituteId}/profile`); if (!institute || institute.status !== 'active') return bad(res, 'This institute workspace is currently unavailable.', 403); }
        await ensurePhoneAuthNumber(uid, mobile);
        res.json({ customToken: await authAdmin.createCustomToken(uid, { role: profile.role, instituteId: profile.instituteId || null }), redirect: ['institute_owner', 'institute_admin'].includes(profile.role) ? '/admin' : profile.role === 'teacher' ? '/teacher' : profile.role === 'super_admin' ? '/super-admin' : '/student' });
    } catch (e) { next(e); }
});
r.patch('/profile', requireAuth, async (req, res, next) => {
    try {
        const name = String(req.body.name || req.user.name || '').trim(), photoURL = req.body.photoURL === undefined ? req.user.photoURL : String(req.body.photoURL || '').trim();
        if (name.length < 2 || name.length > 80) return bad(res, 'Name must be between 2 and 80 characters.');
        if (photoURL && !/^https:\/\//i.test(photoURL)) return bad(res, 'Profile image URL must be HTTPS.');
        const now = Date.now();
        const updates = { [`users/${req.user.uid}/name`]: name, [`users/${req.user.uid}/photoURL`]: photoURL || null, [`users/${req.user.uid}/updatedAt`]: now };
        if (req.user.role === 'student' && req.user.instituteId) updates[`institutes/${req.user.instituteId}/students/${req.user.studentRecordId || req.user.uid}/name`] = name;
        await db.update(updates);
        await authAdmin.updateUser(req.user.uid, { displayName: name, ...(photoURL ? { photoURL } : {}) });
        res.json({ profile: { ...req.user, name, photoURL: photoURL || null, updatedAt: now } });
    } catch (e) { next(e); }
});
r.get('/me', requireAuth, async (req, res) => res.json({ profile: req.user }));
export default r;

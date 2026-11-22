import { Router } from 'express';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
export function createSchedulingAttendanceRouter({ db, requireAuth, isInstituteOwner }) {
const r = Router();
r.use(requireAuth);
const now = () => Date.now();
const localDate = () => { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const base = req => `institutes/${req.user.instituteId}`;
const fail = (status, message) => Object.assign(new Error(message), { status });
const values = value => Object.entries(value || {}).map(([id, item]) => ({ id, ...item }));
const studentMatches = (student, schedule) => ['academicYearId','departmentId','courseId','semesterId','classId','sectionId','batchId'].every(k => !schedule[k] || String(student?.[k] || '') === String(schedule[k]));
const canManageSchedule = (user, schedule) => isInstituteOwner(user) || (user.role === 'teacher' && schedule.teacherUid === user.uid);
const audit = (req, action, recordId, extra={}) => ({ actorUid:req.user.uid, action, recordId, at:now(), ...extra });

r.get('/schedules', async (req,res,next)=>{try{
 const iid=req.user.instituteId;if(!iid)return res.status(403).json({message:'Institute membership required.'});
 const all=values(await db.get(`${base(req)}/schedules`)).filter(x=>x.status!=='archived');
 let items=all;
 if(req.user.role==='teacher') items=all.filter(x=>x.teacherUid===req.user.uid);
 else if(req.user.role==='student'){
   if(req.user.admissionStatus!=='approved')return res.status(403).json({message:'Approved student admission required.'});
   const student=await db.get(`${base(req)}/students/${req.user.studentRecordId||req.user.uid}`);
   items=all.filter(x=>studentMatches(student,x)&&x.status==='active');
 } else if(!isInstituteOwner(req.user)) return res.status(403).json({message:'Not authorized.'});
 res.json({items:items.sort((a,b)=>(a.dayOfWeek||0)-(b.dayOfWeek||0)||String(a.startTime).localeCompare(String(b.startTime)))});
}catch(e){next(e)}});
r.post('/schedules', async(req,res,next)=>{try{
 if(!isInstituteOwner(req.user))return res.status(403).json({message:'Only institute owners can create schedules.'});
 const b=req.body||{}, required=['name','subjectId','teacherUid','dayOfWeek','startTime','endTime'];
 if(required.some(k=>b[k]===undefined||String(b[k]).trim()===''))return res.status(400).json({message:'Complete the schedule name, subject, teacher, day and time.'});
 if(!/^\d{2}:\d{2}$/.test(b.startTime)||!/^\d{2}:\d{2}$/.test(b.endTime)||b.startTime>=b.endTime)return res.status(400).json({message:'Enter a valid time range.'});
 const day=Number(b.dayOfWeek);if(!Number.isInteger(day)||day<0||day>6)return res.status(400).json({message:'Choose a valid day.'});
 const iid=req.user.instituteId, [teacher,subject,existing]=await Promise.all([
  db.get(`users/${b.teacherUid}`),db.get(`${base(req)}/subjects/${b.subjectId}`),db.get(`${base(req)}/schedules`)
 ]);
 if(!teacher||teacher.role!=='teacher'||teacher.instituteId!==iid||teacher.status!=='active')return res.status(400).json({message:'Select an active teacher in this institute.'});
 if(!subject)return res.status(400).json({message:'Select a valid subject.'});
 const candidate={...Object.fromEntries(['academicYearId','departmentId','courseId','semesterId','classId','sectionId','batchId'].map(k=>[k,b[k]||''])),dayOfWeek:day,startTime:b.startTime,endTime:b.endTime,teacherUid:b.teacherUid,room:String(b.room||'').trim()};
 const overlaps=(a,c)=>a.dayOfWeek===c.dayOfWeek&&a.startTime<c.endTime&&c.startTime<a.endTime;
 for(const [id,s] of Object.entries(existing||{})){
  if(s.status!=='active')continue;
  if(overlaps(s,candidate)){
   if(s.teacherUid===candidate.teacherUid)return res.status(409).json({message:'This teacher already has an overlapping class.'});
   if(candidate.room&&s.room===candidate.room)return res.status(409).json({message:'This room is already booked for that time.'});
   const sameGroup=['classId','sectionId','batchId'].some(k=>candidate[k]&&String(candidate[k])===String(s[k]||''))&&['classId','sectionId','batchId'].every(k=>!candidate[k]||!s[k]||String(candidate[k])===String(s[k]));
   if(sameGroup)return res.status(409).json({message:'This class/batch already has an overlapping schedule.'});
  }
 }
 const id=db.key(),item={id,name:String(b.name).trim().slice(0,120),...candidate,subjectId:b.subjectId,subjectName:subject.name||'',teacherName:teacher.name||'',room:candidate.room,academicYearId:b.academicYearId||'',departmentId:b.departmentId||'',courseId:b.courseId||'',semesterId:b.semesterId||'',classId:b.classId||'',sectionId:b.sectionId||'',batchId:b.batchId||'',startDate:b.startDate||'',endDate:b.endDate||'',status:'active',createdBy:req.user.uid,createdAt:now(),updatedAt:now()};
 await db.update({[`${base(req)}/schedules/${id}`]:item,[`${base(req)}/auditLogs/${db.key()}`]:audit(req,'schedules.created',id)});
 res.status(201).json({schedule:item});
}catch(e){next(e)}});
r.patch('/schedules/:id',async(req,res,next)=>{try{
 const iid=req.user.instituteId,id=req.params.id,path=`${base(req)}/schedules/${id}`,old=await db.get(path);
 if(!old)return res.status(404).json({message:'Schedule not found.'});
 if(!isInstituteOwner(req.user))return res.status(403).json({message:'Only institute owners can edit schedules.'});
 const b=req.body||{},nextItem={...old};
 for(const k of ['name','subjectId','teacherUid','dayOfWeek','startTime','endTime','room','academicYearId','departmentId','courseId','semesterId','classId','sectionId','batchId','startDate','endDate','status'])if(b[k]!==undefined)nextItem[k]=b[k];
 if(!/^\d{2}:\d{2}$/.test(nextItem.startTime)||!/^\d{2}:\d{2}$/.test(nextItem.endTime)||nextItem.startTime>=nextItem.endTime)return res.status(400).json({message:'Invalid schedule time range.'});
 if(nextItem.status==='active'){
  const all=values(await db.get(`${base(req)}/schedules`)).filter(x=>x.id!==id&&x.status==='active');
  for(const s of all)if(s.dayOfWeek===Number(nextItem.dayOfWeek)&&s.startTime<nextItem.endTime&&nextItem.startTime<s.endTime){
   if(s.teacherUid===nextItem.teacherUid||(nextItem.room&&s.room===nextItem.room)||(['classId','sectionId','batchId'].some(k=>nextItem[k]&&nextItem[k]===s[k])))return res.status(409).json({message:'The updated schedule conflicts with another class, teacher or room.'});
  }
 }
 nextItem.updatedAt=now();await db.update({[path]:nextItem,[`${base(req)}/auditLogs/${db.key()}`]:audit(req,'schedules.updated',id)});
 res.json({schedule:nextItem});
}catch(e){next(e)}});
r.delete('/schedules/:id',async(req,res,next)=>{try{
 if(!isInstituteOwner(req.user))return res.status(403).json({message:'Only institute owners can delete schedules.'});
 const path=`${base(req)}/schedules/${req.params.id}`,old=await db.get(path);if(!old)return res.status(404).json({message:'Schedule not found.'});
 await db.update({[`${path}/status`]:'archived',[`${path}/updatedAt`]:now(),[`${base(req)}/auditLogs/${db.key()}`]:audit(req,'schedules.archived',req.params.id)});res.json({archived:true});
}catch(e){next(e)}});

r.get('/attendance/settings',async(req,res,next)=>{try{res.json({settings:await db.get(`${base(req)}/attendanceSettings`)||{lateGraceMinutes:10,minimumPercentage:75,allowCorrections:false,qrEnabled:true,manualEnabled:true,smartEnabled:true}})}catch(e){next(e)}});
r.patch('/attendance/settings',async(req,res,next)=>{try{
 if(!isInstituteOwner(req.user))return res.status(403).json({message:'Owner access required.'});
 const old=await db.get(`${base(req)}/attendanceSettings`)||{},b=req.body||{},settings={...old};
 for(const k of ['lateGraceMinutes','minimumPercentage','allowCorrections','qrEnabled','manualEnabled','smartEnabled'])if(b[k]!==undefined)settings[k]=b[k];
 settings.updatedAt=now();settings.updatedBy=req.user.uid;await db.set(`${base(req)}/attendanceSettings`,settings);res.json({settings});
}catch(e){next(e)}});

async function rosterFor(iid,schedule){const all=await db.get(`institutes/${iid}/students`)||{};return Object.entries(all).filter(([,s])=>s&&s.status!=='archived'&&s.status!=='inactive'&&studentMatches(s,schedule)).map(([id,s])=>({recordId:id,uid:s.linkedUid||s.uid||id,name:s.name||'Student',studentId:s.studentId||'',photoURL:s.photoURL||s.profileImage||''}));}
r.post('/attendance/sessions',async(req,res,next)=>{try{
 const iid=req.user.instituteId,id=req.body.scheduleId,schedule=await db.get(`${base(req)}/schedules/${id}`);
 if(!schedule||schedule.status!=='active')return res.status(404).json({message:'Active schedule not found.'});
 if(!canManageSchedule(req.user,schedule))return res.status(403).json({message:'You are not assigned to this schedule.'});
 const mode=['smart','manual','qr'].includes(req.body.mode)?req.body.mode:'smart';
 const settings=await db.get(`${base(req)}/attendanceSettings`)||{};
 if(settings[`${mode}Enabled`]===false)return res.status(403).json({message:`${mode} attendance is disabled by the institute.`});
 const date=String(req.body.date||localDate());
 const sessionId=`${id}_${date.replace(/-/g,'')}`;
 const path=`${base(req)}/attendanceSessions/${sessionId}`;
 const old=await db.get(path);if(old&&old.status!=='cancelled')return res.status(409).json({message:'An attendance session already exists for this schedule and date.',session:old});
 const roster=await rosterFor(iid,schedule),session={id:sessionId,scheduleId:id,scheduleName:schedule.name,subjectId:schedule.subjectId,subjectName:schedule.subjectName,teacherUid:schedule.teacherUid,teacherName:schedule.teacherName,dayOfWeek:schedule.dayOfWeek,classId:schedule.classId||'',sectionId:schedule.sectionId||'',batchId:schedule.batchId||'',date,mode,status:'active',rosterCount:roster.length,roster,createdBy:req.user.uid,startedAt:now(),createdAt:now(),updatedAt:now()};
 await db.set(path,session);res.status(201).json({session,items:roster.map(s=>({...s,status:'unmarked'}))});
}catch(e){next(e)}});
r.get('/attendance/my-sessions',async(req,res,next)=>{try{
 const all=await db.get(`${base(req)}/attendanceSessions`)||{};
 const items=Object.entries(all).filter(([,s])=>isInstituteOwner(req.user)||s.teacherUid===req.user.uid).map(([id,s])=>({id,...s})).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
 res.json({items});
}catch(e){next(e)}});
r.get('/attendance/sessions/:id',async(req,res,next)=>{try{
 const iid=req.user.instituteId,session=await db.get(`${base(req)}/attendanceSessions/${req.params.id}`);if(!session)return res.status(404).json({message:'Attendance session not found.'});
 const schedule=await db.get(`${base(req)}/schedules/${session.scheduleId}`);
 if(!isInstituteOwner(req.user)&&!(req.user.role==='teacher'&&session.teacherUid===req.user.uid)&&req.user.role!=='student')return res.status(403).json({message:'Not authorized.'});
 if(req.user.role==='student')return res.status(403).json({message:'Students cannot view teacher session records.'});
 const records=await db.get(`${base(req)}/attendanceRecords/${session.id}`)||{};
 res.json({session,items:session.roster.map(s=>({...s,...records[s.recordId],status:records[s.recordId]?.status||'unmarked'}))});
}catch(e){next(e)}});
r.post('/attendance/sessions/:id/mark',async(req,res,next)=>{try{
 const iid=req.user.instituteId,session=await db.get(`${base(req)}/attendanceSessions/${req.params.id}`);if(!session||session.status!=='active')return res.status(404).json({message:'Active attendance session not found.'});
 if(!isInstituteOwner(req.user)&&!(req.user.role==='teacher'&&session.teacherUid===req.user.uid))return res.status(403).json({message:'Not authorized to mark this class.'});
 const entries=Array.isArray(req.body.items)?req.body.items:[req.body],allowed=['present','absent','late','excused'],updates={};
 for(const item of entries){const student=session.roster.find(s=>s.recordId===String(item.recordId));if(!student)continue;const status=String(item.status||'').toLowerCase();if(!allowed.includes(status))continue;
  const key=student.recordId,existing=await db.get(`${base(req)}/attendanceRecords/${session.id}/${key}`);
  if(existing&&existing.status!=='unmarked'&&item.force!==true)continue;
  updates[`${base(req)}/attendanceRecords/${session.id}/${key}`]={recordId:key,studentUid:student.uid,studentId:student.studentId,studentName:student.name,status,remarks:String(item.remarks||'').slice(0,300),markedBy:req.user.uid,markedAt:now(),method:session.mode};
 }
 if(!Object.keys(updates).length)return res.status(400).json({message:'No valid attendance changes were supplied.'});
 await db.update(updates);res.json({saved:Object.keys(updates).length});
}catch(e){next(e)}});
r.post('/attendance/sessions/:id/scan',async(req,res,next)=>{try{
 const session=await db.get(`${base(req)}/attendanceSessions/${req.params.id}`);if(!session||session.status!=='active')return res.status(404).json({message:'Active attendance session not found.'});
 if(!isInstituteOwner(req.user)&&!(req.user.role==='teacher'&&session.teacherUid===req.user.uid))return res.status(403).json({message:'Not authorized to scan attendance.'});
 const raw=String(req.body.token||'').trim();const token=raw.startsWith('JUPITER:')?raw.slice(8):raw;if(!token)return res.status(400).json({message:'QR token is required.'});
 let mapping=await db.get(`${base(req)}/studentQrMappings/${token}`);if(!mapping){const all=await db.get(`${base(req)}/studentQrMappings`)||{};mapping=Object.values(all).find(x=>x?.status==='active'&&String(x.studentId||'').toLowerCase()===token.toLowerCase())||null;}if(!mapping||mapping.status!=='active')return res.status(404).json({message:'Invalid or inactive student QR.'});
 const student=session.roster.find(s=>s.recordId===mapping.recordId);if(!student)return res.status(403).json({message:'This student is not enrolled in the selected class/batch.'});
 const recordPath=`${base(req)}/attendanceRecords/${session.id}/${student.recordId}`,old=await db.get(recordPath);
 if(old&&old.status!=='unmarked')return res.status(409).json({message:'Attendance already recorded for this student.',student:{name:student.name,studentId:student.studentId}});
 const record={recordId:student.recordId,studentUid:student.uid,studentId:student.studentId,studentName:student.name,status:'present',method:'qr',markedBy:req.user.uid,markedAt:now()};
 await db.set(recordPath,record);res.json({record,student});
}catch(e){next(e)}});
r.post('/attendance/sessions/:id/finalize',async(req,res,next)=>{try{
 const sessionPath=`${base(req)}/attendanceSessions/${req.params.id}`,session=await db.get(sessionPath);if(!session||session.status!=='active')return res.status(404).json({message:'Active session not found.'});
 if(!isInstituteOwner(req.user)&&!(req.user.role==='teacher'&&session.teacherUid===req.user.uid))return res.status(403).json({message:'Not authorized.'});
 const records=await db.get(`${base(req)}/attendanceRecords/${session.id}`)||{},settings=await db.get(`${base(req)}/attendanceSettings`)||{};
 const updates={};for(const student of session.roster){if(!records[student.recordId])updates[`${base(req)}/attendanceRecords/${session.id}/${student.recordId}`]={recordId:student.recordId,studentUid:student.uid,studentId:student.studentId,studentName:student.name,status:'absent',method:session.mode,markedBy:req.user.uid,markedAt:now()};}
 updates[`${sessionPath}/status`]='completed';updates[`${sessionPath}/finalizedAt`]=now();updates[`${sessionPath}/finalizedBy`]=req.user.uid;updates[`${base(req)}/auditLogs/${db.key()}`]=audit(req,'attendance.finalized',session.id,{mode:session.mode});
 await db.update(updates);res.json({completed:true,absent:session.roster.filter(s=>!records[s.recordId]).length});
}catch(e){next(e)}});
r.get('/attendance/my',async(req,res,next)=>{try{
 if(req.user.role!=='student'||req.user.admissionStatus!=='approved')return res.status(403).json({message:'Approved student account required.'});
 const iid=req.user.instituteId,recordId=req.user.studentRecordId||req.user.uid,[sessions,allRecords,student]=await Promise.all([db.get(`${base(req)}/attendanceSessions`),db.get(`${base(req)}/attendanceRecords`),db.get(`${base(req)}/students/${recordId}`)]);
 const items=[];for(const [sid,session] of Object.entries(sessions||{})){const rec=allRecords?.[sid]?.[recordId];if(rec)items.push({sessionId:sid,date:session.date,subjectName:session.subjectName,scheduleName:session.scheduleName,...rec});}
 const total=items.length,present=items.filter(x=>['present','late'].includes(x.status)).length;
 const qrToken=await ensureQr(iid,recordId,student);
 res.json({items:items.sort((a,b)=>String(b.date).localeCompare(String(a.date))),summary:{total,present,absent:items.filter(x=>x.status==='absent').length,late:items.filter(x=>x.status==='late').length,excused:items.filter(x=>x.status==='excused').length,percentage:total?Math.round(present/total*1000)/10:0},qrToken,student:{id:recordId,name:student?.name||req.user.name,studentId:student?.studentId||''}});
}catch(e){next(e)}});
async function ensureQr(iid,recordId,student){let token=student?.attendanceQrToken;if(!token)token=crypto.randomBytes(24).toString('base64url');const mapping=await db.get(`institutes/${iid}/studentQrMappings/${token}`);if(!mapping)await db.update({[`institutes/${iid}/students/${recordId}/attendanceQrToken`]:token,[`institutes/${iid}/studentQrMappings/${token}`]:{recordId,studentId:student?.studentId||'',status:'active',createdAt:now()}});return token;}
r.get('/student/qr',async(req,res,next)=>{try{
 if(req.user.role!=='student'||req.user.admissionStatus!=='approved')return res.status(403).json({message:'Approved student account required.'});
 const iid=req.user.instituteId,id=req.user.studentRecordId||req.user.uid,student=await db.get(`${base(req)}/students/${id}`);if(!student)return res.status(404).json({message:'Student record not found.'});
 const token=await ensureQr(iid,id,student),dataUrl=await QRCode.toDataURL(`JUPITER:${token}`,{width:320,margin:2,errorCorrectionLevel:'H'});
 res.json({token,dataUrl,student:{name:student.name,studentId:student.studentId||'',photoURL:student.photoURL||student.profileImage||''},institute:await db.get(`${base(req)}/profile`)});
}catch(e){next(e)}});
r.get('/attendance',async(req,res,next)=>{try{
 if(!isInstituteOwner(req.user))return res.status(403).json({message:'Owner access required.'});
 const [sessions,records]=await Promise.all([db.get(`${base(req)}/attendanceSessions`),db.get(`${base(req)}/attendanceRecords`)]);
 const items=Object.entries(sessions||{}).map(([id,s])=>{const rs=records?.[id]||{},counts={present:0,absent:0,late:0,excused:0};Object.values(rs).forEach(x=>{if(counts[x.status]!==undefined)counts[x.status]++});return{id,...s,counts}});
 res.json({items:items.sort((a,b)=>String(b.date).localeCompare(String(a.date)))});
}catch(e){next(e)}});
return r;
}


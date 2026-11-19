// Backend-authoritative granular RBAC for Jupiter.
export const OWNER_ONLY_MODULES = new Set(['teachers','teacherInvites','teacherJoinRequests','staff','admissions','departments','semesters','settings']);
const aliases = { exams:'examinations', questionBanks: 'questionBanks', examAttempts: 'examinations', results: 'results', marksheets: 'results', assignmentSubmissions: 'assignments', academicYears: 'academicYears' };
export const moduleForCollection = c => aliases[c] || c;
const LEGACY_ACTION = { view: 'read', create: 'write', edit: 'write', manage: 'write', publish: 'write', unpublish: 'write', export: 'read', assign: 'write', archive: 'write', review: 'write', search: 'read', filter: 'read' };
export function can(user,module,action='view'){
  if(['institute_owner','institute_admin','super_admin'].includes(user?.role)) return true;
  if(user?.role!=='teacher') return false;
  if(module==='departments') return action==='view' && (user.permissions?.departments?.viewAssigned===true || user.permissions?.departments?.read===true);
  if(module==='semesters') return action==='view' && (user.permissions?.semesters?.view===true || user.permissions?.semesters?.read===true);
  if(OWNER_ONLY_MODULES.has(module)) return false;
  const p=user.permissions?.[module] || (module==='examinations'?user.permissions?.exams:null) || {};
  if(p[action]===true) return true;
  const legacy=LEGACY_ACTION[action];
  if(legacy && p[legacy]===true) return true;
  if(action==='view' && (p.create===true||p.edit===true||p.manage===true||p.write===true)) return true;
  return false;
}
export function assignedIds(user,kind){
  const s=user?.academicScope||{};
  const raw=s[kind] ?? s[`${kind}Ids`] ?? [];
  return Array.isArray(raw)?raw.map(String):Object.keys(raw||{}).filter(k=>raw[k]===true);
}
export function inTeacherScope(user,record,collection){
  if(user?.role!=='teacher') return true;
  if(collection==='academicYears') return true;
  const id=String(record?.id||'');
  if(collection==='departments') return assignedIds(user,'departments').includes(id);
  if(collection==='semesters') return assignedIds(user,'courses').includes(String(record?.courseId||''));
  const scope=user.academicScope||{};
  const checks=[['departmentId','departments'],['courseId','courses'],['subjectId','subjects'],['classId','classes'],['sectionId','sections'],['batchId','batches']];
  let hasScope=false,matched=false;
  if(collection==='courses'&&id&&assignedIds(user,'courses').length){hasScope=true;if(!assignedIds(user,'courses').includes(id))return false;matched=true;}
  if(collection==='subjects'&&id&&assignedIds(user,'subjects').length){hasScope=true;if(!assignedIds(user,'subjects').includes(id))return false;matched=true;}
  if(collection==='sections'&&id&&assignedIds(user,'sections').length){hasScope=true;if(!assignedIds(user,'sections').includes(id))return false;matched=true;}
  if(collection==='classes'&&id&&assignedIds(user,'classes').length){hasScope=true;if(!assignedIds(user,'classes').includes(id))return false;matched=true;}
  if(collection==='batches'&&id&&assignedIds(user,'batches').length){hasScope=true;if(!assignedIds(user,'batches').includes(id))return false;matched=true;}
  for(const [field,key] of checks){
    const ids=assignedIds(user,key);
    if(ids.length){hasScope=true;if(record?.[field]){if(!ids.includes(String(record[field])))return false;matched=true;}}
  }
  // Department scope also constrains records whose department is inherited via course/subject.
  if(!hasScope) return false;
  return matched;
}
export function assertScope(user,record,collection){
  if(inTeacherScope(user,record,collection)) return true;
  const e=new Error('This record is outside your assigned academic scope.');e.status=403;throw e;
}
export function normalizeTeacherPermissions(input={}){
 const modules=['dashboard','students','teachers','staff','academicYears','departments','courses','semesters','subjects','classes','sections','batches','questionBanks','examinations','results','assignments','auditLogs','instituteSettings'];
 const actions=['view','viewAssigned','create','edit','delete','approve','reject','publish','unpublish','export','assign','manage','archive','review','search','filter'];
 const out={};
 for(const m of modules){const v=input[m]||{};out[m]={};for(const a of actions)out[m][a]=v[a]===true;
   if(v.read===true)out[m].view=true;
   if(v.write===true){out[m].create=true;out[m].edit=true;out[m].manage=true;}
 }
 // Never allow Owner-only capabilities to be delegated.
 for(const m of ['teachers','staff','instituteSettings'])out[m]=Object.fromEntries(actions.map(a=>[a,false]));
 out.departments=Object.fromEntries(actions.map(a=>[a,false]));out.departments.viewAssigned=input.departments?.viewAssigned===true||input.departments?.read===true;
 out.semesters=Object.fromEntries(actions.map(a=>[a,false]));out.semesters.view=input.semesters?.view===true||input.semesters?.read===true;
 out.students.approve=false;out.students.reject=false;out.students.delete=false;
 out.admissions=Object.fromEntries(actions.map(a=>[a,false]));
 out.auditLogs.edit=false;out.auditLogs.delete=false;
 return out;
}

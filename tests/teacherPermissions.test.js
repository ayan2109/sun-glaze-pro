import test from 'node:test';
import assert from 'node:assert/strict';
import { can, inTeacherScope, normalizeTeacherPermissions } from '../services/teacherPermissions.js';

test('owners retain institute-wide access',()=>{
 const owner={role:'institute_owner'};
 assert.equal(can(owner,'teachers','delete'),true);
 assert.equal(can(owner,'admissions','approve'),true);
 assert.equal(can(owner,'auditLogs','export'),true);
});
test('teacher owner-only restrictions cannot be delegated',()=>{
 const teacher={role:'teacher',permissions:normalizeTeacherPermissions({teachers:{view:true},staff:{manage:true},departments:{create:true},semesters:{edit:true},students:{delete:true,approve:true}})};
 assert.equal(can(teacher,'teachers','view'),false);
 assert.equal(can(teacher,'staff','manage'),false);
 assert.equal(can(teacher,'departments','create'),false);
 assert.equal(can(teacher,'semesters','edit'),false);
 assert.equal(can(teacher,'students','delete'),false);
 assert.equal(can(teacher,'students','approve'),false);
});
test('teacher granular permissions and legacy read/write remain supported',()=>{
 const teacher={role:'teacher',permissions:{courses:{view:true,create:true},questionBanks:{read:true,write:true}}};
 assert.equal(can(teacher,'courses','create'),true);
 assert.equal(can(teacher,'courses','delete'),false);
 assert.equal(can(teacher,'questionBanks','view'),true);
 assert.equal(can(teacher,'questionBanks','edit'),true);
});
test('teacher scope allows only assigned academic resources',()=>{
 const teacher={role:'teacher',academicScope:{departments:['d1'],courses:['c1'],subjects:['s1'],classes:['cl1'],batches:['b1']}};
 assert.equal(inTeacherScope(teacher,{id:'d1'},'departments'),true);
 assert.equal(inTeacherScope(teacher,{id:'d2'},'departments'),false);
 assert.equal(inTeacherScope(teacher,{departmentId:'d1',courseId:'c1'},'courses'),true);
 assert.equal(inTeacherScope(teacher,{departmentId:'d2',courseId:'c2'},'courses'),false);
 assert.equal(inTeacherScope(teacher,{departmentId:'d1',courseId:'c1',batchId:'b2'},'students'),false);
 assert.equal(inTeacherScope(teacher,{courseId:'c1'},'academicYears'),true);
});
test('missing teacher scope denies academic resource access',()=>{
 const teacher={role:'teacher',academicScope:{}};
 assert.equal(inTeacherScope(teacher,{courseId:'c1'},'courses'),false);
});
test('students cannot use teacher module permissions',()=>{
 const student={role:'student',permissions:{courses:{view:true,create:true}}};
 assert.equal(can(student,'courses','view'),false);
});

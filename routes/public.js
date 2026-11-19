import{Router}from'express';import{db}from'../config/firebase.js';import{env}from'../config/env.js';import QRCode from'qrcode';const r=Router();
r.get('/institutes/lookup/:code',async(req,res,next)=>{try{const code=String(req.params.code||'').trim().toUpperCase(),iid=await db.get(`instituteLookups/${code}`);if(!iid)return res.status(404).json({message:'Institute code not found.'});const p=await db.get(`institutes/${iid}/profile`);if(!p||p.status!=='active')return res.status(404).json({message:'Institute is unavailable.'});const qrDataUrl=await QRCode.toDataURL(`${env.clientOrigin.split(',')[0].replace(/\/$/,'')}/?institute=${encodeURIComponent(code)}`,{width:280,margin:1});res.json({institute:{id:p.id,name:p.name,type:p.type,code:p.code,address:p.address||'',phone:p.phone||'',email:p.email||'',website:p.website||'',description:p.description||'',logoURL:p.logoURL||'',status:p.status},qrDataUrl});}catch(e){next(e);}});
r.post('/results/lookup',async(req,res,next)=>{try{
 const code=String(req.body.code||'').trim().toUpperCase(),roll=String(req.body.rollNumber||'').trim(),registration=String(req.body.registrationNumber||'').trim();
 if(!code||!roll||!registration||code.length>32||roll.length>64||registration.length>64)return res.status(400).json({message:'All fields are required.'});
 const iid=await db.get(`instituteLookups/${code}`);if(!iid)return res.status(404).json({message:'Result not found.'});
 const institute=await db.get(`institutes/${iid}/profile`);if(!institute||institute.status!=='active')return res.status(404).json({message:'Result not found.'});
 const students=await db.get(`institutes/${iid}/students`)||{};
 const matches=Object.entries(students).filter(([,student])=>String(student.rollNumber||'').trim().toLowerCase()===roll.toLowerCase()&&String(student.registrationNumber||'').trim().toLowerCase()===registration.toLowerCase());
 if(matches.length!==1)return res.status(404).json({message:'Result not found.'});
 const [studentRecordId,student]=matches;
 const allResults=await db.get(`institutes/${iid}/results`)||{};
 const found=Object.entries(allResults).filter(([,x])=>((Boolean(student.linkedUid)&&x.studentUid===student.linkedUid)||(Boolean(x.studentRecordId)&&x.studentRecordId===studentRecordId))&&x.publicationStatus==='published').sort((a,b)=>(b[1].publishedAt||0)-(a[1].publishedAt||0)).map(([id,x])=>({id,examName:x.examName,subjectName:x.subjectName||'',score:x.score,totalMarks:x.totalMarks,percentage:x.percentage,status:Number(x.score)>=Number(x.passingMarks||0)?'Pass':'Fail',publishedAt:x.publishedAt||null,marksheetNo:`JUP-${String(id).replace(/[^a-zA-Z0-9]/g,'').slice(-10).toUpperCase()}`}));
 if(!found.length)return res.status(404).json({message:'Result not found.'});
 res.json({student:{name:student.name||'Student',rollNumber:student.rollNumber,registrationNumber:student.registrationNumber},institute:{name:institute.name||'Institute'},results:found,result:found[0]});
 }catch(e){next(e);}});
export default r;

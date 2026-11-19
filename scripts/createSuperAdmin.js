import 'dotenv/config';
import {db} from '../config/firebase.js';
import {createPhoneAuthUser,rollbackPhoneAuthUser} from '../services/phoneAuth.js';

const raw=String(process.env.SUPER_ADMIN_MOBILE||'').replace(/[\s()-]/g,'');
const mobile=/^[6-9]\d{9}$/.test(raw)?`+91${raw}`:raw.startsWith('+')?raw:`+${raw}`;
const name=String(process.env.SUPER_ADMIN_NAME||'Jupiter Super Admin').trim();
if(!/^\+[1-9]\d{9,14}$/.test(mobile))throw new Error('Set a valid SUPER_ADMIN_MOBILE in the server environment.');
const existing=await db.get(`mobileLookups/${mobile}`);
if(existing){const user=await db.get(`users/${existing}`);if(user?.role==='super_admin'){console.info(`Super Admin already exists: ${existing}`);process.exit(0);}throw new Error('This mobile number is already linked to another account.');}
let handle=null;
try{
 handle=await createPhoneAuthUser(mobile,name);
 const uid=handle.uid;
 await db.update({[`users/${uid}`]:{uid,role:'super_admin',mobile,name,status:'active',createdAt:Date.now()},[`mobileLookups/${mobile}`]:uid});
 console.info(`Super Admin created. UID: ${uid}`);
}catch(error){await rollbackPhoneAuthUser(handle);throw error;}

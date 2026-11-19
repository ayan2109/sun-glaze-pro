import{env}from'../config/env.js';
/** Provider boundary: add an approved SMS vendor adapter here without changing OTP logic. */
export async function deliverOtp({mobile,purpose,otp,ttlMinutes}){
 const provider=process.env.SMS_PROVIDER||(env.nodeEnv==='development'?'console':'');
 if(provider==='console'&&env.nodeEnv==='development'){console.info(`[JUPITER DEV OTP] ${mobile} (${purpose}) — ${otp} (expires in ${ttlMinutes}m)`);return{delivered:false,channel:'terminal'};}
 // Production provider integrations must be implemented and configured explicitly.
 throw Object.assign(new Error('SMS delivery is not configured. No SMS was sent.'),{status:503});
}

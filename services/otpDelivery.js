import{env}from'../config/env.js';
/** Provider boundary: add an approved SMS vendor adapter here without changing OTP logic. */
/**
 * TEMPORARY dev/testing switch. When OTP_DEBUG_DISPLAY=true the generated OTP is returned to the
 * frontend (field `devOtp`) so it can be shown on screen. In production it additionally requires
 * ALLOW_OTP_DISPLAY_IN_PRODUCTION=true, so it can never be exposed by accident.
 */
export function otpDisplayEnabled(){
 if(String(process.env.OTP_DEBUG_DISPLAY||'').toLowerCase()!=='true')return false;
 if(env.nodeEnv==='production')return String(process.env.ALLOW_OTP_DISPLAY_IN_PRODUCTION||'').toLowerCase()==='true';
 return true;
}
export async function deliverOtp({mobile,purpose,otp,ttlMinutes}){
 if(otpDisplayEnabled()){console.info(`[JUPITER DEV OTP] ${mobile} (${purpose}) — ${otp} (shown on screen; expires in ${ttlMinutes}m)`);return{delivered:false,channel:'on-screen'};}
 const provider=process.env.SMS_PROVIDER||(env.nodeEnv==='development'?'console':'');
 if(provider==='console'&&env.nodeEnv==='development'){console.info(`[JUPITER DEV OTP] ${mobile} (${purpose}) — ${otp} (expires in ${ttlMinutes}m)`);return{delivered:false,channel:'terminal'};}
 // Production provider integrations must be implemented and configured explicitly.
 throw Object.assign(new Error('SMS delivery is not configured. No SMS was sent.'),{status:503});
}

import { authAdmin, db } from '../config/firebase.js';

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * Create a Firebase Authentication user whose phoneNumber is the OTP-verified
 * E.164 number. If Firebase already has that phone (for example, an account
 * created in another app using the same Firebase project), reuse its UID only
 * when Jupiter has no conflicting local account record for that UID.
 */
export async function createPhoneAuthUser(mobile, displayName) {
  try {
    const user = await authAdmin.createUser({ phoneNumber: mobile, displayName });
    return { uid: user.uid, created: true };
  } catch (error) {
    if (error?.code !== 'auth/phone-number-already-exists') {
      throw httpError(502, 'Could not create the Firebase phone-auth account. Please try again.', 'AUTH_CREATE_FAILED');
    }

    let existing;
    try {
      existing = await authAdmin.getUserByPhoneNumber(mobile);
    } catch {
      throw httpError(502, 'The phone-auth account could not be recovered. Please try again.', 'AUTH_LOOKUP_FAILED');
    }

    if (existing.disabled) throw httpError(403, 'This Firebase phone account is disabled. Contact support.', 'AUTH_ACCOUNT_DISABLED');
    const localProfile = await db.get(`users/${existing.uid}`);
    if (localProfile) {
      // Never overwrite an existing Jupiter identity during a registration retry.
      throw httpError(409, 'A Jupiter account record already exists for this Firebase phone account. Please log in instead.', 'JUPITER_ACCOUNT_EXISTS');
    }
    return { uid: existing.uid, created: false };
  }
}

/** Best-effort migration for Jupiter accounts created before phoneNumber was stored in Firebase Auth. */
export async function ensurePhoneAuthNumber(uid, mobile) {
  const user = await authAdmin.getUser(uid);
  if (user.disabled) throw httpError(403, 'This Firebase account is disabled. Contact support.', 'AUTH_ACCOUNT_DISABLED');
  if (user.phoneNumber === mobile) return { linked: true };
  if (user.phoneNumber && user.phoneNumber !== mobile) {
    throw httpError(409, 'This Firebase account is linked to a different mobile number. Contact support.', 'PHONE_NUMBER_MISMATCH');
  }
  try {
    await authAdmin.updateUser(uid, { phoneNumber: mobile });
    return { linked: true };
  } catch (error) {
    // The same verified phone may already be attached to a legacy account from
    // another product in the shared Firebase project. Keep the Jupiter UID
    // authoritative; OTP verification + the Jupiter mobile lookup still secure login.
    if (error?.code === 'auth/phone-number-already-exists') {
      console.warn(`[Jupiter Auth] ${mobile} is already attached to another Firebase UID; preserving the existing Jupiter UID ${uid}.`);
      return { linked: false, reason: 'phone-number-already-exists' };
    }
    throw httpError(502, 'Could not update the Firebase phone-auth profile. Please try again.', 'AUTH_PHONE_UPDATE_FAILED');
  }
}

export async function rollbackPhoneAuthUser(handle) {
  if (handle?.created && handle.uid) {
    await authAdmin.deleteUser(handle.uid).catch(() => {});
  }
}

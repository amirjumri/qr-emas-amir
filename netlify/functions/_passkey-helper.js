const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require("@simplewebauthn/server");

const {
  json,
  normalizePhone,
  buildPhoneCandidates,
  getSupabaseAdmin
} = require("./_auth-chat-helper");

function getRpId() {
  return (
    process.env.PASSKEY_RP_ID ||
    process.env.URL_HOSTNAME ||
    process.env.SITE_HOSTNAME ||
    "emasamir.app"
  ).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function getRpName() {
  return process.env.PASSKEY_RP_NAME || "Emas Amir";
}

function getOrigin() {
  return (
    process.env.PASSKEY_ORIGIN ||
    process.env.URL ||
    "https://emasamir.app"
  ).replace(/\/$/, "");
}

function challengeTtlMs() {
  return Number(process.env.PASSKEY_CHALLENGE_TTL_MS || 5 * 60 * 1000);
}

function bufferToBase64url(input) {
  return Buffer.from(input).toString("base64url");
}

function base64urlToBuffer(input) {
  return Buffer.from(String(input || ""), "base64url");
}

async function findCustomerByPhone(phone) {
  const supabase = getSupabaseAdmin();
  const phones = buildPhoneCandidates(normalizePhone(phone));

  const { data, error } = await supabase
    .from("customers")
    .select("id,name,phone,ic,alamat,email")
    .in("phone", phones)
    .limit(10);

  if (error) throw error;

  const rows = data || [];
  if (!rows.length) return null;

  const normalized = normalizePhone(phone);
  const exact = rows.find(r => normalizePhone(r.phone) === normalized);
  return exact || rows[0];
}

async function getActivePasskeysByPhone(phone) {
  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);

  const { data, error } = await supabase
    .from("customer_passkeys")
    .select("*")
    .eq("phone", normalized)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getPasskeyByCredentialId(credentialId) {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("customer_passkeys")
    .select("*")
    .eq("credential_id", credentialId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markAllChallengesUsed(phone, purpose) {
  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);

  const { error } = await supabase
    .from("passkey_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("phone", normalized)
    .eq("purpose", purpose)
    .is("used_at", null);

  if (error) throw error;
}

async function createChallengeRecord({ phone, purpose, challenge, credentialId = null, meta = {} }) {
  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);
  const now = new Date();
  const expires = new Date(now.getTime() + challengeTtlMs()).toISOString();

  await markAllChallengesUsed(normalized, purpose);

  const { data, error } = await supabase
    .from("passkey_challenges")
    .insert({
      phone: normalized,
      purpose,
      challenge,
      credential_id: credentialId || null,
      expires_at: expires,
      meta: meta || {}
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getLatestValidChallenge({ phone, purpose }) {
  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("passkey_challenges")
    .select("*")
    .eq("phone", normalized)
    .eq("purpose", purpose)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function consumeChallenge(id) {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("passkey_challenges")
    .update({ used_at: new Date().toISOString() })
    .eq("id", id)
    .is("used_at", null);

  if (error) throw error;
}

async function buildRegistrationOptionsForPhone(phone) {
  const customer = await findCustomerByPhone(phone);
  if (!customer) {
    throw new Error("Customer tidak dijumpai.");
  }

  const passkeys = await getActivePasskeysByPhone(phone);
  const userIdText = normalizePhone(customer.phone || phone);
const userIdBytes = Uint8Array.from(Buffer.from(userIdText, "utf8"));

const options = await generateRegistrationOptions({
  rpName: getRpName(),
  rpID: getRpId(),
  userID: userIdBytes,
  userName: `${userIdText}@emasamir.app`,
  userDisplayName: customer.name || `${userIdText}@emasamir.app`,
  timeout: 60000,
  attestationType: "none",
  authenticatorSelection: {
    residentKey: "preferred",
    userVerification: "required"
  },
  excludeCredentials: passkeys.map(pk => ({
    id: pk.credential_id,
    type: "public-key",
    transports: Array.isArray(pk.transports) ? pk.transports : []
  }))
});

  const challengeRow = await createChallengeRecord({
    phone,
    purpose: "register",
    challenge: options.challenge,
    meta: { customer_id: customer.id || null }
  });

  return {
    options,
    challengeRow,
    customer
  };
}

async function finishRegistrationForPhone({ phone, credential }) {
  const customer = await findCustomerByPhone(phone);
  if (!customer) {
    throw new Error("Customer tidak dijumpai.");
  }

  const challengeRow = await getLatestValidChallenge({
    phone,
    purpose: "register"
  });

  if (!challengeRow) {
    throw new Error("Challenge daftar Face ID tiada atau tamat tempoh.");
  }

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: getOrigin(),
    expectedRPID: getRpId(),
    requireUserVerification: true
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Pengesahan Face ID gagal.");
  }

 const info = verification.registrationInfo;
const credentialID = String(info.credential.id);
const publicKey = bufferToBase64url(info.credential.publicKey);
const counter = Number(info.credential.counter || 0);
  const transports = Array.isArray(credential?.response?.transports)
    ? credential.response.transports
    : [];

  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);

  const { error } = await supabase
    .from("customer_passkeys")
    .upsert({
      phone: normalized,
      credential_id: credentialID,
      credential_public_key: publicKey,
      counter,
      transports,
      backed_up: info.credentialDeviceType === "multiDevice",
      device_name: "Face ID / Passkey",
      revoked_at: null,
      last_used_at: null,
      meta: {
        customer_id: customer.id || null,
        credential_device_type: info.credentialDeviceType || null
      }
    }, { onConflict: "credential_id" });

  if (error) throw error;

  await consumeChallenge(challengeRow.id);

  return {
    ok: true,
    customer,
    credential_id: credentialID
  };
}

async function buildAuthenticationOptionsForPhone(phone) {
  const customer = await findCustomerByPhone(phone);
  if (!customer) {
    throw new Error("Customer tidak dijumpai.");
  }

  const passkeys = await getActivePasskeysByPhone(phone);
  if (!passkeys.length) {
    throw new Error("Face ID belum diaktifkan pada device ini.");
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    timeout: 60000,
    userVerification: "required",
    allowCredentials: passkeys.map(pk => ({
      id: pk.credential_id,
      type: "public-key",
      transports: Array.isArray(pk.transports) ? pk.transports : []
    }))
  });

  const challengeRow = await createChallengeRecord({
    phone,
    purpose: "authenticate",
    challenge: options.challenge,
    meta: { customer_id: customer.id || null }
  });

  return {
    options,
    challengeRow,
    customer
  };
}

async function finishAuthenticationForPhone({ phone, credential }) {
  const customer = await findCustomerByPhone(phone);
  if (!customer) {
    throw new Error("Customer tidak dijumpai.");
  }

  const challengeRow = await getLatestValidChallenge({
    phone,
    purpose: "authenticate"
  });

  if (!challengeRow) {
    throw new Error("Challenge login Face ID tiada atau tamat tempoh.");
  }

  const dbPasskey = await getPasskeyByCredentialId(credential.id);
  if (!dbPasskey) {
    throw new Error("Credential Face ID tidak dijumpai.");
  }

  const verification = await verifyAuthenticationResponse({
    response: credential,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: getOrigin(),
    expectedRPID: getRpId(),
    requireUserVerification: true,
    credential: {
      id: dbPasskey.credential_id,
      publicKey: base64urlToBuffer(dbPasskey.credential_public_key),
      counter: Number(dbPasskey.counter || 0),
      transports: Array.isArray(dbPasskey.transports) ? dbPasskey.transports : []
    }
  });

  if (!verification.verified) {
    throw new Error("Login Face ID gagal disahkan.");
  }

  const newCounter = Number(verification.authenticationInfo?.newCounter || dbPasskey.counter || 0);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("customer_passkeys")
    .update({
      counter: newCounter,
      last_used_at: new Date().toISOString()
    })
    .eq("id", dbPasskey.id);

  if (error) throw error;

  await consumeChallenge(challengeRow.id);

  return {
    ok: true,
    customer,
    credential_id: dbPasskey.credential_id
  };
}

async function passkeyStatus(phone) {
  const passkeys = await getActivePasskeysByPhone(phone);
  return {
    registered: passkeys.length > 0,
    count: passkeys.length
  };
}

async function revokePasskeysForPhone(phone) {
  const supabase = getSupabaseAdmin();
  const normalized = normalizePhone(phone);

  const { error } = await supabase
    .from("customer_passkeys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("phone", normalized)
    .is("revoked_at", null);

  if (error) throw error;

  return true;
}

module.exports = {
  json,
  normalizePhone,
  getRpId,
  getRpName,
  getOrigin,
  findCustomerByPhone,
  buildRegistrationOptionsForPhone,
  finishRegistrationForPhone,
  buildAuthenticationOptionsForPhone,
  finishAuthenticationForPhone,
  passkeyStatus,
  revokePasskeysForPhone
};
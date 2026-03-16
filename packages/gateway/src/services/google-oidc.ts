/**
 * Google OIDC ID token verification via JWKS.
 *
 * Uses `jose` to verify Google's id_token signature, issuer, audience,
 * expiry, and nonce. Does NOT call the userinfo endpoint.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { GOOGLE_APP_CLIENT_ID } from "../config.js";

const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

export interface GoogleIdTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
}

/**
 * Verify a Google-issued id_token and return decoded claims.
 * Throws on invalid signature, expired token, wrong audience/issuer, or nonce mismatch.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
): Promise<GoogleIdTokenClaims> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: GOOGLE_ISSUERS,
    audience: GOOGLE_APP_CLIENT_ID,
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error("Google id_token nonce mismatch");
  }

  return {
    sub: payload.sub as string,
    email: payload.email as string,
    email_verified: payload.email_verified as boolean,
    name: payload.name as string | undefined,
    picture: payload.picture as string | undefined,
    nonce: payload.nonce as string | undefined,
  };
}

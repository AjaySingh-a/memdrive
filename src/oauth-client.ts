// Google OAuth "Desktop app" client used by memdrive.
//
// For installed apps Google does not treat the client secret as confidential
// (https://developers.google.com/identity/protocols/oauth2/native-app), so it is
// fine to ship it in source. See docs/google-oauth-setup.md for how to create one.
//
// Users can bring their own client instead:
//   memdrive connect --client-id <id> --client-secret <secret>
// or set MEMDRIVE_CLIENT_ID / MEMDRIVE_CLIENT_SECRET.
export const BUILTIN_CLIENT_ID = "";
export const BUILTIN_CLIENT_SECRET = "";

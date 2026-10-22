# Setting up the Google OAuth client (for the maintainer)

memdrive signs users in to Google Drive with an OAuth client that belongs to this
project. You create it once; every user then just clicks "Allow" in their browser.

memdrive only asks for the `drive.file` scope: it can see and change **only the files
it created itself**. Google classes this as a non-sensitive scope, so the app does
not need Google's security assessment.

## 1. Create the project

1. Go to <https://console.cloud.google.com/> and create a project named `memdrive`.
2. **APIs & Services → Library**: enable the **Google Drive API**.

## 2. Configure the consent screen

1. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform").
2. User type: **External**.
3. App name `memdrive`, your support email, and a developer contact email.
4. **Data access / Scopes**: add `https://www.googleapis.com/auth/drive.file`.
5. While the app is in **Testing**, only the test users you add can sign in, and their
   sign-in expires after 7 days. To open it to everyone, click **Publish app**.
   With only `drive.file`, Google may ask you to verify the app's branding (homepage,
   privacy policy link); there is no security review.

## 3. Create the client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**, name `memdrive`.
3. Copy the client ID and client secret into `src/oauth-client.ts`:

   ```ts
   export const BUILTIN_CLIENT_ID = "1234-abc.apps.googleusercontent.com";
   export const BUILTIN_CLIENT_SECRET = "GOCSPX-...";
   ```

For a Desktop app client, Google states the secret is not confidential, so committing
it is normal (rclone, gcloud and others do the same). Sign-in is still protected by
PKCE and the user's own consent.

## Quota

The Drive API is free. The default quota is far above what hourly backups use
(each backup is about 5 API calls). Each user's calls are limited separately.

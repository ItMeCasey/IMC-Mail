# OAuth setup (Google and Microsoft)

IMC-Mail signs in through your system browser (authorization code + PKCE) and never sees your
password. Each provider needs an OAuth client ID that you register once. Client IDs are read at
startup from either:

1. Environment variables: `IMC_GOOGLE_CLIENT_ID`, `IMC_GOOGLE_CLIENT_SECRET`, `IMC_MICROSOFT_CLIENT_ID`
2. `oauth.json` in the app data folder (`%APPDATA%\@imc\desktop\oauth.json` on Windows):

```json
{
  "gmail": { "clientId": "123-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-..." },
  "microsoft": { "clientId": "00000000-0000-0000-0000-000000000000" }
}
```

3. Google only: the client JSON downloaded from Google Cloud, saved as `.google-oauth.json` in the
   repo root (dev) or the app data folder. It is git-ignored.

Precedence: environment variables, then `oauth.json`, then `.google-oauth.json`. Restart the app after changing any of them. Without a client ID the
matching "Sign in with ..." button stays disabled.

## Google

1. Google Cloud Console: create a project, then **APIs & Services > OAuth consent screen**
   (External). Add the scope `https://mail.google.com/` and add yourself as a test user.
2. **Credentials > Create credentials > OAuth client ID > Desktop app.**
3. Copy the client ID and client secret. For desktop apps Google requires the secret on the
   token call but does not treat it as confidential.

Limits to know about:

- While the consent screen is in **Testing**, refresh tokens expire after **7 days** and you are
  limited to 100 test users. IMC-Mail then shows "Sign-in expired" and you add the account again.
- `https://mail.google.com/` is a *restricted* scope. Publishing for other people requires
  Google's app verification and a security assessment. Fine for personal use.

## Microsoft (Outlook.com, Microsoft 365)

1. Microsoft Entra admin center > **App registrations > New registration.**
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts.**
3. Redirect URI: platform **Mobile and desktop applications** (public client), value
   `http://localhost`. The port is ignored for localhost, so no port is needed.
4. **API permissions > Add > Microsoft Graph or "APIs my organization uses" > Office 365 Exchange Online >
   Delegated:** `IMAP.AccessAsUser.All`, `SMTP.Send`; and Graph delegated `offline_access`,
   `openid`, `email`, `profile`.
5. Copy the **Application (client) ID**. No secret is needed.

Some organizations disable IMAP OAuth or require admin consent; those accounts will not sign in
until an admin allows it.

## Showing your calendar (optional)

IMC-Mail can show an account's own calendar next to the meetings that arrive by email. It only
reads: it never creates, moves or deletes anything in your calendar. In **Settings > Calendars**,
press **Allow calendar** on the account; your browser opens and asks you to allow it. New accounts
are asked at sign-in.

**Google:** in the same Google Cloud project, once only:

1. **APIs & Services > Library**, search for **Google Calendar API**, press **Enable**. Without
   this the calendar fails with "The Google Calendar API is turned off for your Google Cloud project".
2. **OAuth consent screen > Data access (Scopes) > Add or remove scopes**, add
   `.../auth/calendar.readonly`. While the app is in Testing mode, your own account (listed under
   Test users) can use it as is.

**Microsoft:** in the app registration, **API permissions > Add a permission > Microsoft Graph >
Delegated permissions > `Calendars.Read`**. Personal Outlook.com and Hotmail accounts do not need
admin consent. Work or school accounts may.

Only the account's main calendar is read, from two weeks back to four months ahead, every ten
minutes and whenever you press **Update now**.

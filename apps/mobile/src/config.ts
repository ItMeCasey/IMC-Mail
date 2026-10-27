// Public identifiers for signing in. A client ID names this app to Google or Microsoft; it is not a secret.

/** Google Cloud project "WindowsAssistant", OAuth client of type Android (package com.itmecasey.imcmail). */
export const GOOGLE_ANDROID_CLIENT_ID = '335303494773-ip7gkmri4ulce7iqi8a6j9qm0e6l75n5.apps.googleusercontent.com'

/** The same Azure app registration the desktop uses, with a mobile redirect added. */
export const MICROSOFT_CLIENT_ID = 'e256881f-27a9-4dd5-8f63-769c665b6556'

/** Where Google sends the person back to the app: the app's package name as the scheme, as Google requires for Android clients. */
export const GOOGLE_REDIRECT = 'com.itmecasey.imcmail:/oauth2redirect'

/** Where Microsoft sends the person back (registered under "Mobile and desktop applications"). */
export const MICROSOFT_REDIRECT = 'imcmail://auth'

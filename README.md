# FalconX — Local Development

This repository is a static web app with a lightweight optional server proxy for calling Gemini (or other) APIs securely from the server-side.

Setup

1. Copy the example env and add your key:

```bash
cp .env.example .env
# then edit .env and set GEMINI_API_KEY
```

2. Install server deps (only needed if you plan to run the server proxy):

```bash
npm install
```

3. Run the server locally:

```bash
npm run start
```

The server exposes a simple POST `/api/gemini` endpoint that forwards JSON to the configured API using the `GEMINI_API_KEY` environment variable. The endpoint is a placeholder — update the URL and request shape to match the target Gemini/OpenAI API you intend to use.

Notes

- Do not commit your `.env` file — `.gitignore` already ignores it.
- The frontend is self-contained in `index.html`. Make purely visual changes in CSS where possible to avoid breaking JS behavior.
- Google account sync stores likes, playlists, and library preferences in Firebase Firestore. Create the Firestore database for `falconx-f1016`, then authenticate with the Firebase CLI and deploy the checked-in rules from the repository root:

```bash
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules
```

The `.firebaserc` project alias and `firebase.json` rules mapping target the Firebase project used by `cloud-sync.js`. Firestore rules restrict each account to its own data.

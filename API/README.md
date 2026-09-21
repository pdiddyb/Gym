# API

PHP API endpoint:

- `POST /api/auth/google`
  - Request JSON: `{ "id_token": "...", "screen_name": "..." }`
  - Verifies Google ID token with Google tokeninfo endpoint.
  - Validates token `aud`, `iss`, and `exp`.
  - Upserts user record in `users` table using `email`, `first_name`, `last_name`, and `screen_name`.
  - Returns `201` + `operation: "created"` for new users, `200` + `operation: "updated"` for existing users.

Environment variables:

- `DB_HOST` (default `127.0.0.1`)
- `DB_PORT` (default `3306`)
- `DB_NAME` (default `gym`)
- `DB_USER` (default `root`)
- `DB_PASSWORD` (default empty)
- `GOOGLE_CLIENT_ID` (required; used to validate token `aud`)

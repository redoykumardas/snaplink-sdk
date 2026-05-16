# Security Policy

## Supported Versions

Security fixes are provided for the latest published major version.

## Sensitive Data

Never commit:

- `.env`
- `*-cookies.json`
- browser user-data directories
- screenshots containing private chats
- account credentials

The package `.gitignore` excludes common generated sensitive files.

## Reporting Issues

For private deployments, report issues to the package maintainer or internal repository owner. Include:

- SDK version
- Node.js version
- Operating system
- redacted stack trace
- whether the issue happens before or after login

Do not include credentials, cookies, or screenshots with private user data.

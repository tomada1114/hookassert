// Secret-shaped content: text that must never land in a tracked file.
//
// Read by the pre-commit staged-content check (`scripts/check-staged.mjs`),
// which scans a staged file's content before it can reach a commit.

/**
 * Secret shapes that must never be written into a tracked file.
 *
 * @remarks
 * Each pattern is written so that its own source text does not match it, which
 * is what lets this file be staged without the check refusing its own rules.
 *
 * The AWS secret access key entry is deliberately anchored to an
 * `aws_secret_access_key`-shaped assignment rather than matching a bare
 * 40-character base64 run: the unanchored shape alone matches dozens of
 * unrelated 40-character substrings inside this repository's own
 * `pnpm-lock.yaml` (base64 package integrity hashes happen to contain runs of
 * that length and character set), which would block an ordinary dependency
 * update. Anchoring to the assignment context is also what gitleaks' own
 * built-in AWS rule does, for the same reason. Both the AWS and password
 * entries accept a hyphen or underscore between words and either a colon or
 * an equals sign for the assignment, and match case-insensitively, since an
 * env-style name is conventionally upper snake case and YAML/JSON prefer a
 * colon over an equals sign.
 *
 * @type {{ pattern: RegExp, name: string }[]}
 */
export const CREDENTIAL_PATTERNS = [
  { pattern: /_authToken\s*=\s*\S/, name: "an npm registry auth token" },
  { pattern: /password\s*[:=]\s*\S/i, name: "a hardcoded password" },
  { pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, name: "a private key" },
  { pattern: /\bnpm_[A-Za-z0-9]{36,}\b/, name: "an npm access token" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, name: "a GitHub token" },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    name: "a GitHub fine-grained personal access token",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    name: "a JSON Web Token, such as a GitHub App installation token",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, name: "an AWS access key id" },
  {
    pattern: /\baws[-_]?secret[-_]?access[-_]?key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}\b/i,
    name: "an AWS secret access key",
  },
  // Real Anthropic keys (`sk-ant-api03-…-AA`) are hyphen-segmented, not a
  // single contiguous alphanumeric run, so the body must accept `-`/`_`.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, name: "an Anthropic API key" },
  {
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9]{20,}\b/,
    name: "an OpenAI API key",
  },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, name: "a Slack token" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, name: "a Google API key" },
  { pattern: /\b[spr]k_live_[A-Za-z0-9]{16,}\b/, name: "a Stripe live API key" },
];

/**
 * Return a block reason when text carries a credential.
 *
 * @param {string} text - Content about to be written, or a shell command.
 * @returns {string | null} The reason, or null when nothing matched.
 */
export function checkCredentials(text) {
  if (text === "") {
    return null;
  }
  for (const { pattern, name } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      return `This write looks like it embeds ${name}. Credentials belong in the environment or a secret store, never in a tracked file.`;
    }
  }
  return null;
}

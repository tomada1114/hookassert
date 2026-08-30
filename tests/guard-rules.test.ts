import { describe, expect, it } from "vitest";

import { checkCredentials } from "../scripts/lib/guard/credentials.mjs";
import { checkRead } from "../scripts/lib/guard/paths.mjs";

// Pure-function coverage for the secret-detection rules under
// scripts/lib/guard/, used by scripts/check-staged.mjs. Nothing here spawns a
// process — tests/check-staged.test.ts covers that caller's own contract
// (staged content, exit codes).
//
// Secret-shaped fixtures are assembled from fragments rather than written
// out. A literal token or key header in this file would be a real finding
// for every secret scanner pointed at the repository.
function secretShaped(...parts: string[]): string {
  return parts.join("");
}

describe("paths: checkRead", () => {
  it("blocks reading a dotenv file", () => {
    expect(checkRead(".env")).toMatch(/\.env\*/);
  });

  it("allows reading the env example", () => {
    expect(checkRead(".env.example")).toBeNull();
  });

  it("blocks a path under secrets/", () => {
    expect(checkRead("secrets/token.txt")).toMatch(/secrets\//);
  });
});

describe("credentials: checkCredentials", () => {
  const privateKey = secretShaped("-----BEGIN RSA ", "PRIVATE ", "KEY-----");

  it("blocks a private key", () => {
    expect(checkCredentials(`${privateKey}\nMIIE…\n`)).toMatch(/private key/);
  });

  it("does not flag ordinary prose", () => {
    expect(
      checkCredentials("Store the token in the environment, never in a file."),
    ).toBeNull();
  });

  it.each([
    [
      "a lowercase password assignment",
      secretShaped("password ", "= ", '"s3cr3t-value"'),
      /password/,
    ],
    [
      "an upper-snake-case env-style password assignment",
      secretShaped("PASSWORD", "=", "s3cr3t-value"),
      /password/,
    ],
    [
      "an underscore-prefixed password assignment",
      secretShaped("db_password", "=", "s3cr3t-value"),
      /password/,
    ],
    [
      "a colon-delimited password assignment",
      secretShaped("password", ": ", '"s3cr3t-value"'),
      /password/,
    ],
    [
      "a GitHub fine-grained personal access token",
      secretShaped("github_pat_", "11AAAAAAA0AAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"),
      /fine-grained/,
    ],
    [
      "a GitHub App installation JWT",
      secretShaped(
        "eyJhbGciOiJIUzI1NiJ9.",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
      /JSON Web Token/,
    ],
    [
      "an AWS secret access key assignment (underscore form)",
      secretShaped(
        "aws_secret_access_key = ",
        '"wJalrXUtnFEMI/K7MDENG',
        '/bPxRfiCYEXAMPLEKEY"',
      ),
      /AWS secret access key/,
    ],
    [
      "an AWS secret access key assignment (hyphenated form)",
      secretShaped(
        "aws-secret-access-key: ",
        '"wJalrXUtnFEMI/K7MDENG',
        '/bPxRfiCYEXAMPLEKEY"',
      ),
      /AWS secret access key/,
    ],
    ["an Anthropic API key", secretShaped("sk-ant-", "a".repeat(25)), /Anthropic/],
    [
      "a realistic hyphen-segmented Anthropic API key",
      secretShaped("sk-ant-api03-", "a".repeat(30), "-", "b".repeat(10), "-AA"),
      /Anthropic/,
    ],
    ["an OpenAI project API key", secretShaped("sk-proj-", "a".repeat(25)), /OpenAI/],
    ["a classic OpenAI API key", secretShaped("sk-", "a".repeat(25)), /OpenAI/],
    ["a Slack token", secretShaped("xoxb-", "1".repeat(15)), /Slack/],
    ["a Google API key", secretShaped("AIza", "a".repeat(35)), /Google/],
    ["a Stripe live API key", secretShaped("sk_live_", "a".repeat(20)), /Stripe/],
  ])("blocks %s", (_label, text, matcher) => {
    expect(checkCredentials(text)).toMatch(matcher);
  });

  it.each([
    [
      "prose that merely mentions a password",
      "Store the password in a secret manager, never in a file.",
    ],
    ["a plain github_pat-shaped word that is too short", "github_pat_expired"],
    ["a dotted string that is not JWT-shaped", "release.eyJust.a.version-like.string"],
    [
      "a bare 40-character string with no AWS context",
      secretShaped("wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYEXAMPLEKEY"),
    ],
    [
      "a lowercase-only 40-character hex string (e.g. a git SHA)",
      "447392e1a2b3c4d5e6f7890123456789abcdef01",
    ],
    ["a short sk-ant-shaped string", "sk-ant-expired"],
    ["a short sk- prefixed string", "sk-expired"],
    ["a short xoxb-shaped string", "xoxb-revoked"],
    ["a short AIza-prefixed string", "AIzaExpired"],
    ["a Stripe test key", secretShaped("sk_test_", "a".repeat(20))],
  ])("does not flag %s", (_label, text) => {
    expect(checkCredentials(text)).toBeNull();
  });
});
